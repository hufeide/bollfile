/**
 * main.ts — Electron 主进程
 *
 * 启动 BollFileApp (真实 HyperswarmTransport)，把传输/聊天/文件事件通过 IPC 推给渲染进程。
 * 渲染进程是一个对话框 UI (src/renderer)，通过 window.electronAPI 调用本进程的方法。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { BollFileApp } from '../core/index';

let win: BrowserWindow | null = null;
let boll: BollFileApp | null = null;

function pushEvent(type: string, data: any): void {
  if (win) win.webContents.send('app-event', { type, data });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 960,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function setupIpc(): void {
  ipcMain.handle('start', async (_e, role: string, name: string) => {
    boll = new BollFileApp({ role: role || 'default', name });
    const pk = await boll.start();
    boll.on('peer-status', (pk2, online, name2) =>
      pushEvent('peer-status', { pk: pk2, online, name: name2 })
    );
    boll.on('message', (m) => pushEvent('message', m));
    boll.on('delivered', (id) => pushEvent('delivered', { id }));
    boll.on('read', (id) => pushEvent('read', { id }));
    boll.on('file-incoming', (f) => pushEvent('file-incoming', f));
    boll.on('file-progress', (p) => pushEvent('file-progress', p));
    boll.on('file-completed', (f) => pushEvent('file-completed', f));
    boll.on('file-rejected', (f) => pushEvent('file-rejected', f));
    boll.on('file-error', (e) => pushEvent('file-error', e));
    boll.on('file-resume', (r) => pushEvent('file-resume', r));
    boll.on('file-offer-sent', (o) => pushEvent('file-offer-sent', o));
    return pk;
  });

  ipcMain.handle('joinRoom', (_e, code: string) => boll?.joinRoom(code));
  ipcMain.handle('getPublicKey', () => boll?.getPublicKey() || '');
  ipcMain.handle('getPeers', () => (boll ? boll.getPeers() : []));
  ipcMain.handle('sendMessage', (_e, pk: string, text: string) => boll?.sendMessage(pk, text));
  ipcMain.handle('sendFile', (_e, pk: string, filePath: string) => boll?.sendFile(pk, filePath));
  ipcMain.handle('acceptFile', (_e, id: string) => boll?.acceptFile(id));
  ipcMain.handle('rejectFile', (_e, id: string) => boll?.rejectFile(id));
  ipcMain.handle('setName', (_e, name: string) => boll?.setName(name));
  ipcMain.handle('pickFile', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
}

app.whenReady().then(() => {
  setupIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
