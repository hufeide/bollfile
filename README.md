# bollfile — 点对点消息与文件传输助手

基于 **hyperswarm** 的公共 DHT **零配置自动发现**：两台机器填入**同一个房间码**即可自动互连，发文本消息和文件。无需配置 IP / 端口 / 服务器。

> 设计调研来源：`/home/fei/workspace/bolloon` 的 P2P 实现（`p2p-direct.ts` / `auto-peer-discovery.ts` / `source-intent-broadcaster.ts` / `p2p-secret.ts`）。

## 架构

```
UI 层 (Electron 对话框 / CLI)
   │  window.electronAPI (IPC)
┌──▼──────────────────────────────────────────┐
│  BollFileApp (core/index.ts)                  │
│   ├─ ChatProtocol   presence / 消息 / 回执    │
│   └─ FileProtocol   分块 / sha256 / 续传       │
└──┬───────────────────────────────────────────┘
   │  TransportLike 接口
┌──▼───────────────────────────────────────────┐
│  HyperswarmTransport (真实)  / LoopbackTransport(测试) │
│   roomCode → sha256 → 私密 topic → 公共 DHT 自动发现   │
│   conn 全双工字节流 + 长度前缀帧 (解决粘包)            │
└───────────────────────────────────────────────┘
```

- **零配置发现**：`roomCode` 经 `sha256` 派生出**私密 topic**，双方加入同一 topic → 公共 DHT 自动撮合 → `connection` 事件 → 自动加为同伴（不需用户配网络）。
- **传输**：hyperswarm 的 `conn` 是裸字节流，上叠 `[4字节长度][payload]` 帧封装，可传任意大小消息与文件（**无 64KB 限制**）。
- **身份/签名（P5）**：每个 role 持久化一套密钥 `~/.bollfile/keys-<role>.json`：X25519 种子（路由身份，跨重启稳定）+ Ed25519 密钥对（消息签名/验签）。聊天消息带 Ed25519 签名，收端验签。

## 协议（跑在帧之上）

- `presence`：连接建立即互发在线/昵称/能力（含 Ed25519 公钥）。
- `chat.msg` / `chat.ack` / `chat.read`：消息 + 送达 / 已读回执。
- `file.offer` / `file.accept` / `file.reject` / `file.chunk` / `file.chunk.ack` / `file.done` / `file.resume` / `file.error`：
  - 逐块（默认 256KB）传输，每块带 sha256；
  - 整文件 sha256 校验；
  - **断点续传**：接收方 `.part` + `.meta.json` 记录已收块，重连后发 `file.resume`，发送方从断点继续。

## 使用

### 方式一：Electron 桌面对话框（GUI）
```bash
npm install          # 如需启动 GUI，请去掉 ELECTRON_SKIP_BINARY_DOWNLOAD 后重装 electron
npm run build
npm start
```
启动后填昵称 + 房间码 → 进入对话框：左侧同伴列表（自动出现），右侧聊天 + 📎 发文件 + 接收卡片（接受/拒绝）+ 进度条。

### 方式二：CLI（无显示器 / 服务器友好）
```bash
npm run build
# 机器 A:
node dist/cli.js --room SECRET --name A
# 机器 B:
node dist/cli.js --room SECRET --name B
```
进入后输入：`peers` 看同伴、`msg <pk> <文本>` 发消息、`file <pk> <路径>` 发文件、`help` 帮助。

> 两种方式的双方只需**房间码相同**即可自动互连（真实公网环境经公共 DHT 可达；本沙箱出网受限，DHT 自动发现不可用，但协议逻辑由确定性测试覆盖）。

## 测试

```bash
npm test
```
- `integration.test.ts`：**确定性端到端**，用 `LoopbackTransport` 直接连接两个实例，走**真实**的 framing / 聊天 / 文件 / 续传代码，验证：自动连接 + presence、聊天收发 + 签名、2MB 文件整文件 sha256 校验、断点续传完整性。**通过**。
- `hyperswarm.test.ts`：真实 hyperswarm 公共 DHT 端到端（发现 + 字节往返）。在能连通公共 DHT 的环境（真实公网两台机器）会跑通；本沙箱出网受限时**自动 skip**，不影响整体通过。

## 目录
```
src/core/       传输/聊天/文件 核心库 (纯 Node, 无 Electron 依赖)
src/main/       Electron 主进程 + preload
src/renderer/   对话框 UI (原生 JS)
src/cli.ts      命令行驱动
src/test/       集成测试
src/test-support/ 测试替身
```

## 内网 / 离线：本地 DHT bootstrap

默认的"零配置"依赖**公共 DHT**（两台公网机器、或有公网出口的普通内网都可用）。若要在**不依赖公共 DHT** 的内网里互连，可启用"本地 DHT bootstrap"：应用起一个真正离线的 DHT 节点，局域网内其他实例把它作为 bootstrap 地址。

```bash
# CLI 启用
node dist/cli.js --room SECRET --name A --local-bootstrap
# Electron: 在 main.ts 构造 BollFileApp 时传 { useLocalBootstrap: true }
```

> 适用与限制：对"有公网出口的内网 / 真实两机 LAN"通常可用；**完全 air-gapped（无任何外网、且 hyperdht 离线 firewall）的同机/受限场景**，hyperdht 的 NAT/holepunch 仍可能受限，此时需要 P6 的中继（libp2p/iroh relay）兜底。相关代码已就位（`local-bootstrap.ts` + `HyperswarmTransport.useLocalBootstrap`），并有单元测试 + best-effort 端到端测试。

## 与原始方案的偏差说明
- **UI 已换成 React 19 + esbuild**（最初计划用 React，后临时用原生 JS 验证，现已回归 React）：渲染层用 `esbuild` 打包进 `dist/renderer/renderer.js`，无需额外打包器配置。
- **构建时跳过 electron 二进制**（`ELECTRON_SKIP_BINARY_DOWNLOAD=1`）：仅取类型供 `tsc` 编译；启动真实 GUI 需正常安装 electron。
- **P6（libp2p/iroh 兜底）部分落地**：已实现"本地 DHT bootstrap"作为内网/离线零配置增强（见上）；完全 air-gapped 的中继兜底按需再加。
# bollfile
