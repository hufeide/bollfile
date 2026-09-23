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
import { encodeFrame, FrameDecoder } from './framing';
import { loadOrCreateKeys } from './keys';
import { startLocalBootstrap, LocalBootstrap } from './local-bootstrap';

export type DataHandler = (payload: Buffer, fromPk: string) => void;

export class HyperswarmTransport extends EventEmitter {
  private swarm: any = null;
  private role: string;
  private bootstrap?: any;
  private useLocalBootstrap: boolean;
  private localBootstrap?: LocalBootstrap;
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
      this.emit('peer-offline', pk);
    });
    conn.on('error', () => {
      /* 静默: 连接错误由 offline 事件反映 */
    });

    this.emit('peer', pk);
  }

  /** 加入房间: 房间码 → sha256 → 私密 topic，DHT 自动撮合 */
  joinRoom(roomCode: string): void {
    if (!this.swarm) throw new Error('transport not started');
    const topic = crypto.createHash('sha256').update(roomCode).digest().subarray(0, 16);
    this.swarm.join(topic, { server: true, client: true });
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
