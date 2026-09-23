/**
 * transport.ts — HyperswarmTransport
 *
 * 复用 bolloon 的自动发现范式 (p2p-direct.ts / auto-peer-discovery.ts):
 *  - 加入同一 topic (由房间码 sha256 派生) → 公共 DHT 自动互连 → 'peer' 事件
 *  - conn 是全双工字节流，上叠长度前缀帧 (framing.ts) 解决粘包
 *  - sendToWithWait: 先 joinPeer 触发握手，等 conn 就绪再写，避免"消息进虚空"
 */
import Hyperswarm from 'hyperswarm';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as net from 'net';
import { encodeFrame, FrameDecoder } from './framing';
import { loadOrCreateKeys } from './keys';
import { startLocalBootstrap, LocalBootstrap } from './local-bootstrap';
import { LanDiscovery } from './lan-discovery';

/** 局域网直连固定 TCP 端口 (比 hyperswarm 随机 UDP 端口更不易被防火墙挡) */
const TCP_PORT = Number(process.env.BOLLFIlE_TCP_PORT) || 8090;

export type DataHandler = (payload: Buffer, fromPk: string) => void;

export class HyperswarmTransport extends EventEmitter {
  private swarm: any = null;
  private role: string;
  private bootstrap?: any;
  private useLocalBootstrap: boolean;
  private localBootstrap?: LocalBootstrap;
  private lan?: LanDiscovery;
  private lanTried = new Set<string>();
  private tcpServer?: net.Server;
  private tcpPort = TCP_PORT;
  private conns = new Map<string, any>();
  private dataHandlers: DataHandler[] = [];
  private myPk = '';
  private started = false;

  constructor(opts: { role?: string; bootstrap?: any; useLocalBootstrap?: boolean } = {}) {
    super();
    this.role = opts.role || process.env.BOLLOON_ROLE || 'default';
    this.bootstrap = opts.bootstrap;
    this.useLocalBootstrap = !!opts.useLocalBootstrap;
  }

