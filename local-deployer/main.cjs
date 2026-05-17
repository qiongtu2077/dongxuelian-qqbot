const { app, BrowserWindow, shell, dialog, ipcMain, clipboard } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

/** Same default as standalone dashboard; overridden by DASHBOARD_PORT env when set */
const DASHBOARD_PORT = String(process.env.DASHBOARD_PORT || '5150')

let dashboardProcess = null
let mainWindow = null
let appPaths = null
let isAppQuitting = false

function resolveResourceRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..')
}

function resolveExecutableDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  if (process.env.PORTABLE_EXECUTABLE_FILE) return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE)
  return path.dirname(process.execPath)
}

function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.write-test-' + Date.now().toString(36))
  fs.writeFileSync(probe, 'ok', 'utf8')
  fs.unlinkSync(probe)
}

function resolveAppPaths() {
  const resourceRoot = resolveResourceRoot()
  if (!app.isPackaged) return { resourceRoot, workspaceRoot: resourceRoot, fallbackReason: '' }
  const preferredRoot = path.join(resolveExecutableDir(), 'LianLianBOT')
  try {
    ensureWritableDir(resolveExecutableDir())
    return { resourceRoot, workspaceRoot: preferredRoot, fallbackReason: '' }
  } catch (e) {
    const fallbackRoot = path.join(app.getPath('userData'), 'LianLianBOT')
    return { resourceRoot, workspaceRoot: fallbackRoot, fallbackReason: `EXE 所在目录不可写，已改用用户数据目录：${e.message}` }
  }
}

function cleanupDashboardProcess() {
  const child = dashboardProcess
  dashboardProcess = null
  if (!child || child.killed) return
  try {
    child.removeAllListeners()
  } catch {}
  try {
    child.kill()
  } catch {}
}

function startDashboard(paths) {
  const standalone = path.join(paths.resourceRoot, 'packages', 'koishi-plugin-dashboard', 'standalone.js')
  dashboardProcess = spawn(process.execPath, [standalone], {
    cwd: paths.resourceRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GLOBAL_LOCAL_MODE: '1',
      LIANLIAN_PACKAGED: app.isPackaged ? '1' : '0',
      LIANLIAN_RESOURCE_ROOT: paths.resourceRoot,
      LIANLIAN_WORKSPACE_ROOT: paths.workspaceRoot,
      LIANLIAN_WORKSPACE_FALLBACK_REASON: paths.fallbackReason || '',
      KOISHI_DIR: paths.workspaceRoot,
      DONGXUELIAN_AI_DATA_DIR: path.join(paths.workspaceRoot, 'data'),
      DASHBOARD_PORT,
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  const child = dashboardProcess
  child.on('error', (err) => {
    console.error('[dashboard-process] spawn error', err)
    if (dashboardProcess === child) dashboardProcess = null
    dialog.showMessageBox({
      type: 'error',
      title: '无法启动控制台',
      message: '仪表盘子进程未能启动。',
      detail: String(err && err.message ? err.message : err),
    })
  })
  child.on('exit', (code, signal) => {
    if (dashboardProcess === child) dashboardProcess = null
    try {
      child.removeAllListeners()
    } catch {}
    const failed = typeof code === 'number' && code !== 0
    if (failed && !isAppQuitting) {
      const detailParts = []
      if (signal) detailParts.push(`signal=${signal}`)
      detailParts.push(`exit=${code}`)
      dialog.showMessageBox({
        type: 'error',
        title: '控制台进程已崩溃',
        message: `仪表盘后端进程非正常退出（退出码 ${code}）。`,
        detail: detailParts.join('\n'),
      })
    }
  })
}

/**
 * Poll until GET /dashboard/ responds or attempts exhausted.
 * @returns {Promise<boolean>} true when server responds
 */
function waitForDashboardHttpReady(portStr) {
  const maxAttempts = 20
  const intervalMs = 500
  const pathPart = '/dashboard/'
  return new Promise(resolve => {
    let attemptsUsed = 0
    function scheduleRetry() {
      if (attemptsUsed >= maxAttempts) {
        resolve(false)
        return
      }
      setTimeout(doAttempt, intervalMs)
    }
    function doAttempt() {
      if (attemptsUsed >= maxAttempts) {
        resolve(false)
        return
      }
      attemptsUsed += 1
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: portStr,
          path: pathPart,
          timeout: intervalMs + 4000,
        },
        res => {
          try {
            res.resume()
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 500) resolve(true)
          else scheduleRetry()
        },
      )
      req.on('error', scheduleRetry)
      req.on('timeout', () => {
        try {
          req.destroy()
        } catch {}
        scheduleRetry()
      })
    }
    doAttempt()
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: 'LianBoard Windows 部署器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  const ready = await waitForDashboardHttpReady(DASHBOARD_PORT)
  if (!ready) {
    dialog.showErrorBox(
      '控制台未就绪',
      '在十秒内未能连上仪表盘服务（本地端口 ' + DASHBOARD_PORT + '）。请稍后重试或检查是否被防火墙拦截。',
    )
    return
  }
  win.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/`)
}

function registerIpc() {
  ipcMain.handle('select-directory', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 NapCat 安装目录',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return ''
    return result.filePaths[0]
  })
  ipcMain.handle('open-external', async (_event, url) => {
    const value = String(url || '').trim()
    if (!/^https?:\/\//i.test(value) && !/^mailto:/i.test(value)) return false
    await shell.openExternal(value)
    return true
  })
  ipcMain.handle('open-path', (_, p) => {
    const resolved = path.resolve(p)
    const roots = [appPaths.workspaceRoot, appPaths.resourceRoot].filter(Boolean)
    const allowed = roots.some(root => {
      const r = path.resolve(root)
      return resolved === r || resolved.startsWith(r + path.sep)
    })
    if (!allowed) return 'blocked'
    return shell.openPath(resolved)
  })
  ipcMain.handle('show-item-in-folder', async (_event, targetPath) => {
    const value = String(targetPath || '').trim()
    if (!value) return false
    shell.showItemInFolder(value)
    return true
  })
  ipcMain.handle('copy-text', async (_event, text) => {
    clipboard.writeText(String(text || ''))
    return true
  })
  ipcMain.handle('get-app-info', async () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    resourceRoot: appPaths?.resourceRoot || '',
    workspaceRoot: appPaths?.workspaceRoot || '',
    fallbackReason: appPaths?.fallbackReason || '',
    userData: app.getPath('userData'),
  }))
}

app.whenReady().then(() => {
  appPaths = resolveAppPaths()
  registerIpc()
  startDashboard(appPaths)
  void createWindow()
  if (appPaths.fallbackReason) {
    setTimeout(() => dialog.showMessageBox(mainWindow, { type: 'warning', title: '部署器工作目录已切换', message: appPaths.fallbackReason, detail: '建议把部署器 ZIP 完整解压到可写目录后，再运行 EXE。' }).catch(() => {}), 1500)
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  isAppQuitting = true
  cleanupDashboardProcess()
})
