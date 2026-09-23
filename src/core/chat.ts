/**
 * chat.ts — ChatProtocol
 *
 *  - presence: 连接建立即互发在线/昵称/能力 (含 ed25519 公钥, 供验签)
 *  - chat.msg: 带 Ed25519 签名 (P5); 收端验签后落盘历史并发 chat.ack
 *  - chat.ack / chat.read: 送达 / 已读回执
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HyperswarmTransport } from './transport';
import { loadOrCreateKeys, sign, verify } from './keys';

export interface ChatMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: number;
  name?: string;
  dir?: 'in' | 'out';
}

export interface PresenceMsg {
  t: 'presence';
  name: string;
  caps: string[];
  pk: string;
  edPub: string;
}

export interface PeerState {
  pk: string;
  name?: string;
  edPub?: string;
  online: boolean;
}

export class ChatProtocol extends EventEmitter {
  private transport: HyperswarmTransport;
  private role: string;
  private name: string;
  private historyDir: string;
  private peers = new Map<string, PeerState>();
  private seen = new Set<string>();

  constructor(
    transport: HyperswarmTransport,
    opts: { role?: string; name?: string; historyDir?: string } = {}
  ) {
    super();
    this.transport = transport;
    this.role = opts.role || 'default';
    this.name = opts.name || `user-${this.role}`;
    this.historyDir =
      opts.historyDir || path.join(process.env.HOME || '/tmp', '.bollfile', 'history');
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  start(): void {
    this.transport.onData((payload, fromPk) => this.handle(payload, fromPk));
    this.transport.on('peer', (pk: string) => {
      const p = this.peers.get(pk) || { pk, online: false };
      p.online = true;
      this.peers.set(pk, p);
      this.sendPresence(pk);
    });
    this.transport.on('peer-offline', (pk: string) => {
      const p = this.peers.get(pk);
      if (p) {
        p.online = false;
        this.emit('peer-status', pk, false);
      }
    });
  }

  setName(name: string): void {
    this.name = name;
    this.sendPresence();
  }

  private sendPresence(pk?: string): void {
    const keys = loadOrCreateKeys(this.role);
    const msg: PresenceMsg = {
      t: 'presence',
      name: this.name,
      caps: ['chat', 'file'],
      pk: this.transport.getPublicKey(),
      edPub: keys.edPublic,
    };
    const buf = Buffer.from(JSON.stringify(msg), 'utf-8');
    if (pk) this.transport.sendTo(pk, buf);
    else this.transport.broadcast(buf);
  }

  private handle(payload: Buffer, fromPk: string): void {
    let m: any;
    try {
      m = JSON.parse(payload.toString('utf-8'));
    } catch {
      return;
    }

    if (m.t === 'presence') {
      const p = this.peers.get(fromPk) || { pk: fromPk, online: false };
      p.name = m.name;
      p.edPub = m.edPub;
      p.online = true;
      this.peers.set(fromPk, p);
      this.emit('peer-status', fromPk, true, m.name);
      // 注意: 不在此回发 presence —— 双方 'peer' 事件已各自发过一次, 名称已交换;
      // 若在此回发会形成 A↔B 无限互发循环 (同步递归挂死)。
      return;
    }

    if (m.t === 'chat.msg') {
      // 验签 (P5)
      if (m.edPub && m.sig) {
        const data = Buffer.from(`${m.id}:${m.ts}:${m.text}`, 'utf-8');
        if (!verify(m.edPub, data, m.sig)) {
          this.emit('verify-fail', m);
          return;
        }
      }
      if (this.seen.has(m.id)) return; // 去重
      this.seen.add(m.id);
      const msg: ChatMessage = {
        id: m.id,
        from: fromPk,
        to: m.to,
        text: m.text,
        ts: m.ts,
        name: m.name,
        dir: 'in',
      };
      this.appendHistory(fromPk, msg);
      this.emit('message', msg);
      this.transport.sendTo(fromPk, Buffer.from(JSON.stringify({ t: 'chat.ack', id: m.id }), 'utf-8'));
      return;
    }

    if (m.t === 'chat.ack') {
      this.emit('delivered', m.id);
      return;
    }
    if (m.t === 'chat.read') {
      this.emit('read', m.id);
      return;
    }
  }

  sendText(toPk: string, text: string): string {
    const keys = loadOrCreateKeys(this.role);
    const id = randomUUID();
    const ts = Date.now();
    const data = Buffer.from(`${id}:${ts}:${text}`, 'utf-8');
    const sig = sign(keys.edPrivate, data);
    const msg = {
      t: 'chat.msg',
      id,
      from: this.transport.getPublicKey(),
      to: toPk,
      text,
      ts,
      sig,
      edPub: keys.edPublic,
      name: this.name,
    };
    this.transport.sendTo(toPk, Buffer.from(JSON.stringify(msg), 'utf-8'));
    this.appendHistory(toPk, { ...msg, dir: 'out' });
    return id;
  }

  markRead(id: string, toPk: string): void {
    this.transport.sendTo(toPk, Buffer.from(JSON.stringify({ t: 'chat.read', id }), 'utf-8'));
  }

  getPeers(): PeerState[] {
    return Array.from(this.peers.values());
  }

  private appendHistory(peer: string, entry: any): void {
    const file = path.join(this.historyDir, `${peer}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  getHistory(peer: string): ChatMessage[] {
    const file = path.join(this.historyDir, `${peer}.jsonl`);
    try {
      return fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
