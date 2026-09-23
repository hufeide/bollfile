/**
 * lan-discovery.ts — 局域网多播发现
 *
 *  解决"同一路由器下两台机器"用公共 DHT 连不通的问题(NAT 回环/hairpin 不支持):
 *   - 每个节点周期性向组播地址 239.255.42.42:49740 广播 {房间哈希, 自身公钥, 可达地址}
 *   - 收到同房间、非自身的广播后, 直接 swarm.connect(对方局域网IP:端口) 直连
 *   - 与公共 DHT 发现(joinRoom)互补: 局域网走这里, 公网走 DHT, 互不冲突
 */
import * as dgram from 'dgram';
import * as os from 'os';
import * as crypto from 'crypto';

const MCAST_ADDR = '239.255.42.42';
const MCAST_PORT = 49740;
const ANNOUNCE_MS = 2000;

/** 取第一个非内回环的 IPv4 地址, 供局域网内其他机器直连 */
export function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

export class LanDiscovery {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private roomHash = '';
  private selfPk = '';
  private addr: { host: string; port: number } = { host: '', port: 0 };

  constructor(private onPeer: (peer: { host: string; port: number; pk: string }) => void) {}

  start(roomCode: string, listenPort: number, selfPk: string): void {
    this.roomHash = crypto
      .createHash('sha256')
      .update('lan:' + roomCode)
      .digest('hex')
      .slice(0, 16);
    this.selfPk = selfPk;
    this.addr = { host: getLanIp(), port: listenPort };

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', () => {
      /* 多播在某些受限网络不可用, 静默降级(仍可用 DHT) */
    });
    socket.on('message', (msg) => this.handle(msg));
    socket.bind(MCAST_PORT, () => {
      try {
        socket.addMembership(MCAST_ADDR);
      } catch {
        /* ignore */
      }
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
    });

    this.announce();
    this.timer = setInterval(() => this.announce(), ANNOUNCE_MS);
  }

  private announce(): void {
    if (!this.socket) return;
    const payload = JSON.stringify({ r: this.roomHash, p: this.selfPk, a: this.addr });
    const buf = Buffer.from(payload, 'utf-8');
    this.socket.send(buf, 0, buf.length, MCAST_PORT, MCAST_ADDR, () => {
      /* ignore send errors */
    });
  }

  private handle(msg: Buffer): void {
    let m: any;
    try {
      m = JSON.parse(msg.toString('utf-8'));
    } catch {
      return;
    }
    if (m.r !== this.roomHash) return; // 不同房间
    if (m.p === this.selfPk) return; // 自己
    if (!m.a || !m.a.host || !m.a.port) return;
    if (m.a.host === this.addr.host && m.a.port === this.addr.port) return; // 同机同端口
    this.onPeer({ host: m.a.host, port: m.a.port, pk: m.p });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.socket) {
      try {
        this.socket.dropMembership(MCAST_ADDR);
      } catch {
        /* ignore */
      }
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.socket = undefined;
  }
}
