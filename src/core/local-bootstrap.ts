/**
 * local-bootstrap.ts — 本地 DHT bootstrap 节点 (用于内网/离线场景)
 *
 * 重要: hyperdht 会把 `bootstrap:false` 又覆盖回公共节点, 且其离线节点会处于
 * `firewalled` 状态。为此我们直接用底层 `dht-rpc` 起一个真正离线 (`bootstrap:false`)
 * 的 DHT 节点, 把它作为局域网内其他节点的 bootstrap 地址。
 *
 * 适用场景: 有公网出口的普通内网 — 公共 DHT 本就可用; 本模块是给"不想依赖公共
 * DHT / 需要内网自洽"的高级用法。完全 air-gapped 的离线两机直连受 hyperdht 的
 * NAT/holepunch 限制, 仍需 P6 中继兜底。
 */
import DHT from 'dht-rpc';

export interface LocalBootstrap {
  /** 'host:port' 形式, 供 hyperswarm 的 bootstrap 选项使用 */
  address: string;
  node: any;
  stop: () => Promise<void>;
}

export async function startLocalBootstrap(): Promise<LocalBootstrap> {
  const node = new DHT({ bootstrap: false });
  await node.bind();
  const a = node.address();
  const host = a && a.host && a.host !== '0.0.0.0' ? a.host : '127.0.0.1';
  const address = `${host}:${a.port}`;
  return {
    address,
    node,
    stop: async () => {
      try {
        await node.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
