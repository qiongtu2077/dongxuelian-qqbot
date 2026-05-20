'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const DEFAULT_DASHBOARD_PORT = '5150'
const DASHBOARD_PID_MAX_AGE_MS = 7 * 24 * 3600 * 1000
const WORKSPACE_DIR_NAME = 'LianLianBOT'

// --- 路径解析 --- #

/** Resolve the app resource root for packaged and development launches. */
function resolveResourceRoot(options = {}) {
  const isPackaged = !!options.isPackaged
  const appDir = options.appDir || __dirname
  if (isPackaged) return path.join(options.resourcesPath || path.dirname(process.execPath), 'app')
  return path.resolve(appDir, '..')
}

/** Resolve the directory that contains the portable executable. */
function resolveExecutableDir(env = process.env, execPath = process.execPath) {
  const portableDir = String(env.PORTABLE_EXECUTABLE_DIR || '').trim()
  if (portableDir) return path.resolve(portableDir)
  const portableFile = String(env.PORTABLE_EXECUTABLE_FILE || '').trim()
  if (portableFile) return path.dirname(path.resolve(portableFile))
  return path.dirname(path.resolve(execPath))
}

/** Trim trailing separators while preserving the filesystem root. */
function trimTrailingSeparators(value) {
  let result = String(value || '')
  const parsed = path.parse(result)
  while (result.length > parsed.root.length && /[\\/]$/.test(result)) result = result.slice(0, -1)
  return result
}

/** Normalize a path for equality/prefix comparisons on the current platform. */
function normalizePathForCompare(value, platform = process.platform) {
  const resolved = trimTrailingSeparators(path.resolve(String(value || '')))
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Check whether two paths refer to the same location under case-aware rules. */
function isSamePathCaseAware(left, right, platform = process.platform) {
  return normalizePathForCompare(left, platform) === normalizePathForCompare(right, platform)
}

/** Check whether target is root or a descendant of root with Windows case handling. */
function isInsidePathCaseAware(root, target, platform = process.platform) {
  const normalizedRoot = normalizePathForCompare(root, platform)
  const normalizedTarget = normalizePathForCompare(target, platform)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)
}

/** Resolve deployer resource, workspace, and Electron runtime-state paths. */
function resolveAppPaths(options = {}) {
  const resourceRoot = path.resolve(options.resourceRoot || process.cwd())
  const executableDir = path.resolve(options.executableDir || resolveExecutableDir())
  const distribution = options.distribution || (options.isPackaged ? 'installed' : 'source')
  if (!options.isPackaged) {
    return {
      resourceRoot,
      workspaceRoot: resourceRoot,
      runtimeStateRoot: resourceRoot,
      executableDir,
      distribution,
      standalonePath: resolveStandalonePath(resourceRoot),
      fallbackReason: '',
    }
  }
  const userDataPath = path.resolve(options.userDataPath || executableDir)
  const workspaceRoot = path.resolve(options.workspaceRoot || (
    distribution === 'portable'
      ? path.join(executableDir, WORKSPACE_DIR_NAME)
      : path.join(options.documentsPath || executableDir, WORKSPACE_DIR_NAME)
  ))
  return {
    resourceRoot,
    workspaceRoot,
    runtimeStateRoot: userDataPath,
    executableDir,
    distribution,
    standalonePath: resolveStandalonePath(resourceRoot),
    fallbackReason: options.fallbackReason || '',
  }
}

/** Resolve the standalone Dashboard entry within a resource root. */
function resolveStandalonePath(resourceRoot) {
  return path.join(path.resolve(resourceRoot), 'packages', 'koishi-plugin-dashboard', 'standalone.js')
}

/** Resolve the Electron-owned Dashboard log path. */
function getDashboardLogPath(appPaths) {
  if (!appPaths || !appPaths.runtimeStateRoot) return ''
  return path.join(path.resolve(appPaths.runtimeStateRoot), 'runtime', 'logs', 'dashboard-electron.log')
}

