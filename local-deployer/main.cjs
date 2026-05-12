const { app, BrowserWindow, shell, dialog, ipcMain, clipboard } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

let dashboardProcess = null
let mainWindow = null
let appPaths = null

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

function copyResource(sourceRoot, targetRoot, relativePath, options = {}) {
  const source = path.join(sourceRoot, relativePath)
  const target = path.join(targetRoot, relativePath)
  if (!fs.existsSync(source)) return
  if (options.replace) fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: true })
}

function syncWorkspace(resourceRoot, workspaceRoot) {
  ensureWritableDir(workspaceRoot)
  for (const dir of ['packages', 'scripts']) copyResource(resourceRoot, workspaceRoot, dir, { replace: true })
  for (const file of ['package.json', 'package-lock.json', 'start.js', 'koishi.example.yml']) copyResource(resourceRoot, workspaceRoot, file, { replace: true })
  for (const dir of ['data', 'runtime', path.join('runtime', 'downloads'), path.join('runtime', 'logs'), path.join('runtime', 'napcat')]) {
    fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(workspaceRoot, '.lianlian-workspace.json'), JSON.stringify({
    version: app.getVersion(),
    resourceRoot,
    workspaceRoot,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
}

function resolveAppPaths() {
  const resourceRoot = resolveResourceRoot()
  if (!app.isPackaged) return { resourceRoot, workspaceRoot: resourceRoot, fallbackReason: '' }
  const preferredRoot = path.join(resolveExecutableDir(), 'LianLianBOT')
  try {
    syncWorkspace(resourceRoot, preferredRoot)
    return { resourceRoot, workspaceRoot: preferredRoot, fallbackReason: '' }
  } catch (e) {
    const fallbackRoot = path.join(app.getPath('userData'), 'LianLianBOT')
    syncWorkspace(resourceRoot, fallbackRoot)
    return { resourceRoot, workspaceRoot: fallbackRoot, fallbackReason: `EXE 所在目录不可写，已改用用户数据目录：${e.message}` }
  }
}

function startDashboard(paths) {
  const standalone = path.join(paths.workspaceRoot, 'packages', 'koishi-plugin-dashboard', 'standalone.js')
  dashboardProcess = spawn(process.execPath, [standalone], {
    cwd: paths.workspaceRoot,
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
      DASHBOARD_PORT: process.env.DASHBOARD_PORT || '5150',
    },
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
    title: 'LianBoard Windows 部署器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.loadURL('http://127.0.0.1:5150/dashboard/')
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
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
  ipcMain.handle('open-path', async (_event, targetPath) => {
    const value = String(targetPath || '').trim()
    if (!value) return 'empty path'
    return shell.openPath(value)
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
  setTimeout(createWindow, 900)
  if (appPaths.fallbackReason) {
    setTimeout(() => dialog.showMessageBox(mainWindow, { type: 'warning', title: '部署器工作目录已切换', message: appPaths.fallbackReason, detail: '建议把部署器 ZIP 完整解压到可写目录后，再运行 EXE。' }).catch(() => {}), 1500)
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (dashboardProcess && !dashboardProcess.killed) dashboardProcess.kill()
})
