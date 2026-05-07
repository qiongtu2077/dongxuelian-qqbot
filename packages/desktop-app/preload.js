const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  navigate: (url) => ipcRenderer.send('navigate', url),
  switchMode: (mode) => ipcRenderer.send('switch-mode', mode),
  setRemote: (server) => ipcRenderer.send('set-remote', server),
})
