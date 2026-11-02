// Exposes a tiny, safe API to the web app as window.enotesDesktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enotesDesktop', {
  platform: process.platform,
  saveFile: (name, data) => ipcRenderer.invoke('save-file', { name, data }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onDeepLink: (cb) => ipcRenderer.on('deep-link', (_e, url) => cb(url)),
  onOpenPdfs: (cb) => ipcRenderer.on('open-pdfs', (_e, files) => cb(files)),
});
