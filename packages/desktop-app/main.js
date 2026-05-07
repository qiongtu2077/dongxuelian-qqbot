const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, session, ipcMain } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')
const http = require('http')

let mainWindow = null
let tray = null
let serverProcess = null
const PORT = 5150
const DASHBOARD_URL = `http://localhost:${PORT}/dashboard/`

// 释放指定端口：杀死占用该端口的进程
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { timeout: 3000, encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split('\n')) {
        const m = line.trim().match(/(\d+)\s*$/)
        if (m) pids.add(m[1])
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { timeout: 2000, stdio: 'ignore' }) } catch {}
      }
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { timeout: 3000, stdio: 'ignore' })
    }
  } catch {}
}

// 查找 standalone.js
function findStandalone() {
  const candidates = [
    path.join(__dirname, '..', 'koishi-plugin-dashboard', 'standalone.js'),
    path.join(__dirname, '..', '..', 'packages', 'koishi-plugin-dashboard', 'standalone.js'),
    path.join(__dirname, '..', 'dashboard', 'standalone.js'),
    path.join(__dirname, 'resources', 'dashboard', 'standalone.js'),
  ]
  for (const p of candidates) {
    try { if (require('fs').statSync(p).isFile()) return p } catch {}
  }
  return null
}

// 启动 standalone.js
function startServer(callback) {
  const scriptPath = findStandalone()
  if (!scriptPath) {
    dialog.showErrorBox('启动失败', '找不到 standalone.js')
    app.quit()
    return
  }

  // 确保端口未被旧进程占用
  killPort(PORT)
  // 等端口释放
  try { execSync(process.platform === 'win32' ? 'ping -n 2 127.0.0.1 >nul' : 'sleep 1', { timeout: 2000, stdio: 'ignore' }) } catch {}

  const env = { ...process.env, DASHBOARD_PORT: String(PORT), GLOBAL_LOCAL_MODE: 'true', ELECTRON_RUN_AS_NODE: '1' }
  // 便携版或打包版用独立数据目录
  if (app.isPackaged || !require('fs').existsSync(path.join(scriptPath, '..', '..', 'koishi-plugin-dongxuelian-ai'))) {
    const dataDir = path.join(app.getPath('userData'), 'data')
    try { require('fs').mkdirSync(dataDir, { recursive: true }) } catch {}
    env.DONGXUELIAN_AI_DATA_DIR = dataDir
  }

  serverProcess = spawn(process.execPath, [scriptPath], {
    env,
    cwd: path.dirname(scriptPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout.on('data', d => console.log('[dashboard]', d.toString().trim()))
  serverProcess.stderr.on('data', d => console.error('[dashboard]', d.toString().trim()))
  serverProcess.on('exit', (code) => {
    console.log('[dashboard] process exited:', code)
    serverProcess = null
  })

  // 轮询等待服务器就绪
  let attempt = 0
  const poll = () => {
    attempt++
    const req = http.get(`http://localhost:${PORT}/dashboard/api/status`, (res) => {
      res.resume()
      callback()
    })
    req.on('error', () => {
      if (attempt > 30) {
        console.error('[dashboard] timeout: server did not start')
        dialog.showErrorBox('启动超时', 'Dashboard 服务未能启动')
        return
      }
      setTimeout(poll, 500)
    })
    req.end()
  }
  setTimeout(poll, 300)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '莲莲 Bot 控制台',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0f1923',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL(DASHBOARD_URL)
  // ready-to-show 依赖外部 CDN 可能卡死，不等了
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) return
    mainWindow.show()
  })

  // 关窗不退出
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

let currentMode = 'local'
let remoteServer = ''

// IPC: 导航到指定 URL
ipcMain.on('navigate', (_event, url) => {
  if (mainWindow) {
    mainWindow.loadURL(url)
    mainWindow.setTitle('莲莲 Bot 控制台 - ' + url)
  }
})

// IPC: 切换本地/远程模式
ipcMain.on('switch-mode', (_event, mode) => {
  currentMode = mode
  if (!mainWindow) return
  if (mode === 'local') {
    mainWindow.loadURL(DASHBOARD_URL)
    mainWindow.setTitle('莲莲 Bot 控制台')
  } else if (mode === 'remote' && remoteServer) {
    const url = `http://${remoteServer}:5150/dashboard/`
    mainWindow.loadURL(url)
    mainWindow.setTitle('莲莲 Bot 控制台 - 远程 [' + remoteServer + ']')
  }
})

// IPC: 设置远程服务器地址
ipcMain.on('set-remote', (_event, server) => {
  remoteServer = server.replace(/^root@/, '').replace(/:.*$/, '')
})

function createTray() {
  // 16x16 空图标（后续可替换）
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('莲莲 Bot 控制台')

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示控制台', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    {
      label: '回到本地模式',
      click: () => {
        if (mainWindow) {
          currentMode = 'local'
          mainWindow.loadURL(DASHBOARD_URL)
          mainWindow.setTitle('莲莲 Bot 控制台')
        }
      },
    },
    {
      label: '重启服务',
      click: () => {
        if (serverProcess) { serverProcess.kill(); serverProcess = null }
        startServer(() => {
          if (mainWindow) mainWindow.loadURL(DASHBOARD_URL)
        })
      },
    },
    { type: 'separator' },
    {
      label: '关于',
      click: () => {
        dialog.showMessageBox({ type: 'info', title: '关于', message: '莲莲 Bot 控制台 v1.0.0' })
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.isQuitting = true; if (serverProcess) serverProcess.kill(); app.quit() },
    },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

app.whenReady().then(() => {
  // 拦截 Google Fonts CDN 避免页面渲染被阻塞
  session.defaultSession.webRequest.onBeforeRequest({ urls: [
    'https://fonts.googleapis.com/*',
    'https://fonts.gstatic.com/*',
  ]}, (details, callback) => {
    callback({ cancel: true })
  })

  startServer(() => {
    createWindow()
    createTray()
  })
})

app.on('window-all-closed', () => {})
app.on('before-quit', () => { if (serverProcess) serverProcess.kill() })
