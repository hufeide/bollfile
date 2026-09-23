/**
 * index.ts — BollFileApp
 *
 * 把传输层 + 聊天协议 + 文件协议组合成一个可被 CLI / Electron 直接驱动的应用对象。
 * 所有子协议事件统一桥接到 app 上，UI 只需 listen app 的事件。
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import { HyperswarmTransport } from './transport';
import { ChatProtocol, ChatMessage, PeerState } from './chat';
import { FileProtocol, FileIncoming, ProgressInfo } from './filetransfer';

/** 传输层抽象接口 — HyperswarmTransport 与测试用 LoopbackTransport 都实现它 */
export interface TransportLike {
  onData(h: (payload: Buffer, fromPk: string) => void): void;
  sendTo(pk: string, payload: Buffer): boolean;
  sendToWithWait(pk: string, payload: Buffer, timeoutMs?: number): Promise<'SENT' | 'NO_CONN'>;
  broadcast(payload: Buffer): void;
  getPublicKey(): string;
  getConnectionCount(): number;
  on(event: string, listener: (...args: any[]) => void): any;
  joinRoom(code: string): void;
  startLanDiscovery(code: string): void;
  start(): Promise<string>;
  stop(): Promise<void>;
}

export interface BollFileOptions {
  role?: string;
  name?: string;
  downloadDir?: string;
  historyDir?: string;
  autoAccept?: boolean;
  /** 启用本地 DHT bootstrap (内网/离线场景, 不依赖公共 DHT) */
  useLocalBootstrap?: boolean;
  /** 注入传输层 (测试用 LoopbackTransport, 或自定义 HyperswarmTransport) */
  transport?: TransportLike;
}

export class BollFileApp extends EventEmitter {
  readonly transport: TransportLike;
  readonly chat: ChatProtocol;
  readonly file: FileProtocol;

  constructor(opts: BollFileOptions = {}) {
    super();
    this.transport =
      opts.transport ||
      new HyperswarmTransport({ role: opts.role, useLocalBootstrap: opts.useLocalBootstrap });
    this.chat = new ChatProtocol(this.transport as any, {
      role: opts.role,
      name: opts.name,
      historyDir: opts.historyDir,
    });
    this.file = new FileProtocol(this.transport as any, {
      downloadDir: opts.downloadDir,
      autoAccept: opts.autoAccept,
    });
    this.bridge();
  }

  private bridge(): void {
    // 传输层
    this.transport.on('ready', (pk: string) => this.emit('ready', pk));
    this.transport.on('peer', (pk: string) => this.emit('peer', pk));
    this.transport.on('peer-offline', (pk: string) => this.emit('peer-offline', pk));
    // 聊天层
    this.chat.on('peer-status', (pk: string, online: boolean, name?: string) =>
      this.emit('peer-status', pk, online, name)
    );
    this.chat.on('message', (m: ChatMessage) => this.emit('message', m));
    this.chat.on('delivered', (id: string) => this.emit('delivered', id));
    this.chat.on('read', (id: string) => this.emit('read', id));
    this.chat.on('verify-fail', (m: any) => this.emit('verify-fail', m));
    // 文件层
    this.file.on('incoming', (f: FileIncoming) => this.emit('file-incoming', f));
    this.file.on('progress', (p: ProgressInfo) => this.emit('file-progress', p));
    this.file.on('completed', (f: any) => this.emit('file-completed', f));
    this.file.on('rejected', (f: any) => this.emit('file-rejected', f));
    this.file.on('error', (e: any) => this.emit('file-error', e));
    this.file.on('resume', (r: any) => this.emit('file-resume', r));
    this.file.on('offer-sent', (o: any) => this.emit('file-offer-sent', o));
  }

  async start(): Promise<string> {
    const pk = await this.transport.start();
    this.chat.start();
    this.file.start();
    return pk;
  }

  joinRoom(code: string): void {
    this.transport.joinRoom(code);
  }

  /** 启动局域网多播发现(同网段直连, 与 DHT 互补) */
  startLan(code: string): void {
    this.transport.startLanDiscovery(code);
  }

  setName(name: string): void {
    this.chat.setName(name);
  }

  sendMessage(toPk: string, text: string): string {
    return this.chat.sendText(toPk, text);
  }

  sendFile(toPk: string, filePath: string, opts: { id?: string; name?: string } = {}): Promise<void> {
    return this.file.sendFile(toPk, filePath, opts);
  }

  acceptFile(id: string): void {
    this.file.accept(id);
  }

  rejectFile(id: string): void {
    this.file.reject(id);
  }

  getPublicKey(): string {
    return this.transport.getPublicKey();
  }

  getPeers(): PeerState[] {
    return this.chat.getPeers();
  }

  getHistory(peer: string): ChatMessage[] {
    return this.chat.getHistory(peer);
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }
}

export { HyperswarmTransport, ChatProtocol, FileProtocol };