/** Resolve the Electron-owned Dashboard pid file path. */
function getDashboardPidFilePath(appPaths) {
  if (!appPaths || !appPaths.runtimeStateRoot) return ''
  return path.join(path.resolve(appPaths.runtimeStateRoot), 'runtime', 'dashboard.pid')
}

/** Ensure the parent directory exists for a file path. */
function ensureParentDir(filePath) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

// --- 端口与弹窗 --- #

/** Parse DASHBOARD_PORT into a safe TCP port string. */
function parseDashboardPort(value, fallback = DEFAULT_DASHBOARD_PORT) {
  const raw = String(value || '').trim()
  const fallbackPort = Number(fallback)
  const normalizedFallback = Number.isInteger(fallbackPort) && fallbackPort >= 1 && fallbackPort <= 65535
    ? String(fallbackPort)
    : DEFAULT_DASHBOARD_PORT
  if (!raw) return normalizedFallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return normalizedFallback
  return String(port)
}

/** Return a usable BrowserWindow owner or undefined. */
function getUsableDialogOwner(owner) {
  if (!owner) return undefined
  if (typeof owner.isDestroyed === 'function' && owner.isDestroyed()) return undefined
  return owner
}

/** Show an Electron message box without letting dialog errors escape. */
function showMessageBoxSafe(dialogModule, owner, options) {
  const fallbackResponse = Number.isInteger(options?.defaultId) ? options.defaultId : 0
  try {
    const safeOwner = getUsableDialogOwner(owner)
    const promise = safeOwner
      ? dialogModule.showMessageBox(safeOwner, options)
      : dialogModule.showMessageBox(options)
    return Promise.resolve(promise).catch(() => ({ response: fallbackResponse }))
  } catch {
    return Promise.resolve({ response: fallbackResponse })
  }
}

// --- Dashboard pid 身份校验 --- #

/** Build the persisted Dashboard pid record. */
function createDashboardPidRecord(options = {}) {
  const pid = Number(options.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    pid,
    resourceRoot: path.resolve(options.resourceRoot || ''),
    workspaceRoot: path.resolve(options.workspaceRoot || ''),
    standalonePath: path.resolve(options.standalonePath || resolveStandalonePath(options.resourceRoot || '')),
    createdAt: new Date(options.createdAt || Date.now()).toISOString(),
  }
}

/** Persist a Dashboard pid record as JSON. */
function writeDashboardPidFile(pidFilePath, record) {
  if (!pidFilePath || !record) return false
  ensureParentDir(pidFilePath)
  fs.writeFileSync(pidFilePath, JSON.stringify(record, null, 2), 'utf8')
  return true
}

/** Read either the current JSON pid record or a legacy raw-pid file. */
function readDashboardPidFile(pidFilePath) {
  if (!pidFilePath) return null
  const raw = fs.readFileSync(pidFilePath, 'utf8').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return { pid: Number(raw), legacy: true }
  const parsed = JSON.parse(raw)
  return {
    pid: Number(parsed.pid),
    resourceRoot: parsed.resourceRoot ? path.resolve(parsed.resourceRoot) : '',
    workspaceRoot: parsed.workspaceRoot ? path.resolve(parsed.workspaceRoot) : '',
    standalonePath: parsed.standalonePath ? path.resolve(parsed.standalonePath) : '',
    createdAt: parsed.createdAt || parsed.ts || '',
    legacy: false,
  }
}

/** Remove a pid file and suppress stale-file errors. */
function removePidFile(pidFilePath) {
  try {
    if (pidFilePath) fs.unlinkSync(pidFilePath)
    return true
  } catch {
    return false
  }
}

/** Check whether a pid record belongs to the current deployer paths. */
function isDashboardPidRecordCurrent(record, appPaths, platform = process.platform) {
  if (!record || !appPaths) return false
  if (record.resourceRoot && !isSamePathCaseAware(record.resourceRoot, appPaths.resourceRoot, platform)) return false
  if (record.workspaceRoot && !isSamePathCaseAware(record.workspaceRoot, appPaths.workspaceRoot, platform)) return false
  if (record.standalonePath && !isSamePathCaseAware(record.standalonePath, appPaths.standalonePath, platform)) return false
  return true
}

