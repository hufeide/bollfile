/**
 * loopback-transport.ts — 测试用传输层替身
 *
 * 用 Node Duplex 流把两个实例直接相连，复用 src/core/framing 的真实长度帧逻辑，
 * 从而确定性地测试 ChatProtocol / FileProtocol（不依赖外部 DHT，沙箱可跑）。
 * 它实现了与 HyperswarmTransport 相同的 TransportLike 接口。
 */
import { EventEmitter } from 'events';
import { Duplex } from 'stream';
import { randomUUID } from 'crypto';
import { encodeFrame, FrameDecoder } from '../core/framing';
import { TransportLike } from '../core/index';

export class LoopbackTransport extends EventEmitter implements TransportLike {
  readonly pk: string;
  private out = new Map<string, Duplex>();
  private decoders = new Map<string, FrameDecoder>();
  private dataHandlers: ((p: Buffer, fromPk: string) => void)[] = [];
  private started = false;

  constructor(opts: { pk?: string } = {}) {
    super();
    this.pk = opts.pk || randomUUID();
  }

  async start(): Promise<string> {
    this.started = true;
    this.emit('ready', this.pk);
    return this.pk;
  }

  onData(h: (payload: Buffer, fromPk: string) => void): void {
    this.dataHandlers.push(h);
  }

  getPublicKey(): string {
    return this.pk;
  }

  getConnectionCount(): number {
    return this.out.size;
  }

  sendTo(pk: string, payload: Buffer): boolean {
    const w = this.out.get(pk);
    if (!w || w.destroyed) return false;
    try {
      w.write(encodeFrame(payload));
      return true;
    } catch {
      return false;
    }
  }

  async sendToWithWait(pk: string, payload: Buffer): Promise<'SENT' | 'NO_CONN'> {
    return this.sendTo(pk, payload) ? 'SENT' : 'NO_CONN';
  }

  broadcast(payload: Buffer): void {
    for (const w of this.out.values()) {
      try {
        if (!w.destroyed) w.write(encodeFrame(payload));
      } catch {
        /* ignore */
      }
    }
  }

  joinRoom(): void {
    /* loopback 无需发现 */
  }

  /** 内部: 收到来自某 peer 的字节，解码帧后分发给上层 */
  recvFrom(fromPk: string, chunk: Buffer): void {
    let dec = this.decoders.get(fromPk);
    if (!dec) {
      dec = new FrameDecoder();
      this.decoders.set(fromPk, dec);
    }
    const frames = dec.push(chunk);
    for (const f of frames) {
      for (const h of this.dataHandlers) h(f, fromPk);
      this.emit('data', f, fromPk);
    }
  }

  /** 内部: 注册一条到 peer 的出向流 */
  registerPeer(peerPk: string, writeToPeer: Duplex): void {
    this.out.set(peerPk, writeToPeer);
    this.emit('peer', peerPk);
  }

  async stop(): Promise<void> {
    for (const w of this.out.values()) {
      try {
        w.destroy();
      } catch {
        /* ignore */
      }
    }
    this.out.clear();
    this.started = false;
  }
}

/** 把两个 LoopbackTransport 互相连接（全双工），触发双方的 'peer' 事件 */
export function link(a: LoopbackTransport, b: LoopbackTransport): void {
  const aToB = new Duplex({
    write(chunk, _enc, cb) {
      b.recvFrom(a.pk, chunk as Buffer);
      cb();
    },
    read() {},
  });
  const bToA = new Duplex({
    write(chunk, _enc, cb) {
      a.recvFrom(b.pk, chunk as Buffer);
      cb();
    },
    read() {},
  });
  a.registerPeer(b.pk, aToB);
  b.registerPeer(a.pk, bToA);
}
