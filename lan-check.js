#!/usr/bin/env node
/**
 * lan-check.js — bollfile 局域网连通性诊断（纯 node 内置模块，无需 npm install）
 *
 * 用法（两台机器上同时跑）:
 *   node lan-check.js
 *
 * 作用:
 *   1) 打印本机所有 IPv4（借此判断两台是否真的在同一网段，例如都是 192.168.x.x）
 *   2) 加入多播组 239.255.42.42:49740，周期性广播测试包
 *   3) 收到来自其他机器的多播时打印 来源IP + 内容
 *
 * 判读:
 *   - 若 A 机器收不到 B 机器的广播 → 多播层不通（最常见: 路由器 AP 隔离 / 防火墙挡 UDP 49740 / 两台不在同网段 / WSL2 虚拟网段 NAT）
 *   - 若能看到对方广播 → 发现层 OK，问题在 hyperswarm 直连端口（防火墙挡其随机 UDP 端口）
 */
const dgram = require('dgram');
const os = require('os');

const MCAST_ADDR = '239.255.42.42';
const MCAST_PORT = 49740;

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4') out.push(`${name}: ${ni.address}${ni.internal ? ' (internal)' : ''}`);
    }
  }
  return out;
}

console.log('=== 本机 IPv4 地址 ===');
for (const s of lanIPs()) console.log('  ' + s);

const id = require('crypto').randomBytes(4).toString('hex');
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', (e) => {
  console.log('[socket error]', e.message);
});

socket.on('message', (msg, rinfo) => {
  let m;
  try { m = JSON.parse(msg.toString('utf-8')); } catch { return; }
  if (m.t !== 'bollcheck') return;
  if (m.id === id) return; // 自己发的
  console.log(`[收到广播] 来自 ${rinfo.address}:${rinfo.port}  id=${m.id}  自报地址=${JSON.stringify(m.a)}`);
});

socket.bind(MCAST_PORT, () => {
  try { socket.addMembership(MCAST_ADDR); } catch (e) { console.log('[addMembership 失败]', e.message); }
  try { socket.setBroadcast(true); } catch {}
  console.log(`\n已在 ${MCAST_ADDR}:${MCAST_PORT} 监听并加入多播，开始广播。两台机器同时跑，观察是否互相收到对方广播（Ctrl+C 退出）。\n`);

  const announce = () => {
    const myIp = lanIPs().find((s) => !s.includes('internal') && s.includes(':'))?.split(': ')[1] || '127.0.0.1';
    const payload = JSON.stringify({ t: 'bollcheck', id, a: { host: myIp, port: 0 } });
    const buf = Buffer.from(payload, 'utf-8');
    socket.send(buf, 0, buf.length, MCAST_PORT, MCAST_ADDR, () => {});
  };
  announce();
  setInterval(announce, 1500);
});

setTimeout(() => {
  console.log('\n=== 诊断结束 ===');
  console.log('如果没看到对方的 [收到广播]，说明多播没跨过机器（见上方判读）。');
  socket.close();
  process.exit(0);
}, 20000);