/** Normalize command-line text before path matching. */
function normalizeCommandLine(value, platform = process.platform) {
  const text = String(value || '').replace(/\0/g, ' ').trim()
  return platform === 'win32' ? text.toLowerCase() : text
}

/** Check whether a command line points at the expected standalone Dashboard. */
function isDashboardCommandLine(commandLine, standalonePath, platform = process.platform) {
  const normalized = normalizeCommandLine(commandLine, platform)
  if (!/\bstandalone\.js\b/i.test(normalized)) return false
  const expected = platform === 'win32'
    ? path.resolve(standalonePath).toLowerCase()
    : path.resolve(standalonePath)
  return normalized.includes(expected)
}

/** Query a process command line on Windows via CIM or on Unix via /proc. */
function getProcessCommandLine(pid, platform = process.platform) {
  const processId = Number(pid)
  if (!Number.isInteger(processId) || processId <= 0) return ''
  if (platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction SilentlyContinue`,
      'if ($p) { [Console]::Write([string]$p.CommandLine) }',
    ].join('; ')
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      }).trim()
    } catch {
      return ''
    }
  }
  try {
    return fs.readFileSync(`/proc/${processId}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    return ''
  }
}

/** Check whether a pid currently resolves to a live process. */
function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove stale Dashboard pid files and kill only identity-confirmed Dashboards. */
function cleanupStaleDashboardPid(options = {}) {
  const pidFilePath = options.pidFilePath
  let record
  try {
    record = readDashboardPidFile(pidFilePath)
  } catch {
    return { killed: false, removedPidFile: false, reason: 'unreadable-pid-file' }
  }
  const pid = Number(record?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, removedPidFile: false, reason: 'invalid-pid' }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DASHBOARD_PID_MAX_AGE_MS
  const createdMs = Number(record.createdAt) || Date.parse(record.createdAt || '')
  if (createdMs && nowMs - createdMs > maxAgeMs) {
    removePidFile(pidFilePath)
    return { killed: false, removedPidFile: true, reason: 'expired-pid-file', pid }
  }

  const platform = options.platform || process.platform
  if (!isDashboardPidRecordCurrent(record, options.appPaths, platform)) {
    removePidFile(pidFilePath)
    return { killed: false, removedPidFile: true, reason: 'record-mismatch', pid }
  }

  const exists = options.processExists || processExists
  if (!exists(pid)) {
    removePidFile(pidFilePath)
    return { killed: false, removedPidFile: true, reason: 'process-not-running', pid }
  }

  const getCommandLine = options.getProcessCommandLine || getProcessCommandLine
  const commandLine = getCommandLine(pid, platform)
  if (!isDashboardCommandLine(commandLine, options.appPaths.standalonePath, platform)) {
    removePidFile(pidFilePath)
    return { killed: false, removedPidFile: true, reason: 'command-mismatch', pid }
  }

  const killProcessTree = options.killProcessTree
  if (typeof killProcessTree === 'function') killProcessTree(pid)
  removePidFile(pidFilePath)
  return { killed: true, removedPidFile: true, reason: 'killed-dashboard', pid }
}

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  DASHBOARD_PID_MAX_AGE_MS,
  WORKSPACE_DIR_NAME,
  resolveResourceRoot,
  resolveExecutableDir,
  resolveAppPaths,
  resolveStandalonePath,
  getDashboardLogPath,
  getDashboardPidFilePath,
  ensureParentDir,
  parseDashboardPort,
  showMessageBoxSafe,
  isSamePathCaseAware,
  isInsidePathCaseAware,
  createDashboardPidRecord,
  writeDashboardPidFile,
  readDashboardPidFile,
  removePidFile,
  isDashboardPidRecordCurrent,
  isDashboardCommandLine,
  getProcessCommandLine,
  processExists,
  cleanupStaleDashboardPid,
}