  async start(): Promise<string> {
    if (this.started) return this.myPk;
    const keys = loadOrCreateKeys(this.role);
    const swarmOpts: any = { seed: Buffer.from(keys.swarmSeed, 'hex') };

    // 本地 DHT bootstrap: 优先用显式 bootstrap, 否则起一个本地离线节点
    if (this.bootstrap) {
      swarmOpts.bootstrap = this.bootstrap;
    } else if (process.env.BOLLFIlE_BOOTSTRAP) {
      // 可指定可达的 DHT bootstrap (公网默认节点不可达时, 指向自建/可达节点)
      swarmOpts.bootstrap = process.env.BOLLFIlE_BOOTSTRAP.split(',').map((s) => {
        const [host, port] = s.trim().split(':');
        return { host, port: Number(port) };
      });
    } else if (this.useLocalBootstrap) {
      this.localBootstrap = await startLocalBootstrap();
      swarmOpts.bootstrap = [this.localBootstrap.address];
    }

    this.swarm = new Hyperswarm(swarmOpts);
    this.myPk = Buffer.from(this.swarm.keyPair.publicKey).toString('hex');

    this.swarm.on('connection', (conn: any, info: any) => {
      const remote = Buffer.from(info.publicKey).toString('hex');
      if (remote === this.myPk) return; // 忽略自己
      this.registerConn(remote, conn);
    });

    await this.swarm.listen();

    // 局域网直连 TCP 服务: 固定端口(默认 8090), 比 hyperswarm 随机 UDP 端口更不易被防火墙挡。
    // 若固定端口被占用(同机多实例/测试), 退回临时端口, 真实端口会通过多播广播通告给对方。
    this.tcpServer = net.createServer((socket) => this.onTcpConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: any) => {
        if (e && e.code === 'EADDRINUSE' && this.tcpPort !== 0) {
          this.tcpPort = 0;
          this.tcpServer!.removeListener('error', onErr);
          this.tcpServer!.listen(0, '0.0.0.0', () => resolve());
        } else {
          reject(e);
        }
      };
      this.tcpServer!.on('error', onErr);
      this.tcpServer!.listen(this.tcpPort, '0.0.0.0', () => resolve());
    });
    this.tcpPort = (this.tcpServer!.address() as net.AddressInfo).port;
    console.log(`[bollfile] 局域网直连 TCP 端口已监听: ${this.tcpPort}`);

    this.started = true;
    this.emit('ready', this.myPk);
    return this.myPk;
  }

  private registerConn(pk: string, conn: any): void {
    if (this.conns.has(pk)) return; // 避免重复注册
    this.conns.set(pk, conn);
    const decoder = new FrameDecoder();

    conn.on('data', (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      for (const f of frames) {
        for (const h of this.dataHandlers) h(f, pk);
        this.emit('data', f, pk);
      }
    });
    conn.on('close', () => {
      this.conns.delete(pk);
      this.lanTried.delete(pk); // 允许掉线后重新发现并直连
      this.emit('peer-offline', pk);
    });
    conn.on('error', () => {
      /* 静默: 连接错误由 offline 事件反映 */
    });

    this.emit('peer', pk);
  }

  /** 加入房间: 房间码 → sha256 → 私密 topic，DHT 自动撮合(公网) */
  joinRoom(roomCode: string): void {
    if (!this.swarm) throw new Error('transport not started');
    const topic = crypto.createHash('sha256').update(roomCode).digest().subarray(0, 16);
    this.swarm.join(topic, { server: true, client: true });
  }

  /**
   * 局域网补充发现: 同网段机器通过多播拿到对方 LAN 地址后, 直接用固定 TCP 端口直连,
   * 绕过 NAT 回环 (hairpin) 与公共 DHT, 也避开 hyperswarm 随机 UDP 端口被防火墙挡的问题。
   * 与 joinRoom(DHT) 互补: 公网走 DHT、局域网走这里。
   */
  startLanDiscovery(roomCode: string): void {
    this.lan = new LanDiscovery((peer) => {
      this.dialTcpPeer(peer);
    });
    // 向局域网广播"我的 TCP 直连端口", 让对方来连 (固定端口更易被放行)
    this.lan.start(roomCode, this.tcpPort, this.myPk);
  }

  /** 通过固定 TCP 端口直连一个局域网 peer (发现层拿到 host/port 后调用) */
  private dialTcpPeer(peer: { host: string; port: number; pk: string }): void {
    const key = peer.pk;
    if (!key || key === this.myPk) return;
    if (this.lanTried.has(key) || this.conns.has(key)) return; // 已尝试/已连, 不重复
    this.lanTried.add(key);
    const socket = net.connect(Number(peer.port), peer.host, () => {
      // 连接建立后先发握手帧(携带本端 pk), 再注册(触发 presence)
      socket.write(encodeFrame(Buffer.from(JSON.stringify({ t: 'pk', pk: this.myPk }))));
      if (this.conns.has(key)) { socket.destroy(); return; } // 已被对方拨入抢先注册, 丢弃重复
      this.conns.set(key, socket);
      this.emit('peer', key);
    });
    socket.on('error', () => this.lanTried.delete(key));
    this.setupTcp(key, socket);
  }

  /** 收到入站 TCP 连接: 先读首帧拿到对方 pk, 再挂帧解码器 */
  private onTcpConnection(socket: net.Socket): void {
    this.setupTcp(null, socket);
  }

  /**
   * 统一处理一条 TCP 连接的帧: 首帧必为握手帧 {t:'pk',pk}, 之后才是协议帧。
   * pkKnown 非空表示本端是拨号方(已知对方 pk), 首帧是对方的握手帧须跳过;
   * pkKnown 为空表示本端是被拨方, 需从首帧解析出 pk。
   */
  private setupTcp(pkKnown: string | null, socket: net.Socket): void {
    const decoder = new FrameDecoder();
    let firstDone = false;
    socket.on('data', (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      for (const f of frames) {
        if (!firstDone) {
          firstDone = true;
          if (pkKnown) {
            continue; // 拨号方: 对方握手帧, 忽略
          }
          // 被拨方: 从首帧解析 pk
          try {
            const h = JSON.parse(f.toString('utf-8'));
            if (h && h.t === 'pk' && typeof h.pk === 'string') {
              const pk: string = h.pk;
              pkKnown = pk;
              if (this.conns.has(pk)) { socket.destroy(); return; } // 重复, 丢弃
              this.lanTried.add(pk);
              this.conns.set(pk, socket);
              // 回礼握手帧, 让对方也跳过其首帧
              socket.write(encodeFrame(Buffer.from(JSON.stringify({ t: 'pk', pk: this.myPk }))));
              this.emit('peer', pk);
              continue;
            }
          } catch {
            /* ignore */
          }
          socket.destroy();
          return;
        }
        const pk = pkKnown;
        if (pk) {
          for (const h of this.dataHandlers) h(f, pk);
          this.emit('data', f, pk);
        }
      }
    });
    socket.on('close', () => {
      if (pkKnown) {
        this.conns.delete(pkKnown);
        this.lanTried.delete(pkKnown); // 允许掉线后重新发现并直连
        this.emit('peer-offline', pkKnown);
      }
    });
    socket.on('error', () => {
      if (pkKnown) this.lanTried.delete(pkKnown);
    });
  }

  onData(h: DataHandler): void {
    this.dataHandlers.push(h);
  }

  sendTo(pk: string, payload: Buffer): boolean {
    const conn = this.conns.get(pk);
    if (!conn || conn.destroyed) return false;
    try {
      conn.write(encodeFrame(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 可靠单发: 先尝试直发；失败则 joinPeer 触发握手并等 conn 就绪再发。
   * 返回 SENT / NO_CONN。
   */
  /**
   * 可靠单发: 若已有连接直发；否则等待对方经 topic 发现建连后再发。返回 SENT / NO_CONN。
   * (hyperswarm v4 通过 joinRoom 的 DHT 发现自动建连, 无需 joinPeer)
   */
  async sendToWithWait(
    pk: string,
    payload: Buffer,
    timeoutMs = 15000
  ): Promise<'SENT' | 'NO_CONN'> {
    if (this.sendTo(pk, payload)) return 'SENT';
    const result = await new Promise<'READY' | 'TIMEOUT'>((resolve) => {
      const timer = setTimeout(() => {
        this.off('peer', onPeer);
        resolve('TIMEOUT');
      }, timeoutMs);
      const onPeer = (p: string) => {
        if (p === pk) {
          clearTimeout(timer);
          this.off('peer', onPeer);
          resolve('READY');
        }
      };
      this.on('peer', onPeer);
    });
    if (result === 'TIMEOUT') return 'NO_CONN';
    return this.sendTo(pk, payload) ? 'SENT' : 'NO_CONN';
  }

  broadcast(payload: Buffer): void {
    for (const conn of this.conns.values()) {
      try {
        if (!conn.destroyed) conn.write(encodeFrame(payload));
      } catch {
        /* 忽略单条失败 */
      }
    }
  }

  getPublicKey(): string {
    return this.myPk;
  }

  getConnectionCount(): number {
    return this.conns.size;
  }

  get connectedPeers(): string[] {
    return Array.from(this.conns.keys());
  }

  async stop(): Promise<void> {
    if (this.lan) {
      this.lan.stop();
      this.lan = undefined;
    }
    if (this.tcpServer) {
      await new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()));
      this.tcpServer = undefined;
    }
    if (this.swarm) await this.swarm.destroy();
    this.swarm = null;
    this.started = false;
    this.conns.clear();
    if (this.localBootstrap) {
      await this.localBootstrap.stop();
      this.localBootstrap = undefined;
    }
  }
}
