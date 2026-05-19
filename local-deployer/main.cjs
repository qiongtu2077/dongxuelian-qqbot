const { app, BrowserWindow, shell, dialog, ipcMain, clipboard } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

/** Same default as standalone dashboard; overridden by DASHBOARD_PORT env when set */
const DASHBOARD_PORT = String(process.env.DASHBOARD_PORT || '5150')

let dashboardProcess = null
let mainWindow = null
let appPaths = null
let isAppQuitting = false
let dashboardCrashCount = 0
let dashboardStartedAt = 0
let dashboardAbortFn = null
let dashboardAbortPromise = null

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

function getDashboardLogPath() {
  if (!appPaths) return ''
  const logsDir = path.join(appPaths.workspaceRoot, 'runtime', 'logs')
  try { fs.mkdirSync(logsDir, { recursive: true }) } catch {}
  return path.join(logsDir, 'dashboard-electron.log')
}

function getPidFilePath() {
  if (!appPaths) return ''
  const runtimeDir = path.join(appPaths.workspaceRoot, 'runtime')
  try { fs.mkdirSync(runtimeDir, { recursive: true }) } catch {}
  return path.join(runtimeDir, 'dashboard.pid')
}

function writeDashboardPid(pid) {
  const pidFile = getPidFilePath()
  if (!pidFile) return
  try { fs.writeFileSync(pidFile, String(pid), 'utf8') } catch {}
}

function removeDashboardPidFile() {
  const pidFile = getPidFilePath()
  if (!pidFile) return
  try { fs.unlinkSync(pidFile) } catch {}
}

function cleanStaleDashboardProcess() {
  const pidFile = getPidFilePath()
  if (!pidFile) return
  let pid
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) } catch { return }
  if (!pid || isNaN(pid)) return
  try {
    process.kill(pid, 0)
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch {}
  try { fs.unlinkSync(pidFile) } catch {}
}

function rotateDashboardLog() {
  const logPath = getDashboardLogPath()
  if (!logPath) return
  let stat
  try { stat = fs.statSync(logPath) } catch { return }
  if (stat.size > 5 * 1024 * 1024) {
    try { fs.unlinkSync(logPath) } catch {}
  }
}

function cleanupDashboardProcess() {
  const child = dashboardProcess
  dashboardProcess = null
  if (!child || child.killed) return
  const pid = child.pid
  try { child.removeAllListeners() } catch {}
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {}
  } else {
    try { child.kill() } catch {}
  }
  removeDashboardPidFile()
}

function checkPortOccupied(port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port: Number(port), host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false) })
  })
}

function showDiagnosticDialog(title, message, detail) {
  const logPath = getDashboardLogPath()
  const buttons = logPath ? ['复制日志路径', '确定'] : ['确定']
  const opts = { type: 'error', title, message, detail: detail + (logPath ? `\n\n诊断日志：${logPath}` : ''), buttons, defaultId: buttons.length - 1 }
  dialog.showMessageBox(mainWindow || undefined, opts).then(({ response }) => {
    if (logPath && response === 0) clipboard.writeText(logPath)
  }).catch(() => {})
}

function startDashboard(paths) {
  rotateDashboardLog()
  const standalone = path.join(paths.resourceRoot, 'packages', 'koishi-plugin-dashboard', 'standalone.js')
  const logPath = getDashboardLogPath()
  let logStream = null
  if (logPath) {
    try { logStream = fs.createWriteStream(logPath, { flags: 'a' }) } catch {}
  }
  const stdioOpt = logStream ? ['ignore', logStream, logStream] : 'ignore'
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
    stdio: stdioOpt,
    windowsHide: true,
  })
  dashboardStartedAt = Date.now()
  const child = dashboardProcess
  writeDashboardPid(child.pid)
  setTimeout(() => { if (dashboardProcess === child) dashboardCrashCount = 0 }, 60000)

  let abortFn = null
  dashboardAbortPromise = new Promise(resolve => { abortFn = resolve })
  dashboardAbortFn = abortFn

  child.on('error', (err) => {
    console.error('[dashboard-process] spawn error', err)
    if (dashboardProcess === child) dashboardProcess = null
    removeDashboardPidFile()
    if (abortFn) { abortFn(); abortFn = null }
    showDiagnosticDialog(
      '无法启动控制台',
      '仪表盘子进程未能启动。',
      String(err && err.message ? err.message : err),
    )
  })
  child.on('exit', (code, signal) => {
    if (dashboardProcess === child) dashboardProcess = null
    removeDashboardPidFile()
    try { child.removeAllListeners() } catch {}
    if (logStream) { try { logStream.end() } catch {} }
    const failed = typeof code === 'number' && code !== 0
    if (!failed || isAppQuitting) return
    if (abortFn) { abortFn(); abortFn = null }
    const uptime = Date.now() - dashboardStartedAt
    if (dashboardCrashCount === 0 && uptime > 3000) {
      dashboardCrashCount++
      console.log('[dashboard-process] crashed, auto-restarting once...')
      setTimeout(() => startDashboard(paths), 2000)
      return
    }
    dashboardCrashCount++
    const detailParts = []
    if (signal) detailParts.push(`信号: ${signal}`)
    detailParts.push(`退出码: ${code}`)
    detailParts.push(`运行时长: ${Math.round(uptime / 1000)}s`)
    if (dashboardCrashCount > 1) detailParts.push('已尝试自动重启 1 次仍失败')
    showDiagnosticDialog(
      '控制台进程已崩溃',
      `仪表盘后端进程非正常退出（退出码 ${code}）。`,
      detailParts.join('\n'),
    )
  })
}

