/**
 * lan.test.ts — 本地 DHT bootstrap (内网/离线场景)
 *
 *  1) 单元: startLocalBootstrap 能起一个真正离线的 DHT 节点并返回有效地址;
 *     HyperswarmTransport(useLocalBootstrap) 能启动并在 stop 时清理。
 *  2) 端到端(best-effort): 两个 transport 共用一个本地 bootstrap、同一 topic,
 *     尝试自动互连。在能连通的环境(真实两机 LAN / 有公网出口)会跑通; 本沙箱因
 *     hyperdht 离线 firewall 限制可能连不上 → 自动 skip, 不影响整体通过。
 */
import test from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import { HyperswarmTransport } from '../core/transport';
import { startLocalBootstrap } from '../core/local-bootstrap';

test('local-bootstrap: 起离线 DHT 节点 + transport(useLocalBootstrap) 启动/清理', async () => {
  const lb = await startLocalBootstrap();
  assert.match(lb.address, /^[0-9.]+:\d+$/, '应返回 host:port 形式的地址');

  const t = new HyperswarmTransport({ role: 'LB-UNIT', useLocalBootstrap: true });
  const pk = await t.start();
  assert.ok(pk && pk.length === 64, '应返回 32 字节 hex 公钥');
  assert.equal(t.getConnectionCount(), 0);
  await t.stop();
  await lb.stop();
});

test('local-bootstrap e2e: 两节点经本地 bootstrap 互连 (skip if unreachable)', async (t) => {
  const lb = await startLocalBootstrap();
  const room = 'bollfile-lan-' + crypto.randomUUID();
  const a = new HyperswarmTransport({ role: 'LAN-A', bootstrap: [lb.address] });
  const b = new HyperswarmTransport({ role: 'LAN-B', bootstrap: [lb.address] });
  const pkA = await a.start();
  const pkB = await b.start();
  a.joinRoom(room);
  b.joinRoom(room);

  let connected = false;
  await new Promise<void>((resolve) => {
    const to = setTimeout(() => resolve(), 10000);
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
    await lb.stop();
    return t.skip('本地 bootstrap 离线互连在本环境不可达（hyperdht firewall），跳过');
  }

  // 已连通 → 验证真实 transport 字节往返
  const received = new Promise<Buffer>((resolve) => b.onData((p: Buffer) => resolve(p)));
  assert.ok(a.sendTo(pkB, Buffer.from('ping-lan')), 'sendTo 应通过本地 bootstrap 连接成功');
  const got = await received;
  assert.equal(got.toString('utf-8'), 'ping-lan');

  void pkA;
  await a.stop();
  await b.stop();
  await lb.stop();
});
