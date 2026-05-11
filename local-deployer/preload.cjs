const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dongxuelianDeployer', {
  platform: process.platform,
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath || ''),
})
