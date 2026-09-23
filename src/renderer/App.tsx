import React, { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    electronAPI: any;
  }
}

interface Peer {
  pk: string;
  name: string;
  online: boolean;
}
interface Msg {
  text: string;
  ts: number;
  dir: 'in' | 'out';
  id?: string;
}
interface Offer {
  id: string;
  from: string;
  name: string;
  size: number;
}
interface Prog {
  id: string;
  name: string;
  pct: number;
  done: boolean;
  path?: string;
  error?: boolean;
}

export function App(): JSX.Element {
  const api = window.electronAPI;
  const [screen, setScreen] = useState<'start' | 'app'>('start');
  const [name, setName] = useState('我');
  const [room, setRoom] = useState('');
  const [role, setRole] = useState('default');
  const [myPk, setMyPk] = useState('');
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>({});
  const [offers, setOffers] = useState<Record<string, Offer>>({});
  const [prog, setProg] = useState<Record<string, Prog>>({});
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  const appendMsg = (peer: string, m: Msg) => {
    setMsgs((prev) => ({ ...prev, [peer]: [...(prev[peer] || []), m] }));
  };

  useEffect(() => {
    api.onEvent((p: any) => {
      const { type, data } = p;
      if (type === 'peer-status') {
        setPeers((prev) => ({
          ...prev,
          [data.pk]: {
            pk: data.pk,
            name: data.name || (prev[data.pk] ? prev[data.pk].name : ''),
            online: data.online,
          },
        }));
      } else if (type === 'message') {
        const from = data.from;
        setPeers((prev) =>
          prev[from]
            ? prev
            : { ...prev, [from]: { pk: from, name: data.name || '', online: true } }
        );
        appendMsg(from, { text: data.text, ts: data.ts, dir: 'in', id: data.id });
      } else if (type === 'file-incoming') {
        setOffers((prev) => ({
          ...prev,
          [data.id]: { id: data.id, from: data.from, name: data.name, size: data.size },
        }));
      } else if (type === 'file-progress') {
        const name = (prog[data.id] && prog[data.id].name) || (offers[data.id] && offers[data.id].name) || '';
        setProg((prev) => ({
          ...prev,
          [data.id]: {
            ...(prev[data.id] || { id: data.id, name: '', pct: 0, done: false }),
            name,
            pct: Math.min(100, Math.round((data.transferred / data.totalBytes) * 100)),
          },
        }));
      } else if (type === 'file-completed') {
        setProg((prev) => ({
          ...prev,
          [data.id]: {
            ...(prev[data.id] || { id: data.id, name: '', pct: 100, done: false }),
            pct: 100,
            done: true,
            path: data.path,
          },
        }));
      } else if (type === 'file-rejected' || type === 'file-error') {
        setProg((prev) => ({
          ...prev,
          [data.id]: { ...(prev[data.id] || { id: data.id, name: '', pct: 0, done: false }), error: true },
        }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active && Object.values(peers).some((p) => p.online)) {
      const first = Object.values(peers).find((p) => p.online);
      if (first) setActive(first.pk);
    }
  }, [peers, active]);

  const enter = async () => {
    if (!room.trim()) {
      setStatus('请填写房间码');
      return;
    }
    setStatus('启动中…');
    try {
      const pk = await api.start(role.trim() || 'default', name.trim() || '我');
      setMyPk(pk);
      await api.joinRoom(room.trim());
      setStatus('');
      setScreen('app');
    } catch (e: any) {
      setStatus('启动失败: ' + e.message);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t || !activeRef.current) return;
    const id = await api.sendMessage(activeRef.current, t);
    appendMsg(activeRef.current, { text: t, ts: Date.now(), dir: 'out', id });
    setText('');
  };

  const pick = async () => {
    if (!activeRef.current) {
      alert('请先选择一位同伴');
      return;
    }
    const fp = await api.pickFile();
    if (!fp) return;
    await api.sendFile(activeRef.current, fp);
  };

  const accept = (id: string) => {
    api.acceptFile(id);
    setOffers((p) => {
      const n = { ...p };
      delete n[id];
      return n;
    });
  };
  const reject = (id: string) => {
    api.rejectFile(id);
    setOffers((p) => {
      const n = { ...p };
      delete n[id];
      return n;
    });
  };

  if (screen === 'start') {
    return (
      <div className="center">
        <div className="card">
          <h1>bollfile</h1>
          <p>点对点消息与文件传输 · 零配置自动发现</p>
          <div className="row">
            <label className="muted">昵称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="你的昵称" />
          </div>
          <div className="row">
            <label className="muted">房间码（两台机器填相同码即可互连）</label>
            <div className="row-inline">
              <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="例如 abc-123" />
              <button onClick={() => setRoom('bollfile-' + Math.random().toString(36).slice(2, 8))}>
                随机
              </button>
            </div>
          </div>
          <div className="row">
            <label className="muted">身份(role，同机多开时区分)</label>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="default" />
          </div>
          <button style={{ width: '100%' }} onClick={enter}>
            进入
          </button>
          <div className="muted" style={{ marginTop: 10 }}>
            {status}
          </div>
        </div>
      </div>
    );
  }

  const peerList = Object.values(peers);
  const activeMsgs = (active && msgs[active]) || [];
  const activeOffers = Object.values(offers).filter((o) => o.from === active);
  const activeProg = Object.values(prog).filter(
    (p) => (offers[p.id] && offers[p.id].from === active) || p.done || p.error
  );

  return (
    <div id="app">
      <div className="sidebar">
        <div className="head">
          <div className="me">{name}</div>
          <div className="muted">{myPk.slice(0, 24)}…</div>
        </div>
        <div className="muted" style={{ padding: '10px 14px' }}>
          在线同伴
        </div>
        {peerList.length === 0 && <div className="hint">还没有同伴。让对方填入相同房间码即可自动出现。</div>}
        {peerList.map((p) => (
          <div
            key={p.pk}
            className={'peer' + (active === p.pk ? ' active' : '')}
            onClick={() => setActive(p.pk)}
          >
            <span>
              <span className={'dot' + (p.online ? ' on' : '')}></span>
              {p.name || p.pk.slice(0, 8)}
            </span>
            <span className="muted">{p.pk.slice(0, 6)}</span>
          </div>
        ))}
      </div>
      <div className="main">
        <div className="msgs">
          {activeMsgs.map((m, i) => (
            <div key={i} className={'bubble ' + (m.dir === 'out' ? 'mine' : 'theirs')}>
              <div>{m.text}</div>
              <div className="meta">
                {m.dir === 'out' ? '我' : peers[active!]?.name || ''} ·{' '}
                {new Date(m.ts).toLocaleTimeString()}
              </div>
            </div>
          ))}
          {activeOffers.map((o) => (
            <div key={o.id} className="filecard">
              <div>
                📄 {o.name} <span className="muted">({(o.size / 1024).toFixed(1)} KB)</span>
              </div>
              <div className="acts">
                <button onClick={() => accept(o.id)}>接收</button>
                <button style={{ background: '#ef4444' }} onClick={() => reject(o.id)}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
          {activeProg.map((p) => (
            <div key={p.id} className="filecard">
              <div>
                📄 {p.name}{' '}
                {p.done ? '✅ 完成 ' + (p.path || '') : p.error ? '❌ 失败' : '传输中'}
              </div>
              <div className="bar">
                <div style={{ width: (p.pct || 0) + '%' }}></div>
              </div>
            </div>
          ))}
        </div>
        <div className="composer">
          <button onClick={pick} title="发送文件">
            📎
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            placeholder="输入消息，回车发送"
          />
          <button onClick={send}>发送</button>
        </div>
      </div>
    </div>
  );
}
