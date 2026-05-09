const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dongxuelianDeployer', {
  platform: process.platform,
})
