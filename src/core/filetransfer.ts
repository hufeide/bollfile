/**
 * filetransfer.ts — FileProtocol
 *
 * 协议 (跑在 hyperswarm 字节流 + 长度帧上, 无 64KB 限制):
 *   file.offer / file.accept / file.reject
 *   file.chunk  (帧内嵌: [4字节头长][JSON头][二进制块])
 *   file.chunk.ack / file.done / file.resume / file.error
 *
 * 特性: 逐块 sha256 校验 + 整文件 sha256 校验 + 断点续传 (receiver 侧写 .part + .meta.json)。
 */
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HyperswarmTransport } from './transport';

const CHUNK_SIZE = 256 * 1024; // 256KB
const SEND_WINDOW = 32; // 最大在途分块数

export interface FileOffer {
  t: 'file.offer';
  id: string;
  name: string;
  size: number;
  mime: string;
  totalChunks: number;
  sha256: string;
  chunkSize: number;
}

export interface FileIncoming {
  id: string;
  from: string;
  name: string;
  size: number;
  totalChunks: number;
  sha256: string;
  mime: string;
}

export interface ProgressInfo {
  id: string;
  direction: 'send' | 'recv';
  index: number;
  total: number;
  transferred: number;
  totalBytes: number;
}

interface SendState {
  id: string;
  toPk: string;
  filePath: string;
  size: number;
  totalChunks: number;
  sha256: string;
  chunkSize: number;
  start: number;
  acked: Set<number>;
  inflight: number;
  waiters: Array<() => void>;
  error?: string;
}

interface RecvState {
  id: string;
  fromPk: string;
  tmp: string;
  fd: fsp.FileHandle;
  totalChunks: number;
  sha256: string;
  size: number;
  chunkSize: number;
  name: string;
  mime: string;
  received: Set<number>;
}

function encodeChunkFrame(header: object, chunk: Buffer): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(headerBuf.length, 0);
  return Buffer.concat([head, headerBuf, chunk]);
}

function decodeChunkFrame(payload: Buffer): { header: any; chunk: Buffer } {
  const hlen = payload.readUInt32BE(0);
  const header = JSON.parse(payload.subarray(4, 4 + hlen).toString('utf-8'));
  const chunk = Buffer.from(payload.subarray(4 + hlen));
  return { header, chunk };
}

async function hashFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  const st = fs.createReadStream(p);
  for await (const c of st) h.update(c as Buffer);
  return h.digest('hex');
}

