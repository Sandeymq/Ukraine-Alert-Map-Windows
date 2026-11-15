'use strict';
// Міст між інтерфейсом і головним процесом: лише потрібні дії, без доступу до Node.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('uaw:info');

contextBridge.exposeInMainWorld('uawHost', {
  info,
  mediaDir: info.mediaDir,
  ready: () => ipcRenderer.send('uaw:ready'),
  onOutput: (cb) => ipcRenderer.on('uaw:output', (_e, text) => cb(text)),
  onStream: (cb) => ipcRenderer.on('uaw:stream', (_e, msg) => cb(msg)),
  onMaterial: (cb) => ipcRenderer.on('uaw:material', (_e, m) => cb(m)),
  streamStart: () => ipcRenderer.send('uaw:stream-start'),
  streamStop: () => ipcRenderer.send('uaw:stream-stop'),
  get: (url) => ipcRenderer.invoke('uaw:get', url),
  notify: (title, body) => ipcRenderer.send('uaw:notify', { title, body }),
  openExternal: (url) => ipcRenderer.send('uaw:open', url),
  resize: (w, h) => ipcRenderer.send('uaw:resize', { w, h }),
  setZoom: (z) => ipcRenderer.send('uaw:zoom', z),
  hide: () => ipcRenderer.send('uaw:hide')
});
