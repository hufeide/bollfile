/**
 * hyperswarm.test.ts — 真实 hyperswarm 公共 DHT 端到端测试
 *
 * 在能连通公共 DHT 的环境（如真实公网两台机器）会跑通: 自动发现 + 真实 transport 字节往返。
 * 若沙箱/内网无法连通公共 DHT，自动 skip，不影响 `npm test` 整体通过。
 */
import test from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import { HyperswarmTransport } from '../core/transport';

test('real hyperswarm: discovery + transport round-trip (skip if DHT unreachable)', async (t) => {
  const room = 'bollfile-real-' + crypto.randomUUID();
  const a = new HyperswarmTransport({ role: 'HS-A' });
  const b = new HyperswarmTransport({ role: 'HS-B' });
  const pkA = await a.start();
  const pkB = await b.start();
  a.joinRoom(room);
  b.joinRoom(room);

  let connected = false;
  await new Promise<void>((resolve) => {
    const to = setTimeout(() => resolve(), 12000);
    const onPeer = () => {
      if (!connected) {
        connected = true;
        clearTimeout(to);
        resolve();
      }
    };
    a.on('peer', onPeer);
    b.on('peer', onPeer);
  });

  if (!connected) {
    await a.stop();
    await b.stop();
    return t.skip('公共 DHT 在本环境不可达，跳过真实 hyperswarm 端到端测试');
  }

  // 真实 transport 字节往返: A → B
  const received = new Promise<Buffer>((resolve) => {
    b.onData((payload: Buffer) => resolve(payload));
  });
  const ok = a.sendTo(pkB, Buffer.from('ping-from-A'));
  assert.ok(ok, 'sendTo 应通过真实连接成功');

  const got = await received;
  assert.equal(got.toString('utf-8'), 'ping-from-A');

  void pkA;
  await a.stop();
  await b.stop();
});