function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export class FileProtocol extends EventEmitter {
  private transport: HyperswarmTransport;
  private downloadDir: string;
  private autoAccept: boolean;
  private receiving = new Map<string, RecvState>();
  private sending = new Map<string, SendState>();
  private acceptWaiters = new Map<string, (v: boolean) => void>();

  constructor(
    transport: HyperswarmTransport,
    opts: { downloadDir?: string; autoAccept?: boolean } = {}
  ) {
    super();
    this.transport = transport;
    this.downloadDir =
      opts.downloadDir || path.join(process.env.HOME || '/tmp', '.bollfile', 'downloads');
    this.autoAccept = opts.autoAccept ?? false;
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  start(): void {
    this.transport.onData((payload, fromPk) => this.handle(payload, fromPk));
  }

  setAutoAccept(v: boolean): void {
    this.autoAccept = v;
  }

  private handle(payload: Buffer, fromPk: string): void {
    let m: any;
    try {
      m = JSON.parse(payload.toString('utf-8'));
    } catch {
      // 二进制分块帧
      const d = decodeChunkFrame(payload);
      if (d.header && d.header.t === 'file.chunk') {
        this.onChunk(payload, fromPk);
      }
      return;
    }
    switch (m.t) {
      case 'file.offer':
        this.onOffer(m as FileOffer, fromPk);
        break;
      case 'file.accept':
        this.onAccept(m.id);
        break;
      case 'file.reject':
        this.onAcceptReject(m.id, false);
        break;
      case 'file.resume':
        this.onResume(m.id, m.index);
        break;
      case 'file.chunk.ack':
        this.onChunkAck(m.id, m.index);
        break;
      case 'file.done':
        this.onDone(m.id);
        break;
      case 'file.error':
        this.onError(m.id);
        break;
    }
  }

  // ---------- 发送方 ----------

  async sendFile(
    toPk: string,
    filePath: string,
    opts: { id?: string; name?: string } = {}
  ): Promise<void> {
    const id = opts.id || randomUUID();
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const chunkSize = CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const sha256 = await hashFile(filePath);
    const name = opts.name || path.basename(filePath);

    const offer: FileOffer = {
      t: 'file.offer',
      id,
      name,
      size,
      mime: guessMime(name),
      totalChunks,
      sha256,
      chunkSize,
    };

    const s: SendState = {
      id,
      toPk,
      filePath,
      size,
      totalChunks,
      sha256,
      chunkSize,
      start: 0,
      acked: new Set(),
      inflight: 0,
      waiters: [],
    };
    this.sending.set(id, s);
    this.emit('offer-sent', offer);
    this.transport.sendTo(toPk, Buffer.from(JSON.stringify(offer)));

    const accepted = await this.waitAccept(id, 30000);
    if (!accepted) {
      this.sending.delete(id);
      this.emit('rejected', { id, name, size });
      return;
    }

    await this.pumpChunks(s);

    if (!s.error) {
      this.transport.sendTo(toPk, Buffer.from(JSON.stringify({ t: 'file.done', id })));
      this.emit('completed', {
        id,
        direction: 'send',
        name,
        size,
        toPk,
        sha256,
      });
    }
    this.sending.delete(id);
  }

  private async pumpChunks(s: SendState): Promise<void> {
    let i = s.start;
    while (true) {
      while (i < s.totalChunks && s.inflight < SEND_WINDOW) {
        if (s.acked.has(i)) {
          i++;
          continue;
        }
        this.sendOneChunk(s, i);
        i++;
        s.inflight++;
      }
      if (s.acked.size >= s.totalChunks) break;
      if (i >= s.totalChunks && s.inflight === 0) break;
      await this.nextAck(s);
    }
  }

  private sendOneChunk(s: SendState, index: number): void {
    const start = index * s.chunkSize;
    const len = Math.min(s.chunkSize, s.size - start);
    const chunk = Buffer.alloc(len);
    const fd = fs.openSync(s.filePath, 'r');
    try {
      fs.readSync(fd, chunk, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    const cs = crypto.createHash('sha256').update(chunk).digest('hex');
    const frame = encodeChunkFrame(
      { t: 'file.chunk', id: s.id, index, sha256: cs },
      chunk
    );
    this.transport.sendTo(s.toPk, frame);
  }

  private nextAck(s: SendState): Promise<void> {
    return new Promise((resolve) => s.waiters.push(resolve));
  }

  private onChunkAck(id: string, index: number): void {
    const s = this.sending.get(id);
    if (!s) return;
    s.acked.add(index);
    s.inflight--;
    this.emit('progress', {
      id,
      direction: 'send',
      index,
      total: s.totalChunks,
      transferred: s.acked.size * s.chunkSize,
      totalBytes: s.size,
    } as ProgressInfo);
    const w = s.waiters.shift();
    if (w) w();
  }

  private onResume(id: string, index: number): void {
    const s = this.sending.get(id);
    if (!s) return;
    s.start = Math.max(s.start, index + 1);
    for (let i = 0; i <= index; i++) s.acked.add(i);
    this.emit('resume', { id, fromIndex: s.start });
  }

  private onAccept(id: string): void {
    this.onAcceptReject(id, true);
  }

  private onAcceptReject(id: string, accepted: boolean): void {
    const w = this.acceptWaiters.get(id);
    if (w) {
      this.acceptWaiters.delete(id);
      w(accepted);
    }
  }

  private onError(id: string): void {
    const s = this.sending.get(id);
    if (s) s.error = 'receiver verify failed';
    this.emit('error', { id, message: 'receiver verify failed' });
  }

  private waitAccept(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.acceptWaiters.delete(id);
        resolve(false);
      }, timeoutMs);
      this.acceptWaiters.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }

  // ---------- 接收方 ----------

  private async onOffer(offer: FileOffer, fromPk: string): Promise<void> {
    const meta = this.loadMeta(offer.id);
    let contiguous = 0;
    if (meta && meta.sha256 === offer.sha256 && meta.size === offer.size) {
      contiguous = this.contiguous(meta.received);
    }
    const tmp = path.join(this.downloadDir, `${offer.id}.part`);
    let fd: fsp.FileHandle;
    try {
      fd = await fsp.open(tmp, 'r+');
    } catch {
      fd = await fsp.open(tmp, 'w');
    }
    const s: RecvState = {
      id: offer.id,
      fromPk,
      tmp,
      fd,
      totalChunks: offer.totalChunks,
      sha256: offer.sha256,
      size: offer.size,
      chunkSize: offer.chunkSize,
      name: offer.name,
      mime: offer.mime,
      received: new Set(meta ? meta.received : []),
    };
    this.receiving.set(offer.id, s);
    this.saveMeta(offer.id);

    const incoming: FileIncoming = {
      id: offer.id,
      from: fromPk,
      name: offer.name,
      size: offer.size,
      totalChunks: offer.totalChunks,
      sha256: offer.sha256,
      mime: offer.mime,
    };
    this.emit('incoming', incoming);

    if (contiguous >= 1) {
      // 已有部分分块 → 请求从断点续传
      this.transport.sendTo(
        fromPk,
        Buffer.from(JSON.stringify({ t: 'file.resume', id: offer.id, index: contiguous - 1 }))
      );
    }

    if (this.autoAccept) this.accept(offer.id);
  }

  accept(id: string): void {
    const s = this.receiving.get(id);
    if (!s) return;
    this.transport.sendTo(s.fromPk, Buffer.from(JSON.stringify({ t: 'file.accept', id })));
  }

  reject(id: string): void {
    const s = this.receiving.get(id);
    if (!s) return;
    this.transport.sendTo(s.fromPk, Buffer.from(JSON.stringify({ t: 'file.reject', id })));
    this.receiving.delete(id);
  }

  private async onChunk(payload: Buffer, fromPk: string): Promise<void> {
    const { header, chunk } = decodeChunkFrame(payload);
    const s = this.receiving.get(header.id);
    if (!s) return;
    const cs = crypto.createHash('sha256').update(chunk).digest('hex');
    if (cs !== header.sha256) {
      this.transport.sendTo(fromPk, Buffer.from(JSON.stringify({ t: 'file.error', id: header.id })));
      return;
    }
    await s.fd.write(chunk, 0, chunk.length, header.index * s.chunkSize);
    s.received.add(header.index);
    this.emit('progress', {
      id: header.id,
      direction: 'recv',
      index: header.index,
      total: s.totalChunks,
      transferred: s.received.size * s.chunkSize,
      totalBytes: s.size,
    } as ProgressInfo);
    if (s.received.size % 16 === 0 || s.received.size === s.totalChunks) this.saveMeta(header.id);
    this.transport.sendTo(
      fromPk,
      Buffer.from(JSON.stringify({ t: 'file.chunk.ack', id: header.id, index: header.index }))
    );
  }

  private async onDone(id: string): Promise<void> {
    const s = this.receiving.get(id);
    if (!s) return;
    await s.fd.close();
    const actual = await hashFile(s.tmp);
    if (actual !== s.sha256) {
      this.transport.sendTo(s.fromPk, Buffer.from(JSON.stringify({ t: 'file.error', id })));
      this.emit('error', { id, message: 'checksum mismatch' });
      return;
    }
    const finalPath = this.uniquePath(s.name);
    fs.renameSync(s.tmp, finalPath);
    this.deleteMeta(id);
    this.receiving.delete(id);
    this.emit('completed', {
      id,
      direction: 'recv',
      name: s.name,
      size: s.size,
      path: finalPath,
      sha256: s.sha256,
    });
  }

  // ---------- meta / 续传辅助 ----------

  private metaPath(id: string): string {
    return path.join(this.downloadDir, `${id}.meta.json`);
  }

  private saveMeta(id: string): void {
    const s = this.receiving.get(id);
    if (!s) return;
    const meta = {
      id,
      name: s.name,
      size: s.size,
      totalChunks: s.totalChunks,
      sha256: s.sha256,
      chunkSize: s.chunkSize,
      received: Array.from(s.received).sort((a, b) => a - b),
    };
    fs.writeFileSync(this.metaPath(id), JSON.stringify(meta));
  }

  private loadMeta(id: string): any {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf-8'));
    } catch {
      return null;
    }
  }

  private deleteMeta(id: string): void {
    try {
      fs.unlinkSync(this.metaPath(id));
    } catch {
      /* ignore */
    }
  }

  private contiguous(arr: number[]): number {
    const set = new Set(arr);
    let c = 0;
    while (set.has(c)) c++;
    return c;
  }

  private uniquePath(name: string): string {
    const base = path.join(this.downloadDir, name);
    if (!fs.existsSync(base)) return base;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let i = 1;
    while (fs.existsSync(path.join(this.downloadDir, `${stem} (${i})${ext}`))) i++;
    return path.join(this.downloadDir, `${stem} (${i})${ext}`);
  }
}
