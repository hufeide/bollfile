/**
 * preload.ts — 仅向渲染进程暴露最小、安全的 API (contextIsolation)
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  start: (role: string, name: string) => ipcRenderer.invoke('start', role, name),
  joinRoom: (code: string) => ipcRenderer.invoke('joinRoom', code),
  getPublicKey: () => ipcRenderer.invoke('getPublicKey'),
  getPeers: () => ipcRenderer.invoke('getPeers'),
  sendMessage: (pk: string, text: string) => ipcRenderer.invoke('sendMessage', pk, text),
  sendFile: (pk: string, filePath: string) => ipcRenderer.invoke('sendFile', pk, filePath),
  acceptFile: (id: string) => ipcRenderer.invoke('acceptFile', id),
  rejectFile: (id: string) => ipcRenderer.invoke('rejectFile', id),
  setName: (name: string) => ipcRenderer.invoke('setName', name),
  pickFile: () => ipcRenderer.invoke('pickFile'),
  onEvent: (cb: (payload: any) => void) => {
    ipcRenderer.on('app-event', (_ev, payload) => cb(payload));
  },
});
