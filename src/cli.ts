/**
 * cli.ts — 命令行驱动 (无显示器也能在两台公网机器上实测)
 *
 * 用法:
 *   node dist/cli.js --room SECRET --name A [--role A] [--download ./dl]
 *
 * 进入后输入命令:
 *   peers              列出已发现的同伴 (pk + 昵称 + 在线)
 *   msg <pk> <文本>    给某同伴发消息
 *   file <pk> <路径>   给某同伴发文件
 *   help               帮助
 *   对方发来的文件默认自动接收, 存到 --download 目录。
 */
import * as readline from 'readline';
import { BollFileApp } from './core/index';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes('--' + name);
}

async function main(): Promise<void> {
  const room = arg('room');
  const name = arg('name', 'anonymous');
  const role = arg('role', name);
  const download = arg('download', '');
  const useLocalBootstrap = flag('local-bootstrap');

  if (!room) {
    console.log(
      '用法: node dist/cli.js --room <房间码> --name <昵称> [--role <role>] [--download <目录>] [--local-bootstrap]'
    );
    process.exit(1);
  }

  const app = new BollFileApp({
    role,
    name,
    downloadDir: download || undefined,
    autoAccept: true,
    useLocalBootstrap,
  });

  app.on('ready', (pk: string) => {
    console.log(`[已启动] 我的身份: ${pk}`);
    console.log(`[房间] 已加入 "${room}"，等待同伴(同一房间码)自动出现…`);
  });
  app.on('peer-status', (pk: string, online: boolean, n?: string) => {
    console.log(`[同伴] ${n || pk.slice(0, 12)} ${online ? '在线' : '离线'} (${pk})`);
  });
  app.on('message', (m: any) => {
    const who = m.name || m.from.slice(0, 12);
    console.log(`<< ${who}: ${m.text}`);
  });
  app.on('file-incoming', (f: any) => {
    console.log(`[收文件] ${f.name} (${(f.size / 1024).toFixed(1)} KB) 来自 ${f.from.slice(0, 12)}`);
  });
  app.on('file-progress', (p: any) => {
    const pct = Math.round((p.transferred / p.totalBytes) * 100);
    process.stdout.write(`\r[进度] ${p.id.slice(0, 8)} ${pct}%`);
  });
  app.on('file-completed', (f: any) => {
    console.log(`\n[完成] ${f.direction === 'recv' ? '已接收' : '已发送'} ${f.name} -> ${f.path || ''}`);
  });

  await app.start();
  app.joinRoom(room);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question('bollfile> ', (line) => handle(line));

  function handle(line: string): void {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    if (cmd === 'help') {
      console.log('命令: peers | msg <pk> <文本> | file <pk> <路径> | help | exit');
    } else if (cmd === 'peers') {
      const peers = app.getPeers();
      if (!peers.length) console.log('(暂无同伴，确认对方填了相同房间码)');
      peers.forEach((p: any) => console.log(`  ${p.pk}  ${p.name || ''}  ${p.online ? '在线' : '离线'}`));
    } else if (cmd === 'msg') {
      const pk = parts[1];
      const text = parts.slice(2).join(' ');
      if (!pk || !text) return console.log('用法: msg <pk> <文本>');
      app.sendMessage(pk, text);
      console.log('已发送');
    } else if (cmd === 'file') {
      const pk = parts[1];
      const path = parts[2];
      if (!pk || !path) return console.log('用法: file <pk> <路径>');
      app.sendFile(pk, path).then(() => console.log('文件发送任务结束'));
    } else if (cmd === 'exit' || cmd === 'quit') {
      rl.close();
      process.exit(0);
    } else if (cmd) {
      console.log('未知命令，输入 help');
    }
    prompt();
  }
  prompt();
}

main();
