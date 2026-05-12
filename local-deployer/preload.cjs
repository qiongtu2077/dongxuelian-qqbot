const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dongxuelianDeployer', {
  platform: process.platform,
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath || ''),
  openExternal: (url) => ipcRenderer.invoke('open-external', url || ''),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath || ''),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('show-item-in-folder', targetPath || ''),
  copyText: (text) => ipcRenderer.invoke('copy-text', text || ''),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
})
