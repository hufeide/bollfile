/**
 * integration.test.ts — 两节点端到端集成测试 (确定性, 走 LoopbackTransport)
 *
 * 用 LoopbackTransport 把两个 BollFileApp 直接相连，复用真实的 framing / ChatProtocol /
 * FileProtocol 代码，验证:
 *   1) 连接建立 + presence (在线/昵称)
 *   2) 聊天消息收发 + 签名
 *   3) 文件传输 (整文件 sha256 校验)
 *   4) 断点续传 (预置部分分块 → 从断点继续 → 完整性不变)
 */
import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { BollFileApp } from '../core/index';
import { LoopbackTransport, link } from '../test-support/loopback-transport';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bollfile-'));
}

function makeFile(sizeMB: number): { filePath: string; sha256: string; size: number } {
  const filePath = path.join(tmpDir(), 'src.bin');
  const buf = crypto.randomBytes(sizeMB * 1024 * 1024);
  fs.writeFileSync(filePath, buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { filePath, sha256, size: buf.length };
}

function waitFor(fn: () => boolean, ms = 20000, step = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error('waitFor timeout'));
      }
    }, step);
  });
}

test('connect + chat + file transfer + resume', async () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  const a = new BollFileApp({
    role: 'A',
    name: 'Alice',
    historyDir: dirA,
    downloadDir: dirA,
    autoAccept: true,
    transport: new LoopbackTransport({ pk: 'pk-Alice' }),
  });
  const b = new BollFileApp({
    role: 'B',
    name: 'Bob',
    historyDir: dirB,
    downloadDir: dirB,
    autoAccept: true,
    transport: new LoopbackTransport({ pk: 'pk-Bob' }),
  });

  let resumed = false;
  a.on('file-resume', () => {
    resumed = true;
  });

  const pkA = await a.start();
  const pkB = await b.start();
  link(a.transport as LoopbackTransport, b.transport as LoopbackTransport);

  // 1) 连接建立
  await waitFor(
    () => a.transport.getConnectionCount() > 0 && b.transport.getConnectionCount() > 0,
    10000
  );
  assert.equal(pkA, 'pk-Alice');
  assert.equal(pkB, 'pk-Bob');

  // presence / 在线状态 + 昵称
  await waitFor(() => {
    const pa = a.getPeers().find((p) => p.pk === pkB);
    return !!pa && pa.online === true && pa.name === 'Bob';
  }, 5000);
  const pa = a.getPeers().find((p) => p.pk === pkB)!;
  assert.equal(pa.name, 'Bob');

  // 2) 聊天消息 (带 Ed25519 签名)
  const chatReceived = new Promise<any>((res) => b.once('message', res));
  const mid = a.sendMessage(pkB, 'hello bollfile');
  assert.ok(mid, '应返回消息 id');
  const msg = await chatReceived;
  assert.equal(msg.text, 'hello bollfile');
  assert.equal(msg.from, pkA);

  // 3) 文件传输 (2MB)
  const src = makeFile(2);
  const fileDone = new Promise<any>((res) => b.once('file-completed', res));
  await a.sendFile(pkB, src.filePath);
  const f = await fileDone;
  assert.equal(f.size, src.size);
  assert.equal(f.sha256, src.sha256, '整文件 sha256 应一致');
  const downloaded = fs.readFileSync(f.path);
  assert.equal(
    crypto.createHash('sha256').update(downloaded).digest('hex'),
    src.sha256,
    '落盘内容 sha256 应一致'
  );

  // 4) 断点续传: 预置 B 侧前 2 块 + meta, 再从第 2 块续传
  const CHUNK = 256 * 1024;
  const rsrc = makeFile(1); // 1MB = 4 块
  const id = 'resume-' + crypto.randomUUID();
  const partial = path.join(dirB, `${id}.part`);
  const data = fs.readFileSync(rsrc.filePath);
  {
    const fd = fs.openSync(partial, 'w');
    fs.writeSync(fd, data.subarray(0, CHUNK), 0, CHUNK, 0);
    fs.writeSync(fd, data.subarray(CHUNK, 2 * CHUNK), 0, CHUNK, CHUNK);
    fs.closeSync(fd);
  }
  const totalChunks = Math.ceil(rsrc.size / CHUNK);
  fs.writeFileSync(
    path.join(dirB, `${id}.meta.json`),
    JSON.stringify({
      id,
      name: path.basename(rsrc.filePath),
      size: rsrc.size,
      totalChunks,
      sha256: rsrc.sha256,
      chunkSize: CHUNK,
      received: [0, 1],
    })
  );

  const resumeDone = new Promise<any>((res) => b.once('file-completed', res));
  await a.sendFile(pkB, rsrc.filePath, { id, name: path.basename(rsrc.filePath) });
  const rf = await resumeDone;
  assert.equal(rf.sha256, rsrc.sha256, '续传后整文件 sha256 应一致');
  const rdl = fs.readFileSync(rf.path);
  assert.equal(
    crypto.createHash('sha256').update(rdl).digest('hex'),
    rsrc.sha256,
    '续传落盘内容 sha256 应一致'
  );
  assert.ok(resumed, '发送方应触发断点续传');

  await a.stop();
  await b.stop();
});