/**
 * Poll until GET /dashboard/ responds, attempts exhausted, or aborted.
 * @param {string} portStr
 * @param {Promise} [abortPromise] resolves when spawn fails/crashes early
 * @returns {Promise<boolean>} true when server responds
 */
function waitForDashboardHttpReady(portStr, abortPromise) {
  const totalTimeoutMs = 30000
  const intervalMs = 500
  const perRequestTimeoutMs = 2000
  const pathPart = '/dashboard/'
  return new Promise(resolve => {
    let settled = false
    function settle(val) { if (!settled) { settled = true; resolve(val) } }
    if (abortPromise) abortPromise.then(() => settle(false))
    const startTime = Date.now()
    function elapsed() { return Date.now() - startTime }
    function scheduleRetry() {
      if (settled) return
      if (elapsed() >= totalTimeoutMs) { settle(false); return }
      setTimeout(doAttempt, intervalMs)
    }
    function doAttempt() {
      if (settled) return
      if (elapsed() >= totalTimeoutMs) { settle(false); return }
      const req = http.get(
        { hostname: '127.0.0.1', port: portStr, path: pathPart, timeout: perRequestTimeoutMs },
        res => {
          try { res.resume() } catch {}
          if (res.statusCode >= 200 && res.statusCode < 400) settle(true)
          else scheduleRetry()
        },
      )
      req.on('error', scheduleRetry)
      req.on('timeout', () => { try { req.destroy() } catch {}; scheduleRetry() })
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  const ready = await waitForDashboardHttpReady(DASHBOARD_PORT, dashboardAbortPromise)
  if (!ready) {
    const occupied = await checkPortOccupied(DASHBOARD_PORT)
    const logPath = getDashboardLogPath()
    let detail = ''
    if (occupied) {
      detail = `端口 ${DASHBOARD_PORT} 已被其他程序占用，仪表盘无法启动。\n请关闭占用该端口的程序后重试，或设置环境变量 DASHBOARD_PORT=其他端口 后重新打开部署器。`
    } else {
      detail = [
        `仪表盘在 30 秒内未响应（本地端口 ${DASHBOARD_PORT}）。`,
        '',
        '可能原因：',
        '· 首次启动初始化较慢，可重新打开部署器重试',
        '· 防火墙或安全软件拦截了本地端口',
        '· 仪表盘进程启动时发生错误',
      ].join('\n')
    }
    if (logPath) detail += `\n\n诊断日志：${logPath}`
    const buttons = logPath ? ['复制日志路径', '退出'] : ['退出']
    dialog.showMessageBox({ type: 'error', title: occupied ? '端口被占用' : '控制台启动超时', message: occupied ? `端口 ${DASHBOARD_PORT} 被占用` : '仪表盘未能在规定时间内启动', detail, buttons, defaultId: buttons.length - 1 }).then(({ response }) => {
      if (logPath && response === 0) clipboard.writeText(logPath)
    }).catch(() => {})
    win.destroy()
    return
  }
  try {
    await win.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/dashboard/`)
  } catch {
    showDiagnosticDialog(
      '加载失败',
      '仪表盘页面未能加载。',
      `请求地址：http://127.0.0.1:${DASHBOARD_PORT}/dashboard/\n请检查本地服务是否正常。`,
    )
    win.destroy()
    return
  }
  mainWindow = win
  win.show()
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
    if (!value) return 'empty path'
    const resolved = path.resolve(value)
    const roots = [appPaths.workspaceRoot, appPaths.resourceRoot].filter(Boolean)
    const allowed = roots.some(root => {
      const r = path.resolve(root)
      return resolved === r || resolved.startsWith(r + path.sep)
    })
    if (!allowed) return 'blocked'
    shell.showItemInFolder(resolved)
    return 'ok'
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

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(async () => {
    appPaths = resolveAppPaths()
    registerIpc()
    cleanStaleDashboardProcess()
    await new Promise(r => setTimeout(r, 2000))
    const portBusy = await checkPortOccupied(DASHBOARD_PORT)
    if (portBusy) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: '端口被占用',
        message: `端口 ${DASHBOARD_PORT} 已被其他程序占用`,
        detail: `仪表盘需要使用本地端口 ${DASHBOARD_PORT}，但该端口已被占用。\n\n解决方法：\n· 关闭占用该端口的程序后重试\n· 或设置环境变量 DASHBOARD_PORT=其他端口 后重新打开部署器`,
        buttons: ['复制提示', '退出'],
        defaultId: 1,
      })
      if (response === 0) clipboard.writeText(`端口 ${DASHBOARD_PORT} 被占用。关闭占用进程或设置 DASHBOARD_PORT=其他端口`)
      app.quit()
      return
    }
    startDashboard(appPaths)
    void createWindow()
    setTimeout(setupAutoUpdater, 5000)
    if (appPaths.fallbackReason) {
      setTimeout(() => dialog.showMessageBox(mainWindow || undefined, { type: 'warning', title: '部署器工作目录已切换', message: appPaths.fallbackReason, detail: '建议把部署器完整解压到可写目录后，再运行。' }).catch(() => {}), 1500)
    }
  })
}

function setupAutoUpdater() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: '发现新版本',
      message: `新版本 v${info.version} 可用，是否下载更新？`,
      buttons: ['下载更新', '稍后再说'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate()
    }).catch(() => {})
  })
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progress.percent / 100)
    }
  })
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成，重启应用即可完成更新。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    }).catch(() => {})
  })
  autoUpdater.on('error', (err) => {
    const msg = err?.message || String(err)
    if (/net::ERR_|ENOTFOUND|ECONNREFUSED|404/.test(msg)) return
    console.error('[autoUpdater]', msg)
  })
  autoUpdater.checkForUpdates().catch(() => {})
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  isAppQuitting = true
  cleanupDashboardProcess()
})
