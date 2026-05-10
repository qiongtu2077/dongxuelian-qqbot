const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

let dashboardProcess = null

function resolveAppRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app')
  return path.resolve(__dirname, '..')
}

function startDashboard(appRoot) {
  const standalone = path.join(appRoot, 'packages', 'koishi-plugin-dashboard', 'standalone.js')
  dashboardProcess = spawn(process.execPath, [standalone], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GLOBAL_LOCAL_MODE: '1', KOISHI_DIR: appRoot, DASHBOARD_PORT: process.env.DASHBOARD_PORT || '5150' },
    stdio: 'ignore',
    windowsHide: true,
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: '莲莲Bot部署器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL('http://127.0.0.1:5150/dashboard/')
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  const appRoot = resolveAppRoot()
  startDashboard(appRoot)
  setTimeout(createWindow, 900)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (dashboardProcess && !dashboardProcess.killed) dashboardProcess.kill()
})
