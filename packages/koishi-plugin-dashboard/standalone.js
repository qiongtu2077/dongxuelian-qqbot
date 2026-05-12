#!/usr/bin/env node
/**
 * Dashboard 独立服务器
 * 不依赖 koishi，独立进程运行在 5150 端口
 * 用法: node standalone.js &
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const os = require('os')
const { execSync, exec, execFileSync, spawn } = require('child_process')

// ====== 全局异常兜底（防止单请求崩溃整个进程） ======
process.on('uncaughtException', (err) => {
  console.error('[dashboard] UNCAUGHT EXCEPTION:', err.stack || err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[dashboard] UNHANDLED REJECTION:', reason?.stack || reason)
})

const MAX_BODY_SIZE = 16 * 1024 * 1024 // 16MB，请求体包含图集上传的 base64 图片

function collectBody(req, res, callback) {
  let body = ''
  req.on('data', c => {
    body += c
    if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: '请求体过大' }))
      req.destroy()
      return
    }
  })
  req.on('end', () => callback(body))
}

// ====== 路径配置 ======
const PLUGIN_ROOT = __dirname
const AI_LIB = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'lib')
const KOISHI_DIR = process.env.KOISHI_DIR || path.join(PLUGIN_ROOT, '..', '..')
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(KOISHI_DIR, 'data') || path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'data')
const PERSONAS_DIR = path.join(DATA_DIR, 'ai-skills', 'personas')
const CORE_DIR = path.join(DATA_DIR, 'ai-skills', 'core')
const LORES_DIR = path.join(DATA_DIR, 'ai-skills', 'lore')
const MODES_DIR = path.join(DATA_DIR, 'ai-skills', 'modes')
const DIST_DIR = path.join(PLUGIN_ROOT, 'frontend', 'dist')
const PORT = process.env.DASHBOARD_PORT || 5150
const PASSWORD = process.env.DASHBOARD_PASSWORD || '123'
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || '123'

const ADMIN_PWD_FILE = path.join(DATA_DIR, 'dashboard-admin-pwd.txt')
const ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-access-pwd.txt')
const LEGACY_ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-pwd.txt')
const RESET_TOKEN_FILE = path.join(DATA_DIR, 'password-reset-token.txt')
const CUSTOM_PROVIDERS_FILE = path.join(DATA_DIR, 'ai-providers-custom.json')
const FALLBACK_CHAINS_FILE = path.join(DATA_DIR, 'ai-fallback-chains.json')
const DEBUG_LOG_CONFIG_FILE = path.join(DATA_DIR, 'debug-log-config.json')
const LOCAL_DEPLOY_MANIFEST_FILE = path.join(DATA_DIR, 'dashboard-local-deploy-manifest.json')
const LOCAL_NAPCAT_DIR_FILE = path.join(DATA_DIR, 'dashboard-napcat-dir.txt')
const GALLERY_DIR = path.join(DATA_DIR, 'gallery')
const GALLERY_METADATA_FILE = path.join(GALLERY_DIR, 'metadata.json')
const GALLERY_MAX_BYTES = 8 * 1024 * 1024
const GALLERY_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const GALLERY_FOIL_STYLES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
const NPM_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_all_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_ALL_PROXY']
const MAX_LOG_LIMIT = 6000
let logEntryCache = { file: '', size: -1, mtimeMs: -1, entries: [] }
let npmDiagnosticsCache = { at: 0, data: null }

// ====== 默认 fallback 链（按 AI 用途分类） ======
const DEFAULT_FALLBACK_CHAINS = {
  chat: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  vision: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'mimorium', model: 'mimo-v2-omni', keyFile: 'ai-mimorium-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  lightweight: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
}

// ====== 工具函数 ======
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readFileSync(p) {
  try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim() } catch {}
  return ''
}

function readUtf8(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return '' }
}

function writeFileSync(p, content) {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, String(content).trim(), 'utf8')
}

function log(msg) {
  console.log(`[dashboard] ${msg}`)
}

function isGlobalLocalMode() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.GLOBAL_LOCAL_MODE || '').trim())
}

function isLocalAuthBypass(req) {
  if (isGlobalLocalMode()) return true
  if (!req) return false
  return isLoopbackAddress(getRemoteAddress(req))
}

function getRemoteAddress(req) {
  return String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '').trim()
}

function isLoopbackAddress(address) {
  const value = String(address || '').trim()
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function stopKoishiProcesses() {
  if (process.platform === 'win32') {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\' -and $_.CommandLine -match \'koishi\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { timeout: 8000, stdio: 'ignore' })
    return
  }
  execSync("pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true", { timeout: 5000 })
  execSync("pkill -9 -f 'node.*koishi start' 2>/dev/null || true", { timeout: 5000 })
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function commandQuote(value) {
  const text = String(value)
  if (process.platform !== 'win32') return shellQuote(text)
  return '"' + text.replace(/"/g, '""') + '"'
}

function validateDeployServer(server) {
  const value = String(server || '').trim()
  if (!value) throw new Error('deploy server is required')
  if (/[\s;|`$<>"'\\]/.test(value) || value.includes('$(')) throw new Error('invalid deploy server')
  const user = '(?:[A-Za-z0-9._-]+@)?'
  const hostname = '(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)'
  const ipv4 = '(?:\\d{1,3}\\.){3}\\d{1,3}'
  const ipv6 = '\\[[0-9A-Fa-f:.]+\\]'
  const re = new RegExp('^' + user + '(?:' + hostname + '|' + ipv4 + '|' + ipv6 + ')$')
  if (!re.test(value)) throw new Error('invalid deploy server')
  return value
}

function validateDeployAppDir(appDir) {
  const value = String(appDir || '').trim().replace(/\/+$/, '') || '/'
  if (!value.startsWith('/')) throw new Error('appDir must be an absolute Linux path')
  if (/[\s;&|`$()<>"'\\]/.test(value)) throw new Error('invalid appDir')
  return value
}

function validateDeployTarget(cfg) {
  return {
    ...cfg,
    server: validateDeployServer(cfg?.server),
    appDir: validateDeployAppDir(cfg?.appDir),
    mode: cfg?.mode === 'install' ? 'install' : 'update',
  }
}

function writeDeployFingerprint(file, extra = {}) {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  Object.assign(cfg, extra)
  cfg.deployedAt = Date.now()
  cfg.deployFingerprint = computeFingerprint()
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return cfg.deployFingerprint
}

function remoteJoin(base, ...parts) {
  const root = validateDeployAppDir(base)
  const suffix = parts.map(part => String(part || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
  return suffix ? root.replace(/\/+$/, '') + '/' + suffix : root
}

function sshCommand(server, remoteCmd) {
  return `ssh -o StrictHostKeyChecking=no ${server} ${commandQuote(remoteCmd)}`
}

function scpRemoteTarget(server, remotePath) {
  const targetPath = String(remotePath || '')
  if (!targetPath.startsWith('/') || /[\s;&|`$()<>"'\\]/.test(targetPath)) throw new Error('invalid remote path')
  return `${server}:${targetPath}`
}

function scpCommand(source, target, options = {}) {
  const recursive = options.recursive ? '-r ' : ''
  return `scp -o StrictHostKeyChecking=no ${recursive}${commandQuote(source)} ${target}`
}

function isInsidePath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function listFilesRecursive(root, predicate) {
  const result = []
  function walk(dir) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (!predicate || predicate(full)) result.push(full)
    }
  }
  walk(root)
  return result
}

function hashFile(hash, repoRoot, filePath) {
  try {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/')
    hash.update(rel)
    hash.update('\0')
    hash.update(fs.readFileSync(filePath))
    hash.update('\0')
  } catch {}
}

function hasFrontendDistAssets(distDir = DIST_DIR) {
  const indexFile = path.join(distDir, 'index.html')
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(indexFile) || !fs.existsSync(assetsDir)) return false
  try { return fs.readdirSync(assetsDir).some(name => /\.js$/i.test(name)) }
  catch { return false }
}

function assertFrontendDistReady() {
  if (!hasFrontendDistAssets()) throw new Error('frontend dist is missing or incomplete; rebuild frontend first')
}

function rollbackFrontendDist(distDir, backupDir) {
  try { fs.rmSync(distDir, { recursive: true, force: true }) }
  catch (e) { return 'remove incomplete dist failed: ' + e.message }
  try {
    if (fs.existsSync(backupDir)) fs.renameSync(backupDir, distDir)
  } catch (e) { return 'restore previous dist failed: ' + e.message }
  return ''
}

function copyRecursiveSync(src, dst) {
  if (!fs.existsSync(src)) return
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyRecursiveSync(path.join(src, entry), path.join(dst, entry))
    return
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function describeFsError(e, fallback = '') {
  const code = e && e.code ? String(e.code) : ''
  if (code === 'ENOTDIR') return '路径冲突：目标路径的某一级已经是文件，不是目录。请删除冲突文件后重试。' + (e.path ? ` 冲突路径：${e.path}` : '')
  if (code === 'EACCES' || code === 'EPERM') return '权限不足或文件被占用。请关闭占用程序，或把部署器移动到可写目录后重试。' + (e.path ? ` 路径：${e.path}` : '')
  return fallback || String(e?.message || e || '未知错误')
}

function getCommandVersion(command) {
  try { return execSync(command, { timeout: 3000, encoding: 'utf8' }).trim() } catch { return '' }
}

function getCommandPath(command) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [command], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return out.split(/\r?\n/).map(item => item.trim()).filter(Boolean)[0] || ''
    }
    return execFileSync('/bin/sh', ['-lc', 'command -v ' + shellQuote(command)], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || ''
  } catch { return '' }
}

function getPortableNodeDir() {
  return runtimePath('node')
}

function getPortableToolPath(command) {
  const dir = getPortableNodeDir()
  const names = process.platform === 'win32'
    ? { node: ['node.exe'], npm: ['npm.cmd', 'npm.bat'], npx: ['npx.cmd', 'npx.bat'] }
    : { node: ['bin/node', 'node'], npm: ['bin/npm', 'npm'], npx: ['bin/npx', 'npx'] }
  for (const name of names[command] || []) {
    const fullPath = path.join(dir, ...name.split('/'))
    if (fs.existsSync(fullPath)) return fullPath
  }
  return ''
}

function getLocalToolEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  const nodeDir = getPortableNodeDir()
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  if (fs.existsSync(nodeDir)) env[pathKey] = [nodeDir, env[pathKey]].filter(Boolean).join(path.delimiter)
  return env
}

function getToolVersion(toolPath) {
  if (!toolPath) return ''
  try {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(toolPath)) {
      return execFileSync('cmd.exe', ['/d', '/c', toolPath, '--version'], { timeout: 5000, encoding: 'utf8', env: getLocalToolEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    }
    return execFileSync(toolPath, ['--version'], { timeout: 5000, encoding: 'utf8', env: getLocalToolEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return '' }
}

function getLocalToolCommand(command) {
  return getPortableToolPath(command) || command
}

function getLocalTaskOptions(options = {}) {
  return { ...options, env: getLocalToolEnv(options.env || {}) }
}

function normalizeProxyValue(value) {
  const text = String(value || '').trim()
  if (!text || /^(?:null|undefined|false)$/i.test(text)) return ''
  return text
}

function parseProxyEndpoint(value) {
  const text = normalizeProxyValue(value)
  if (!text) return null
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text
  try {
    const parsed = new URL(withProtocol)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    if (!hostname || !Number.isInteger(port)) return null
    return { raw: redactProxyValue(text), hostname, port, protocol: parsed.protocol.replace(/:$/, '') }
  } catch { return null }
}

function isLoopbackProxyHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

function isProjectOwnedTool(toolPath) {
  if (!toolPath) return false
  const resolved = path.resolve(toolPath)
  return isInsidePath(KOISHI_DIR, resolved)
}

function getCommandInfo(command, minMajor = 0) {
  const portablePath = getPortableToolPath(command)
  const portableVersion = getToolVersion(portablePath)
  const sourcePath = portableVersion ? portablePath : getCommandPath(command)
  const version = portableVersion || getCommandVersion(command + ' --version')
  const major = Number.parseInt(String(version).replace(/^v/i, '').split('.')[0], 10)
  const ownedByProject = isProjectOwnedTool(sourcePath)
  return {
    found: !!version,
    version,
    source: ownedByProject ? 'runtime/node' : 'PATH',
    sourcePath,
    ownedByProject,
    ok: !!version && (!minMajor || major >= minMajor),
    reason: version ? (!minMajor || major >= minMajor ? (ownedByProject ? '项目内命令可用' : 'Dashboard 后端 PATH 中的系统级命令可用') : `版本过低，需要 ${minMajor}+`) : '当前 Dashboard 进程 PATH 中未找到命令',
  }
}

function checkPortState(port) {
  const value = Number(port)
  if (!Number.isInteger(value) || value < 1 || value > 65535) return { available: false, status: 'invalid', reason: '端口号无效' }
  const script = `
const net = require('net')
const port = Number(process.argv[1])
const server = net.createServer()
server.unref()
server.once('error', err => {
  if (err && err.code === 'EADDRINUSE') process.exit(2)
  if (err && err.code === 'EACCES') process.exit(3)
  console.error(err && (err.code || err.message) || 'unknown')
  process.exit(4)
})
server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => process.exit(0)))
`
  try {
    execFileSync(process.execPath, ['-e', script, String(value)], { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] })
    return { available: true, status: 'free', reason: '端口可监听' }
  } catch (e) {
    if (e.status === 2) return { available: false, status: 'occupied', reason: '端口已有监听进程' }
    if (e.status === 3) return { available: false, status: 'denied', reason: '没有权限监听该端口' }
    return { available: false, status: 'unknown', reason: String(e.stderr || e.message || '端口检测失败').trim() }
  }
}

function checkPortAvailable(port) {
  return checkPortState(port).available
}

function toProjectRel(filePath) {
  return path.relative(path.resolve(KOISHI_DIR), path.resolve(filePath)).replace(/\\/g, '/')
}

function resolveProjectRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) throw new Error('invalid local deploy path')
  const full = path.resolve(KOISHI_DIR, normalized)
  if (!isInsidePath(KOISHI_DIR, full)) throw new Error('local deploy path is outside project directory')
  return full
}

function fileSha256(filePath) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') } catch { return '' }
}

function readLocalDeployManifest() {
  try { return JSON.parse(fs.readFileSync(LOCAL_DEPLOY_MANIFEST_FILE, 'utf8')) } catch { return { version: 1, files: [] } }
}

function backupLocalDeployFile(filePath, rel, timestamp) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return ''
  const backupRel = path.posix.join('data', 'backups', 'dashboard-local-deploy', String(timestamp), rel.replace(/[<>:"|?*]/g, '_'))
  const backupPath = resolveProjectRel(backupRel)
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.copyFileSync(filePath, backupPath)
  return backupRel
}

function writeTrackedLocalFile(rel, content, options, timestamp) {
  const cfg = options || {}
  const filePath = resolveProjectRel(rel)
  const text = String(content)
  const existed = fs.existsSync(filePath)
  const beforeHash = existed ? fileSha256(filePath) : ''
  const unchanged = existed && fs.readFileSync(filePath, 'utf8') === text
  const backup = unchanged ? '' : backupLocalDeployFile(filePath, rel, timestamp)
  if (!unchanged) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, text, 'utf8')
  }
  const hash = fileSha256(filePath)
  return {
    path: rel,
    action: unchanged ? 'unchanged' : (existed ? 'overwritten' : 'created'),
    backup,
    beforeHash,
    sha256: hash,
    deleteByDefault: cfg.deleteByDefault !== false,
    sensitive: !!cfg.sensitive,
    kind: cfg.kind || 'config',
  }
}

function writeLocalDeployManifest(manifest) {
  fs.mkdirSync(path.dirname(LOCAL_DEPLOY_MANIFEST_FILE), { recursive: true })
  fs.writeFileSync(LOCAL_DEPLOY_MANIFEST_FILE + '.tmp', JSON.stringify(manifest, null, 2), 'utf8')
  fs.renameSync(LOCAL_DEPLOY_MANIFEST_FILE + '.tmp', LOCAL_DEPLOY_MANIFEST_FILE)
}

function getProjectDependencyStatus() {
  const packageLock = path.join(KOISHI_DIR, 'package-lock.json')
  const nodeModules = path.join(KOISHI_DIR, 'node_modules')
  const required = ['koishi', 'koishi-plugin-adapter-onebot']
  const packages = Object.fromEntries(required.map(name => [name, fs.existsSync(path.join(nodeModules, name, 'package.json'))]))
  const ready = fs.existsSync(nodeModules) && required.every(name => packages[name])
  return {
    ready,
    nodeModules: { exists: fs.existsSync(nodeModules), path: nodeModules },
    packageLock: { exists: fs.existsSync(packageLock), path: packageLock },
    packages,
    reason: ready ? '项目依赖已安装' : '源码存在不代表依赖已安装，请先运行 npm install 或生成本地配置后启动脚本自动安装',
  }
}

function inspectChinesePathWrite(dir) {
  if (!fs.existsSync(dir)) return { ok: false, skipped: true, message: 'runtime/logs 尚未创建，生成配置或下载时会创建' }
  return testChinesePathWrite(dir)
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter(item => {
    const key = path.resolve(item).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function findNapcatMarkers(root) {
  const markers = []
  const archives = []
  let count = 0
  function walk(dir, depth) {
    if (depth > 4 || count > 240) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (count > 240) return
      count += 1
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (!['node_modules', 'resources', 'config', 'app'].includes(entry.name) && depth >= 2) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (/^NapCatInstaller\.exe$/i.test(entry.name)) markers.push({ path: full, rel, type: 'installer' })
      else if (/^napcat.*\.(exe|bat|cmd|js|mjs)$/i.test(entry.name) || /^NapCatWinBootMain\.exe$/i.test(entry.name) || /NapCat.*\.exe$/i.test(entry.name)) markers.push({ path: full, rel, type: 'entry' })
      else if (/^config\/webui\.json$/i.test(rel)) markers.push({ path: full, rel, type: 'config' })
      else if (/^package\.json$/i.test(entry.name)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (/napcat/i.test(String(pkg.name || '') + ' ' + String(pkg.description || ''))) markers.push({ path: full, rel, type: 'package' })
        } catch {}
      } else if (/\.(zip|7z|rar|tar\.gz)$/i.test(entry.name)) archives.push({ path: full, rel })
    }
  }
  walk(root, 0)
  return { markers, archives }
}

function rankNapcatEntry(filePath) {
  const name = path.basename(filePath || '')
  if (/^napcat\.bat$/i.test(name)) return 0
  if (/^napcat\.cmd$/i.test(name)) return 1
  if (/^NapCatWinBootMain\.exe$/i.test(name)) return 2
  if (/^napcat.*\.exe$/i.test(name)) return 3
  if (/\.(bat|cmd)$/i.test(name)) return 4
  if (/\.(js|mjs)$/i.test(name)) return 5
  if (/NapCat.*\.exe$/i.test(name)) return 6
  return 20
}

function sortNapcatEntries(markers = []) {
  return markers
    .filter(item => item?.type === 'entry')
    .slice()
    .sort((a, b) => rankNapcatEntry(a.path) - rankNapcatEntry(b.path) || String(a.rel || a.path).localeCompare(String(b.rel || b.path)))
}

function inspectNapcatCandidate(candidate) {
  const result = { path: candidate, exists: false, found: false, status: 'missing', reason: '路径不存在' }
  try {
    const stat = fs.statSync(candidate)
    result.exists = true
    if (stat.isFile()) {
      const name = path.basename(candidate)
      if (/napcat.*\.(exe|bat|cmd|zip|7z)$/i.test(name)) return { ...result, found: /\.(exe|bat|cmd)$/i.test(name), status: /\.(exe|bat|cmd)$/i.test(name) ? 'installed' : 'partial', entry: candidate, reason: /\.(exe|bat|cmd)$/i.test(name) ? '找到 NapCat 启动文件' : '只发现下载包，尚未解压安装' }
      return { ...result, status: 'partial', reason: '路径是文件但不是 NapCat 启动文件' }
    }
    if (!stat.isDirectory()) return { ...result, status: 'partial', reason: '路径不是目录' }
    const entries = fs.readdirSync(candidate)
    if (!entries.length) return { ...result, status: 'partial', reason: '目录为空' }
    const { markers, archives } = findNapcatMarkers(candidate)
    const entryMarkers = sortNapcatEntries(markers)
    if (entryMarkers.length || markers.some(item => item.type === 'config')) return { ...result, found: true, status: 'installed', entry: entryMarkers[0]?.path || '', reason: '找到 NapCat 启动或配置标记', markers: markers.slice(0, 8) }
    if (archives.length) return { ...result, status: 'partial', reason: '目录里只有下载包或压缩包，尚未解压安装', archives: archives.slice(0, 8) }
    return { ...result, status: 'partial', reason: '目录存在但未找到 NapCat 启动文件' }
  } catch (e) {
    return { ...result, status: 'unknown', reason: e.message }
  }
}

function detectNapcatInstallation() {
  const expectedPath = runtimePath('napcat')
  if (process.platform !== 'win32') {
    const reason = `当前 Dashboard 后端是 ${process.platform}/${process.arch}，Windows 本地部署需要在 Windows 部署器软件中运行。远端网页不能检测浏览器所在的 Windows 电脑。`
    return { found: false, status: 'unsupported', path: '', expectedPath, entry: '', reason, candidates: [] }
  }
  const candidates = uniquePaths([
    expectedPath,
    readFileSync(LOCAL_NAPCAT_DIR_FILE),
    path.join(KOISHI_DIR, 'NapCat'),
    process.env.NAPCAT_DIR || '',
    path.join(KOISHI_DIR, 'runtime', 'NapCat'),
  ].filter(Boolean))
  const inspected = candidates.map(inspectNapcatCandidate)
  const installed = inspected.find(item => item.found)
  const partial = inspected.find(item => item.exists)
  const selected = installed || partial || inspected[0] || { found: false, path: expectedPath, status: 'missing', reason: '未找到 NapCat' }
  return {
    found: !!installed,
    status: installed ? 'installed' : (partial ? 'partial' : 'missing'),
    path: selected.path,
    expectedPath,
    entry: selected.entry || '',
    reason: selected.reason || (installed ? '已安装' : '未检测到 NapCat'),
    candidates: inspected.map(item => ({ path: item.path, exists: item.exists, status: item.status, reason: item.reason, entry: item.entry || '' })),
  }
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function validateNapcatInstallDir(input) {
  const raw = String(input || '').trim() || runtimePath('napcat')
  const dir = path.resolve(raw)
  if (process.platform === 'win32') {
    const lower = dir.toLowerCase()
    const root = path.parse(dir).root.toLowerCase()
    const blocked = [process.env.WINDIR, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(item => path.resolve(item).toLowerCase())
    if (lower === root || blocked.some(item => lower === item || lower.startsWith(item + path.sep.toLowerCase()))) throw new Error('不能安装到系统根目录、Windows 目录或 Program Files')
  }
  fs.mkdirSync(dir, { recursive: true })
  const testFile = path.join(dir, '.napcat-install-write-test')
  fs.writeFileSync(testFile, 'ok', 'utf8')
  fs.unlinkSync(testFile)
  return dir
}

function httpsGetJson(url, callback) {
  const req = https.get(url, { headers: { 'User-Agent': 'LianBoard-Dashboard' } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume()
      httpsGetJson(response.headers.location, callback)
      return
    }
    if (response.statusCode !== 200) {
      response.resume()
      callback(new Error('GitHub API 请求失败：HTTP ' + response.statusCode))
      return
    }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { body += chunk })
    response.on('end', () => { try { callback(null, JSON.parse(body)) } catch (e) { callback(e) } })
  })
  req.setTimeout(30000, () => req.destroy(new Error('GitHub API 请求超时')))
  req.on('error', callback)
}

function pickNapcatWindowsAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const zipAssets = assets.filter(item => /\.zip$/i.test(item.name || '') && !/(linux|darwin|mac|android|arm64|aarch64)/i.test(item.name || ''))
  return zipAssets.find(item => /^NapCat\.Shell\.Windows\.OneKey\.zip$/i.test(item.name || ''))
    || zipAssets.find(item => /^NapCat\.Shell\.Windows\.Node\.zip$/i.test(item.name || ''))
    || zipAssets.find(item => /(win|windows)/i.test(item.name || ''))
    || zipAssets[0]
    || null
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

function sanitizeDownloadName(name, fallback = 'download.bin') {
  const cleaned = safeDecodeURIComponent(String(name || '')).replace(/^['"]|['"]$/g, '').replace(/[<>":/\\|?*\x00-\x1f]/g, '_').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function getContentDispositionFileName(header) {
  const value = String(header || '')
  const star = value.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;\r\n]+)/i)
  if (star?.[1]) return sanitizeDownloadName(star[1])
  const normal = value.match(/filename\s*=\s*("[^"]+"|[^;\r\n]+)/i)
  return normal?.[1] ? sanitizeDownloadName(normal[1]) : ''
}

function ensureExtension(name, ext) {
  const suffix = String(ext || '').trim()
  if (!suffix) return name
  const normalized = suffix.startsWith('.') ? suffix : '.' + suffix
  return name.toLowerCase().endsWith(normalized.toLowerCase()) ? name : name + normalized
}

function hasZipMagic(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(4)
    const read = fs.readSync(fd, buffer, 0, 4, 0)
    fs.closeSync(fd)
    return read >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])
  } catch { return false }
}

function validateDownloadedFile(filePath, options = {}) {
  const stat = fs.statSync(filePath)
  const minBytes = Number(options.minBytes || 0)
  if (minBytes && stat.size < minBytes) throw new Error(`下载文件过小：${stat.size} 字节，可能是网络错误页或下载不完整`)
  const expectsZip = /\.zip$/i.test(String(options.expectedExt || '')) || /zip/i.test(String(options.expectedContentType || '')) || /\.zip$/i.test(filePath)
  if (expectsZip && !hasZipMagic(filePath)) throw new Error('下载文件不是有效 zip 包，可能下载到了 HTML 错误页或被代理改写')
  return { path: filePath, size: stat.size, name: path.basename(filePath) }
}

function getDownloadFileName(parsed, response, options = {}) {
  const contentType = String(response.headers['content-type'] || '')
  let name = options.preferredName || getContentDispositionFileName(response.headers['content-disposition']) || sanitizeDownloadName(path.basename(parsed.pathname || ''), 'download.bin')
  if ((!path.extname(name) || /^[0-9a-f-]{16,}$/i.test(name)) && /zip/i.test(contentType)) name = ensureExtension(name, '.zip')
  if (options.expectedExt) name = ensureExtension(name, options.expectedExt)
  return sanitizeDownloadName(name, 'download.bin')
}

function getLocalWorkDirSafety() {
  const projectDir = path.resolve(KOISHI_DIR)
  const runtimeDir = runtimePath()
  const tempDir = path.resolve(os.tmpdir()).toLowerCase()
  const values = [projectDir, runtimeDir].map(item => item.toLowerCase())
  const reasons = []
  if (values.some(item => item === tempDir || item.startsWith(tempDir + path.sep.toLowerCase()))) reasons.push('工作目录位于系统临时目录')
  if (values.some(item => /[\\/]resources[\\/]app(?:[\\/]|$)/i.test(item))) reasons.push('工作目录位于 Electron 资源临时目录')
  const fallbackReason = String(process.env.LIANLIAN_WORKSPACE_FALLBACK_REASON || '').trim()
  if (fallbackReason) reasons.push(fallbackReason)
  return {
    ok: reasons.length === 0,
    isTempRuntime: reasons.length > 0,
    reasons,
    projectDir,
    runtimeDir,
    workspaceRoot: process.env.LIANLIAN_WORKSPACE_ROOT || projectDir,
    resourceRoot: process.env.LIANLIAN_RESOURCE_ROOT || '',
    packaged: /^(?:1|true|yes|on)$/i.test(String(process.env.LIANLIAN_PACKAGED || '').trim()),
  }
}

function findFilesRecursive(root, matcher, maxDepth = 6, maxCount = 600) {
  const matches = []
  let count = 0
  function walk(dir, depth) {
    if (depth > maxDepth || count > maxCount) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (count > maxCount) return
      count += 1
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && matcher(entry.name, full)) matches.push(full)
    }
  }
  walk(root, 0)
  return matches
}

function extractZipArchive(archivePath, destinationDir) {
  if (!fs.existsSync(archivePath)) throw new Error('解压源文件不存在：' + archivePath)
  const stat = fs.statSync(archivePath)
  if (!stat.isFile()) throw new Error('解压源路径不是文件：' + archivePath)
  if (stat.size <= 0) throw new Error('解压源文件为空：' + archivePath)
  if (!hasZipMagic(archivePath)) throw new Error('解压源文件不是有效 zip 包：' + archivePath)
  fs.rmSync(destinationDir, { recursive: true, force: true })
  fs.mkdirSync(destinationDir, { recursive: true })
  const attempts = []
  try {
    execFileSync('tar.exe', ['-xf', archivePath, '-C', destinationDir], { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { method: 'tar.exe', attempts, archivePath, destinationDir, size: stat.size }
  } catch (e) {
    attempts.push({ method: 'tar.exe', code: e.status || e.code || '', error: String(e.stderr || e.message || '').trim() })
  }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destinationDir)} -Force`], { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { method: 'PowerShell Expand-Archive', attempts, archivePath, destinationDir, size: stat.size }
  } catch (e) {
    attempts.push({ method: 'PowerShell Expand-Archive', code: e.status || e.code || '', error: String(e.stderr || e.message || '').trim() })
    const message = attempts.map(item => `${item.method}: ${item.error || '失败'}`).join('；')
    const err = new Error('自动解压失败：' + message)
    err.attempts = attempts
    err.stage = 'extract'
    err.archivePath = archivePath
    err.destinationDir = destinationDir
    err.fileSize = stat.size
    throw err
  }
}

function runNapcatInstallerIfPresent(stagingDir) {
  const installers = findFilesRecursive(stagingDir, name => /^NapCatInstaller\.exe$/i.test(name), 6, 800)
  if (!installers.length) return { ran: false, ok: false, reason: '未找到 NapCatInstaller.exe，可手动运行解压目录内的安装器' }
  const installer = installers[0]
  try {
    execFileSync(installer, [], { cwd: path.dirname(installer), timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    return { ran: true, ok: true, path: installer, reason: 'NapCatInstaller.exe 已执行' }
  } catch (e) {
    return { ran: true, ok: false, path: installer, reason: 'NapCatInstaller.exe 执行失败或被中断：' + String(e.stderr || e.message || '').trim() }
  }
}

function buildNapcatManualSteps(archivePath, installDir) {
  return [
    `打开下载包：${archivePath}`,
    `把压缩包完整解压到：${installDir}`,
    '进入解压出的 NapCat.XXXX.Shell 目录，运行 NapCatInstaller.exe 等待自动配置完成。',
    '确认目录里出现 napcat.bat 或 NapCatWinBootMain.exe 后，回到部署器点击“检测环境”。',
  ]
}

function downloadNapcatWindowsRelease(installDir, callback) {
  httpsGetJson('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest', (apiErr, release) => {
    if (apiErr) return callback(apiErr)
    const asset = pickNapcatWindowsAsset(release)
    if (!asset?.browser_download_url) {
      const names = (release?.assets || []).map(item => item.name).filter(Boolean).join(', ')
      return callback(new Error('未找到可自动安装的 Windows zip 资产' + (names ? '，候选：' + names : '')))
    }
    downloadToRuntime(asset.browser_download_url, { preferredName: asset.name, expectedExt: '.zip', minBytes: 128 * 1024 }, (downloadErr, filePath, download) => {
      if (downloadErr) return callback(downloadErr)
      const stagingDir = runtimePath('napcat-install-' + Date.now().toString(36))
      try {
        const extraction = extractZipArchive(filePath, stagingDir)
        const installer = runNapcatInstallerIfPresent(stagingDir)
        fs.mkdirSync(installDir, { recursive: true })
        const content = fs.readdirSync(stagingDir)
        if (!content.length) throw new Error('NapCat zip 解压后目录为空')
        copyRecursiveSync(stagingDir, installDir)
        const detected = inspectNapcatCandidate(installDir)
        const needsManualSetup = !detected.found || (installer.ran && !installer.ok)
        callback(null, {
          asset: asset.name,
          filePath,
          download,
          installDir,
          extraction,
          installer,
          napcat: detected,
          needsManualSetup,
          manualSteps: needsManualSetup ? buildNapcatManualSteps(filePath, installDir) : [],
          message: needsManualSetup ? 'NapCat OneKey 包已下载并解压，但仍需要按提示完成安装器配置' : 'NapCat OneKey 包已下载、解压并完成检测',
        })
      } catch (e) {
        const readable = describeFsError(e, String(e.message || '').trim())
        callback(new Error('NapCat 下载完成但自动解压/安装失败：' + readable), { asset: asset.name, filePath, download, installDir, manualSteps: buildNapcatManualSteps(filePath, installDir), attempts: e.attempts || [], stage: e.stage || 'install', archivePath: e.archivePath || filePath, fileSize: e.fileSize })
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
    })
  })
}

function pickNodeWindowsRelease(releases) {
  const arch = process.arch === 'arm64' ? 'arm64' : (process.arch === 'x64' ? 'x64' : '')
  if (!arch) throw new Error('当前架构暂不支持自动安装便携 Node：' + process.arch)
  const list = Array.isArray(releases) ? releases : []
  const selected = list.find(item => item?.lts && /^v\d+\.\d+\.\d+$/.test(String(item.version || '')))
  if (!selected) throw new Error('未找到 Node.js LTS 版本信息')
  const version = selected.version
  const fileName = `node-${version}-win-${arch}.zip`
  return {
    version,
    arch,
    fileName,
    url: `https://nodejs.org/dist/${version}/${fileName}`,
  }
}

function findExtractedNodeRoot(stagingDir) {
  const direct = path.join(stagingDir, 'node.exe')
  if (fs.existsSync(direct)) return stagingDir
  let entries = []
  try { entries = fs.readdirSync(stagingDir, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(stagingDir, entry.name)
    if (fs.existsSync(path.join(candidate, 'node.exe'))) return candidate
  }
  return ''
}

function installPortableNodeWindows(callback) {
  if (process.platform !== 'win32') return callback(new Error('便携 Node/npm 自动安装只支持 Windows 本地部署器'))
  const currentNode = getCommandInfo('node', 18)
  const currentNpm = getCommandInfo('npm')
  if (currentNode.ok && currentNpm.found && currentNode.ownedByProject && currentNpm.ownedByProject) {
    return callback(null, { skipped: true, message: '项目便携 Node/npm 已安装', node: currentNode, npm: currentNpm })
  }
  httpsGetJson('https://nodejs.org/dist/index.json', (apiErr, releases) => {
    if (apiErr) return callback(apiErr)
    let asset
    try { asset = pickNodeWindowsRelease(releases) }
    catch (e) { return callback(e) }
    downloadToRuntime(asset.url, { preferredName: asset.fileName, expectedExt: '.zip', minBytes: 1024 * 1024 }, (downloadErr, archivePath, download) => {
      if (downloadErr) return callback(downloadErr)
      const stagingDir = runtimePath('node-install-' + Date.now().toString(36))
      const targetDir = getPortableNodeDir()
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true })
        fs.mkdirSync(stagingDir, { recursive: true })
        extractZipArchive(archivePath, stagingDir)
        const nodeRoot = findExtractedNodeRoot(stagingDir)
        if (!nodeRoot) throw new Error('Node zip 解压后未找到 node.exe')
        fs.rmSync(targetDir, { recursive: true, force: true })
        fs.mkdirSync(targetDir, { recursive: true })
        copyRecursiveSync(nodeRoot, targetDir)
        const node = getCommandInfo('node', 18)
        const npm = getCommandInfo('npm')
        if (!node.ok || !node.ownedByProject) throw new Error('便携 Node 校验失败：' + (node.reason || 'node 不可用'))
        if (!npm.found || !npm.ownedByProject) throw new Error('便携 npm 校验失败：' + (npm.reason || 'npm 不可用'))
        callback(null, { skipped: false, message: '便携 Node/npm 已安装到 runtime/node', asset, archivePath, download, installDir: targetDir, node, npm })
      } catch (e) {
        fs.rmSync(targetDir, { recursive: true, force: true })
        callback(new Error('便携 Node/npm 安装失败：' + describeFsError(e, String(e.stderr || e.message || '').trim())), { asset, archivePath, download, installDir: targetDir, attempts: e.attempts || [], stage: e.stage || 'install' })
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
    })
  })
}

function buildLocalConfigPreview() {
  const manifest = readLocalDeployManifest()
  const files = []
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : []
  const byPath = new Map(manifestFiles.map(item => [item.path, item]))
  for (const rel of ['koishi.yml', 'start-local.bat']) {
    if (!byPath.has(rel)) byPath.set(rel, { path: rel, deleteByDefault: true, kind: 'config', reason: '标准本地部署文件' })
  }
  if (fs.existsSync(LOCAL_DEPLOY_MANIFEST_FILE)) byPath.set(toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE), { path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE), deleteByDefault: true, kind: 'manifest', reason: '本地部署清单' })
  for (const item of byPath.values()) {
    let filePath = ''
    try { filePath = resolveProjectRel(item.path) } catch (e) { files.push({ path: item.path, action: 'error', reason: e.message }); continue }
    let stat = null
    try { stat = fs.statSync(filePath) } catch {}
    if (!stat) { files.push({ path: item.path, action: 'missing', reason: '文件不存在' }); continue }
    if (!stat.isFile()) { files.push({ path: item.path, action: 'keep', size: stat.size, reason: '不是普通文件' }); continue }
    if (item.sensitive || item.deleteByDefault === false) { files.push({ path: item.path, action: 'keep', size: stat.size, reason: '受保护文件' }); continue }
    const currentHash = fileSha256(filePath)
    if (item.sha256 && currentHash && item.sha256 !== currentHash) { files.push({ path: item.path, action: 'keep', size: stat.size, reason: '文件已被手动修改，默认保留', sha256: currentHash }); continue }
    files.push({ path: item.path, action: 'delete', size: stat.size, reason: item.reason || '本工具生成的本地部署配置', sha256: currentHash })
  }
  const protectedPaths = ['runtime/napcat', 'runtime/downloads', 'data/ai-openai-key.txt', 'data/ai-deepseek-key.txt', 'data/ai-dashscope-key.txt', 'data/user-profiles', 'runtime/logs']
    .filter(rel => fs.existsSync(resolveProjectRel(rel)))
    .map(rel => ({ path: rel, action: 'keep', reason: '用户数据或运行时文件默认保留' }))
  return { ok: true, files, protected: protectedPaths, manifest: { exists: fs.existsSync(LOCAL_DEPLOY_MANIFEST_FILE), path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE) } }
}

function deleteLocalConfigFiles() {
  const preview = buildLocalConfigPreview()
  const deleted = []
  const kept = []
  const errors = []
  for (const item of preview.files) {
    if (item.action !== 'delete') { kept.push(item); continue }
    try {
      const full = resolveProjectRel(item.path)
      fs.unlinkSync(full)
      deleted.push({ path: item.path, size: item.size, status: 'ok' })
    } catch (e) {
      errors.push({ path: item.path, reason: e.message })
    }
  }
  return { ok: errors.length === 0, deleted, kept: kept.concat(preview.protected || []), errors }
}

function requireStrictAdmin(req, res) {
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

function projectDisplayPath(filePath) {
  const resolved = path.resolve(filePath)
  return isInsidePath(KOISHI_DIR, resolved) ? toProjectRel(resolved) : resolved
}

function safeLstat(filePath) {
  try { return fs.lstatSync(filePath) } catch { return null }
}

function summarizePath(filePath, limit = 50000) {
  const rootStat = safeLstat(filePath)
  if (!rootStat) return { exists: false, size: 0, count: 0, truncated: false }
  let size = 0
  let count = 0
  let truncated = false
  const stack = [{ filePath, stat: rootStat }]
  while (stack.length) {
    const item = stack.pop()
    count += 1
    size += Number(item.stat.size) || 0
    if (count > limit) { truncated = true; break }
    if (!item.stat.isDirectory() || item.stat.isSymbolicLink()) continue
    let entries = []
    try { entries = fs.readdirSync(item.filePath, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const child = path.join(item.filePath, entry.name)
      const childStat = safeLstat(child)
      if (childStat) stack.push({ filePath: child, stat: childStat })
    }
  }
  return { exists: true, size, count, truncated, directory: rootStat.isDirectory(), symlink: rootStat.isSymbolicLink() }
}

function uniqueTargets(targets) {
  const seen = new Set()
  return targets.filter(target => {
    if (!target?.fullPath) return false
    const key = path.resolve(target.fullPath).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createUninstallItem(key, label, reason, paths, options = {}) {
  const targets = uniqueTargets(paths.map(item => {
    const fullPath = path.resolve(item.fullPath || item)
    const summary = summarizePath(fullPath)
    if (!summary.exists) return null
    return { path: item.path || projectDisplayPath(fullPath), fullPath, scope: item.scope || 'project', size: summary.size, count: summary.count, truncated: summary.truncated, directory: summary.directory, symlink: summary.symlink }
  }).filter(Boolean))
  if (!targets.length) return null
  return {
    key,
    label,
    action: options.action || 'delete',
    kind: options.kind || 'environment',
    reason,
    defaultKeep: !!options.defaultKeep,
    size: targets.reduce((sum, target) => sum + (target.size || 0), 0),
    count: targets.reduce((sum, target) => sum + (target.count || 0), 0),
    truncated: targets.some(target => target.truncated),
    paths: targets.map(target => ({ path: target.path, size: target.size, count: target.count, truncated: target.truncated, directory: target.directory, symlink: target.symlink })),
    targets,
  }
}

function pushUninstallItem(list, item) {
  if (item) list.push(item)
}

function projectTarget(rel) {
  return { fullPath: resolveProjectRel(rel), path: rel, scope: 'project' }
}

function existingProjectTarget(rel) {
  const target = projectTarget(rel)
  return fs.existsSync(target.fullPath) ? target : null
}

function listExistingDataChildren(excludedRels) {
  if (!isInsidePath(KOISHI_DIR, DATA_DIR) || !fs.existsSync(DATA_DIR)) return []
  const result = []
  let entries = []
  try { entries = fs.readdirSync(DATA_DIR, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    const rel = path.posix.join('data', entry.name)
    if (excludedRels.has(rel)) continue
    result.push(projectTarget(rel))
  }
  return result
}

function listReleaseArtifacts() {
  const releaseDir = path.join(KOISHI_DIR, 'local-deployer', 'release')
  if (!fs.existsSync(releaseDir)) return []
  let entries = []
  try { entries = fs.readdirSync(releaseDir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(entry => entry.name !== 'README.txt')
    .map(entry => projectTarget(path.posix.join('local-deployer', 'release', entry.name)))
    .filter(target => fs.existsSync(target.fullPath))
}

function sanitizeGalleryBaseName(name) {
  const base = path.basename(String(name || 'image')).replace(/\.[^.]+$/, '')
  return (base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'image')
}

function resolveGalleryId(id) {
  const value = String(id || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value !== path.basename(value)) throw new Error('图像 ID 无效')
  const fullPath = path.join(GALLERY_DIR, value)
  if (!isInsidePath(GALLERY_DIR, fullPath)) throw new Error('图像路径越界')
  return fullPath
}

function galleryMimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'application/octet-stream'
}

function normalizeGalleryStyle(value) {
  const text = String(value ?? '').trim().toUpperCase()
  if (!text || text === 'NONE' || text === 'NULL') return null
  if (!GALLERY_FOIL_STYLES.has(text)) throw new Error('闪卡样式无效')
  return text
}

function readGalleryMetadata() {
  try {
    const data = JSON.parse(fs.readFileSync(GALLERY_METADATA_FILE, 'utf8') || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { return {} }
}

function writeGalleryMetadata(metadata) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true })
  const tmp = GALLERY_METADATA_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(metadata || {}, null, 2), 'utf8')
  fs.renameSync(tmp, GALLERY_METADATA_FILE)
}

function getGalleryFoilStyle(metadata, fileName) {
  try { return normalizeGalleryStyle(metadata?.[fileName]?.foilStyle) }
  catch { return null }
}

function toGalleryItem(fileName, metadata = null) {
  const galleryMetadata = metadata || readGalleryMetadata()
  const fullPath = resolveGalleryId(fileName)
  const stat = fs.statSync(fullPath)
  return {
    id: fileName,
    name: fileName.replace(/^\d+-[a-f0-9]+-/, ''),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: galleryMimeFromName(fileName),
    url: '/dashboard/api/gallery/image/' + encodeURIComponent(fileName),
    foilStyle: getGalleryFoilStyle(galleryMetadata, fileName),
  }
}

function listGalleryImages() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true })
  const metadata = readGalleryMetadata()
  let entries = []
  try { entries = fs.readdirSync(GALLERY_DIR, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(entry => entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name))
    .map(entry => {
      try { return toGalleryItem(entry.name, metadata) }
      catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function writeGalleryImage(input = {}) {
  const mime = String(input.type || '').toLowerCase()
  const ext = GALLERY_MIME_EXT[mime]
  if (!ext) throw new Error('只支持 PNG、JPG、WebP 或 GIF 图片')
  const raw = String(input.data || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
  if (!raw) throw new Error('图片内容为空')
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new Error('图片内容为空')
  if (buffer.length > GALLERY_MAX_BYTES) throw new Error('图片不能超过 8MB')
  fs.mkdirSync(GALLERY_DIR, { recursive: true })
  const safeName = sanitizeGalleryBaseName(input.name)
  const fileName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName}.${ext}`
  const fullPath = resolveGalleryId(fileName)
  fs.writeFileSync(fullPath, buffer)
  const metadata = readGalleryMetadata()
  metadata[fileName] = { ...(metadata[fileName] || {}), foilStyle: null }
  writeGalleryMetadata(metadata)
  return toGalleryItem(fileName, metadata)
}

function deleteGalleryImage(id) {
  const fullPath = resolveGalleryId(id)
  if (!fs.existsSync(fullPath)) throw new Error('图片不存在')
  fs.unlinkSync(fullPath)
  return { id }
}

function deleteGalleryImages(ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  const metadata = readGalleryMetadata()
  let metadataChanged = false
  const deleted = []
  const errors = []
  for (const id of list) {
    try {
      deleted.push(deleteGalleryImage(id))
      if (Object.prototype.hasOwnProperty.call(metadata, id)) {
        delete metadata[id]
        metadataChanged = true
      }
    }
    catch (e) { errors.push({ id, message: e.message }) }
  }
  if (metadataChanged) writeGalleryMetadata(metadata)
  return { deleted, errors }
}

function updateGalleryImageStyle(id, foilStyle) {
  const fullPath = resolveGalleryId(id)
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error('图片不存在')
  const metadata = readGalleryMetadata()
  metadata[id] = { ...(metadata[id] || {}), foilStyle: normalizeGalleryStyle(foilStyle) }
  writeGalleryMetadata(metadata)
  return toGalleryItem(id, metadata)
}

function isBlockedDeletePath(filePath) {
  const resolved = path.resolve(filePath)
  const lower = resolved.toLowerCase()
  const root = path.parse(resolved).root
  if (lower === path.resolve(root).toLowerCase()) return '不能删除磁盘根目录'
  const blocked = [process.env.WINDIR, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, os.homedir()]
    .filter(Boolean)
    .map(item => path.resolve(item).toLowerCase())
  const hit = blocked.find(item => lower === item || lower.startsWith(item + path.sep.toLowerCase()))
  if (hit && (lower === hit || ['windows', 'program files', 'program files (x86)', 'programdata'].some(name => hit.endsWith(path.sep + name)))) return '不能删除系统目录或用户主目录根'
  return ''
}

function assertSafeProjectDeletePath(filePath) {
  const resolved = path.resolve(filePath)
  const projectRoot = path.resolve(KOISHI_DIR)
  if (resolved === projectRoot) throw new Error('不能删除项目根目录')
  if (!isInsidePath(projectRoot, resolved)) throw new Error('删除路径不在当前项目目录内')
  const blocked = isBlockedDeletePath(resolved)
  if (blocked) throw new Error(blocked)
  const stat = safeLstat(resolved)
  if (!stat) return
  if (stat.isSymbolicLink()) throw new Error('拒绝删除符号链接或 junction')
  let real = ''
  try { real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved) } catch { real = resolved }
  if (!isInsidePath(projectRoot, real)) throw new Error('真实路径指向项目目录外')
}

function assertSafeExternalNapcatDeletePath(filePath) {
  const resolved = path.resolve(filePath)
  const recorded = path.resolve(readFileSync(LOCAL_NAPCAT_DIR_FILE) || '')
  if (!recorded || resolved.toLowerCase() !== recorded.toLowerCase()) throw new Error('外部 NapCat 目录未由本工具记录')
  const blocked = isBlockedDeletePath(resolved)
  if (blocked) throw new Error(blocked)
  const stat = safeLstat(resolved)
  if (!stat) throw new Error('路径不存在')
  if (stat.isSymbolicLink()) throw new Error('拒绝删除符号链接或 junction')
  const inspected = inspectNapcatCandidate(resolved)
  if (!inspected.exists || (!inspected.found && inspected.status !== 'partial')) throw new Error('路径无法验证为 NapCat 安装目录')
}

function assertSafeUninstallTarget(target) {
  if (target.scope === 'externalNapcat') return assertSafeExternalNapcatDeletePath(target.fullPath)
  return assertSafeProjectDeletePath(target.fullPath)
}

function buildLocalUninstallPreview() {
  const deleteItems = []
  const userDataItems = []
  const keepItems = []
  const warnings = []
  const excludedData = new Set([
    'data/ai-provider.txt',
    'data/ai-model.txt',
    'data/ai-base-url.txt',
    'data/dashboard-local-deploy-manifest.json',
    'data/dashboard-napcat-dir.txt',
    'data/backups/dashboard-local-deploy',
  ])

  pushUninstallItem(deleteItems, createUninstallItem('root-node-modules', '项目依赖 node_modules', '本项目 npm install 产生的依赖目录，可重新安装', [existingProjectTarget('node_modules')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('dashboard-frontend-node-modules', 'Dashboard 前端依赖', '前端构建依赖，可重新安装', [existingProjectTarget('packages/koishi-plugin-dashboard/frontend/node_modules')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('local-deployer-node-modules', '本地部署器依赖', 'Electron 本地部署器依赖，可重新安装', [existingProjectTarget('local-deployer/node_modules')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('local-deployer-dist', '本地部署器构建产物', '打包输出，可重新构建', [existingProjectTarget('local-deployer/dist')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('local-deployer-release-artifacts', '本地部署器发布包', '保留 release/README.txt，只清理生成的发布附件', listReleaseArtifacts()))
  pushUninstallItem(deleteItems, createUninstallItem('runtime-node', '项目便携 Node', '仅删除项目 runtime/node 中由本项目管理的 Node', [existingProjectTarget('runtime/node')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('local-koishi-config', 'Koishi 本地配置', '本地部署生成的 Koishi 配置和启动脚本', ['koishi.yml', 'start-local.bat'].map(existingProjectTarget).filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('local-deploy-runtime-config', '本地部署运行配置', '供应商、模型、baseUrl、部署清单和备份', ['data/ai-provider.txt', 'data/ai-model.txt', 'data/ai-base-url.txt', 'data/dashboard-local-deploy-manifest.json', 'data/dashboard-napcat-dir.txt', 'data/backups/dashboard-local-deploy'].map(existingProjectTarget).filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('napcat-runtime', 'NapCat 安装目录', '默认 runtime/napcat 安装目录', [existingProjectTarget('runtime/napcat'), existingProjectTarget('runtime/NapCat')].filter(Boolean)))
  pushUninstallItem(deleteItems, createUninstallItem('napcat-downloads', 'NapCat 下载缓存', '本工具下载的 NapCat 安装包缓存', [existingProjectTarget('runtime/downloads')].filter(Boolean)))

  const recordedNapcat = readFileSync(LOCAL_NAPCAT_DIR_FILE)
  if (recordedNapcat && fs.existsSync(recordedNapcat) && !isInsidePath(KOISHI_DIR, recordedNapcat)) {
    try {
      assertSafeExternalNapcatDeletePath(recordedNapcat)
      pushUninstallItem(deleteItems, createUninstallItem('external-napcat', '自定义 NapCat 安装目录', '本工具记录过的项目外 NapCat 目录', [{ fullPath: recordedNapcat, path: recordedNapcat, scope: 'externalNapcat' }]))
    } catch (e) {
      warnings.push({ key: 'external-napcat', path: recordedNapcat, reason: '项目外 NapCat 目录未自动删除：' + e.message })
    }
  }

  const keyTargets = []
  if (fs.existsSync(DATA_DIR) && isInsidePath(KOISHI_DIR, DATA_DIR)) {
    let entries = []
    try { entries = fs.readdirSync(DATA_DIR, { withFileTypes: true }) } catch {}
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (/(?:key|token|pwd|password|cookie)/i.test(entry.name)) {
        const rel = path.posix.join('data', entry.name)
        excludedData.add(rel)
        keyTargets.push(projectTarget(rel))
      }
    }
  }
  pushUninstallItem(userDataItems, createUninstallItem('api-secrets', 'API Key 与登录凭据', 'AI Key、Dashboard 密码、重置令牌、cookies 等敏感文件，默认保留', keyTargets, { kind: 'userData', defaultKeep: true }))

  const adminTarget = existingProjectTarget('data/ai-admin-ids.json')
  if (adminTarget) excludedData.add('data/ai-admin-ids.json')
  pushUninstallItem(userDataItems, createUninstallItem('admin-ids', '管理员 ID', '机器人管理员列表，默认保留', [adminTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }))

  const profileTarget = existingProjectTarget('data/user-profiles')
  if (profileTarget) excludedData.add('data/user-profiles')
  pushUninstallItem(userDataItems, createUninstallItem('user-profiles', '用户资料', '用户画像、偏好和长期资料，默认保留', [profileTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }))

  const conversationTarget = existingProjectTarget('data/conversations')
  if (conversationTarget) excludedData.add('data/conversations')
  pushUninstallItem(userDataItems, createUninstallItem('conversations', '会话与记忆', '聊天上下文、会话缓存和记忆数据，默认保留', [conversationTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }))

  const galleryTarget = existingProjectTarget('data/gallery')
  if (galleryTarget) excludedData.add('data/gallery')
  pushUninstallItem(userDataItems, createUninstallItem('gallery-images', '莲莲图集', '用户上传的图集图片，默认保留', [galleryTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }))

  const logTarget = existingProjectTarget('runtime/logs')
  pushUninstallItem(userDataItems, createUninstallItem('runtime-logs', '运行日志', 'Koishi、Dashboard 和部署过程日志，默认保留', [logTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }))

  const otherDataTargets = listExistingDataChildren(excludedData)
  pushUninstallItem(userDataItems, createUninstallItem('other-data', '其他 data 用户数据', '白名单、黑名单、暂停状态、缓存和其他运行数据，默认保留', otherDataTargets, { kind: 'userData', defaultKeep: true }))

  const nodeInfo = getCommandInfo('node', 18)
  const npmInfo = getCommandInfo('npm')
  for (const tool of [nodeInfo, npmInfo]) {
    if (tool.found && !tool.ownedByProject) keepItems.push({ action: 'keep', kind: 'systemTool', label: tool === nodeInfo ? '系统 Node.js' : '系统 npm', path: tool.sourcePath || 'PATH', reason: '系统级工具未由本项目安装，一键卸载只报告不删除', version: tool.version })
  }

  const stats = {
    deleteSize: deleteItems.reduce((sum, item) => sum + item.size, 0),
    userDataSize: userDataItems.reduce((sum, item) => sum + item.size, 0),
    deleteCount: deleteItems.reduce((sum, item) => sum + item.count, 0),
    userDataCount: userDataItems.reduce((sum, item) => sum + item.count, 0),
  }

  return { ok: true, deleteItems, userDataItems, keepItems, warnings, stats, systemTools: { node: nodeInfo, npm: npmInfo }, projectDir: path.resolve(KOISHI_DIR) }
}

function stopLocalDeployProcessesForUninstall() {
  if (process.platform !== 'win32') return [{ type: 'info', message: '非 Windows 后端未执行进程停止' }]
  const roots = uniquePaths([path.resolve(KOISHI_DIR), runtimePath('napcat'), runtimePath('NapCat'), readFileSync(LOCAL_NAPCAT_DIR_FILE)].filter(Boolean))
  const psPaths = roots.map(item => psQuote(path.resolve(item))).join(',')
  const script = `$self = ${process.pid}; $paths = @(${psPaths}); $procs = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -and ($_.Name -match 'node|napcat|qq|electron') -and ($_.CommandLine -match 'koishi|napcat|start-local|onebot') }; foreach ($proc in $procs) { foreach ($item in $paths) { if ($item -and $item.Length -gt 3 -and $proc.CommandLine -like ('*' + $item + '*')) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue; break } } }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] })
    return []
  } catch (e) {
    return [{ type: 'warning', message: '停止本项目相关进程时遇到问题：' + String(e.stderr || e.message || '').trim() }]
  }
}

function removeTarget(target) {
  assertSafeUninstallTarget(target)
  const summary = summarizePath(target.fullPath)
  fs.rmSync(target.fullPath, { recursive: true, force: true })
  return { path: target.path, size: summary.size, count: summary.count, status: 'ok' }
}

function pruneEmptyProjectDirs() {
  for (const rel of ['runtime', 'data/backups', 'data']) {
    try { fs.rmdirSync(resolveProjectRel(rel)) } catch {}
  }
}

function runLocalUninstall(options = {}) {
  const preview = buildLocalUninstallPreview()
  const deleteUserDataKeys = new Set(Array.isArray(options.deleteUserDataKeys) ? options.deleteUserDataKeys.map(String) : [])
  const selectedItems = preview.deleteItems.concat(preview.userDataItems.filter(item => deleteUserDataKeys.has(item.key)))
  const deleted = []
  const kept = preview.keepItems.concat(preview.userDataItems.filter(item => !deleteUserDataKeys.has(item.key)))
  const errors = []
  const warnings = [...(preview.warnings || []), ...stopLocalDeployProcessesForUninstall()]
  for (const item of selectedItems) {
    for (const target of item.targets || []) {
      try { deleted.push({ ...removeTarget(target), item: item.key, label: item.label }) }
      catch (e) { errors.push({ path: target.path, item: item.key, label: item.label, reason: e.message }) }
    }
  }
  pruneEmptyProjectDirs()
  return { ok: errors.length === 0, deleted, kept, warnings, errors, message: errors.length ? '一键卸载完成，但有项目未能删除' : '一键卸载完成' }
}

function normalizeLoggingConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const enabled = !!(Object.prototype.hasOwnProperty.call(source, 'enabled') ? source.enabled : source.debug)
  const modules = {}
  if (source.modules && typeof source.modules === 'object' && !Array.isArray(source.modules)) {
    for (const [key, value] of Object.entries(source.modules)) {
      if (key) modules[String(key)] = !!value
    }
  }
  return { enabled, debug: enabled, modules, updatedAt: Number(source.updatedAt) || 0 }
}

function readLoggingConfig() {
  try { return normalizeLoggingConfig(JSON.parse(fs.readFileSync(DEBUG_LOG_CONFIG_FILE, 'utf8') || '{}')) } catch {}
  const envEnabled = /^(?:1|true|on|yes)$/i.test(String(process.env.DONGXUELIAN_DEBUG || '').trim())
  return normalizeLoggingConfig({ enabled: envEnabled, updatedAt: 0 })
}

function writeLoggingConfig(data) {
  const next = normalizeLoggingConfig({ ...data, updatedAt: Date.now() })
  fs.mkdirSync(path.dirname(DEBUG_LOG_CONFIG_FILE), { recursive: true })
  fs.writeFileSync(DEBUG_LOG_CONFIG_FILE + '.tmp', JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(DEBUG_LOG_CONFIG_FILE + '.tmp', DEBUG_LOG_CONFIG_FILE)
  return next
}

function clampLogLimit(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(MAX_LOG_LIMIT, parsed))
}

function readLastLogLines(file, limit) {
  return readLastLogItems(file, limit).map(item => item.text)
}

function readLastLogItems(file, limit = MAX_LOG_LIMIT) {
  if (!fs.existsSync(file)) return []
  const stat = fs.statSync(file)
  const maxBytes = Math.min(stat.size, Math.max(512 * 1024, Math.min(12 * 1024 * 1024, clampLogLimit(limit) * 1200)))
  const buffer = Buffer.alloc(maxBytes)
  const fd = fs.openSync(file, 'r')
  const startOffset = stat.size - maxBytes
  try {
    fs.readSync(fd, buffer, 0, maxBytes, startOffset)
  } finally {
    fs.closeSync(fd)
  }
  let lineStart = 0
  if (startOffset > 0) {
    const firstBreak = buffer.indexOf(10)
    if (firstBreak >= 0) lineStart = firstBreak + 1
  }
  const items = []
  for (let cursor = lineStart; cursor < buffer.length;) {
    let lineEnd = buffer.indexOf(10, cursor)
    if (lineEnd < 0) lineEnd = buffer.length
    if (lineEnd > cursor) {
      const raw = buffer.slice(cursor, lineEnd).toString('utf8').replace(/\r$/, '')
      if (raw) items.push({ id: startOffset + cursor, text: raw })
    }
    cursor = lineEnd + 1
  }
  return items.slice(-clampLogLimit(limit))
}

function classifyLogLevel(line = '') {
  if (/\[D\]|\bdebug\b|debug:/i.test(line)) return 'D'
  if (/\[E\]|\berror\b|uncaught|exception|failed|fail:/i.test(line)) return 'E'
  if (/\[W\]|\bwarn\b|warning/i.test(line)) return 'W'
  return 'I'
}

function detectLogModule(line = '') {
  const known = ['dongxuelian-ai', 'dashboard', 'koishi', 'adapter-onebot', 'onebot', 'napcat', 'daily-report']
  const lower = String(line).toLowerCase()
  return known.find(name => lower.includes(name)) || 'runtime'
}

function parseLogLine(item, index) {
  const line = typeof item === 'object' && item ? String(item.text || '') : String(item || '')
  const structured = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\[([IWED])\]\s+([^\s]+)\s*(.*)$/)
  const tsMatch = structured ? null : line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}:\d{2}:\d{2}/)
  const level = classifyLogLevel(line)
  const moduleName = structured ? structured[3] : detectLogModule(line)
  const message = structured ? (structured[4] || '').trim() : line.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/, '').trim()
  return {
    id: typeof item === 'object' && Number.isFinite(item.id) ? item.id : index,
    level,
    levelName: level === 'E' ? 'error' : level === 'W' ? 'warn' : level === 'D' ? 'debug' : 'info',
    module: moduleName,
    time: structured ? structured[1] : (tsMatch ? tsMatch[0] : ''),
    message,
    text: line,
  }
}

function readLastLogEntries(file) {
  try {
    const stat = fs.statSync(file)
    if (logEntryCache.file === file && logEntryCache.size === stat.size && logEntryCache.mtimeMs === stat.mtimeMs) return logEntryCache.entries
    const entries = readLastLogItems(file, MAX_LOG_LIMIT).map(parseLogLine)
    logEntryCache = { file, size: stat.size, mtimeMs: stat.mtimeMs, entries }
    return entries
  } catch {
    return logEntryCache.file === file ? logEntryCache.entries : []
  }
}

function buildLogFilterKey(options = {}, limit) {
  const levels = String(options.levels || 'I,W,E,D').split(',').map(item => item.trim().toUpperCase()).filter(Boolean).sort().join(',')
  const moduleFilter = String(options.module || 'all').trim().toLowerCase() || 'all'
  const query = String(options.q || '').trim().toLowerCase()
  const errorsOnly = /^(?:1|true|yes|on)$/i.test(String(options.errorsOnly || '').trim()) ? '1' : '0'
  return [limit, levels, moduleFilter, query, errorsOnly].join('|')
}

function getFilteredLogEntries(options = {}) {
  const limit = clampLogLimit(options.limit)
  const logFile = path.join(KOISHI_DIR, 'koishi.log')
  const levels = new Set(String(options.levels || 'I,W,E,D').split(',').map(item => item.trim().toUpperCase()).filter(Boolean))
  const moduleFilter = String(options.module || '').trim().toLowerCase()
  const query = String(options.q || '').trim().toLowerCase()
  const errorsOnly = /^(?:1|true|yes|on)$/i.test(String(options.errorsOnly || '').trim())
  let entries = readLastLogEntries(logFile)
  if (errorsOnly) entries = entries.filter(item => item.level === 'E')
  else entries = entries.filter(item => levels.has(item.level))
  if (moduleFilter && moduleFilter !== 'all') entries = entries.filter(item => item.module.toLowerCase().includes(moduleFilter) || item.text.toLowerCase().includes(moduleFilter))
  if (query) entries = entries.filter(item => item.text.toLowerCase().includes(query) || item.message.toLowerCase().includes(query))
  const total = entries.length
  const since = Number.parseInt(options.since, 10)
  const filterKey = buildLogFilterKey(options, limit)
  const filterChanged = !!options.filterKey && String(options.filterKey) !== filterKey
  const windowEntries = entries.slice(-limit)
  const newEntries = Number.isFinite(since) && since > 0 && !filterChanged
    ? entries.filter(item => item.id > since).slice(-limit)
    : windowEntries
  const lastId = entries.length ? entries[entries.length - 1].id : (Number.isFinite(since) ? since : 0)
  return { entries: windowEntries, lines: windowEntries.map(item => item.text), total, limit, file: logFile, config: readLoggingConfig(), filterKey, filterChanged, lastId, newEntries, newCount: newEntries.length, truncated: total > limit }
}

function runtimePath(...parts) {
  return path.join(KOISHI_DIR, 'runtime', ...parts)
}

function getLocalDeployTarget() {
  const isWindowsBackend = process.platform === 'win32'
  const workDirSafety = getLocalWorkDirSafety()
  const blockedReason = isWindowsBackend ? '' : `当前 Dashboard 后端是 ${process.platform}/${process.arch}，Windows 本地部署需要在 Windows 部署器软件中运行。远端网页只能检测服务器，不能检测浏览器所在的 Windows 电脑。`
  return {
    kind: 'dashboard-backend',
    scope: 'backend-machine',
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    projectDir: path.resolve(KOISHI_DIR),
    runtimeDir: runtimePath(),
    workspace: workDirSafety,
    isWindowsBackend,
    isLocalDeployer: isGlobalLocalMode(),
    canRunWindowsLocalDeploy: isWindowsBackend,
    blocked: !isWindowsBackend,
    blockedReason,
    guidance: isWindowsBackend ? '当前 Dashboard 后端运行在 Windows，可作为本地部署目标。' : '请在要部署的 Windows 本机启动部署器软件，并访问 http://127.0.0.1:5150/dashboard/。',
  }
}

function requireWindowsLocalDeployTarget(req, res) {
  const target = getLocalDeployTarget()
  if (target.canRunWindowsLocalDeploy) return true
  json(res, { ok: false, blocked: true, localDeployTarget: target, message: target.blockedReason }, 403)
  return false
}

function writeRuntimeLayout(options = {}) {
  const includeNapcat = options.includeNapcat !== false
  const includeNodeModules = options.includeNodeModules !== false
  const dirs = [
    runtimePath(),
    runtimePath('downloads'),
    runtimePath('logs'),
    path.join(KOISHI_DIR, 'data'),
  ]
  if (includeNapcat) dirs.push(runtimePath('napcat'))
  if (includeNodeModules) dirs.push(path.join(KOISHI_DIR, 'node_modules'))
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
}

function testChinesePathWrite(dir) {
  try {
    const testFile = path.join(dir, '中文路径写入测试.tmp')
    fs.writeFileSync(testFile, 'ok', 'utf8')
    const ok = fs.readFileSync(testFile, 'utf8') === 'ok'
    fs.unlinkSync(testFile)
    return { ok }
  } catch (e) { return { ok: false, message: e.message } }
}

function downloadToRuntime(url, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  options = options || {}
  let parsed
  try { parsed = new URL(url) } catch { callback(new Error('下载地址无效')); return }
  if (!['http:', 'https:'].includes(parsed.protocol)) { callback(new Error('只支持 http/https 下载地址')); return }
  writeRuntimeLayout({ includeNapcat: false, includeNodeModules: false })
  const client = parsed.protocol === 'https:' ? https : http
  const req = client.get(parsed, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume()
      const nextUrl = new URL(response.headers.location, parsed).toString()
      downloadToRuntime(nextUrl, options, callback)
      return
    }
    if (response.statusCode !== 200) {
      response.resume()
      callback(new Error('下载失败：HTTP ' + response.statusCode))
      return
    }
    const name = getDownloadFileName(parsed, response, options)
    const filePath = runtimePath('downloads', name)
    const stream = fs.createWriteStream(filePath)
    response.pipe(stream)
    stream.on('finish', () => stream.close(() => {
      try { callback(null, filePath, validateDownloadedFile(filePath, { ...options, expectedContentType: response.headers['content-type'] })) }
      catch (e) { callback(e, filePath) }
    }))
    stream.on('error', callback)
  })
  req.setTimeout(120000, () => req.destroy(new Error('下载超时')))
  req.on('error', callback)
}

const localTasks = {
  npmInstall: { label: 'npm install', logFile: runtimePath('logs', 'npm-install.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  napcat: { label: 'NapCat', logFile: runtimePath('logs', 'napcat.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  koishi: { label: 'Koishi', logFile: runtimePath('logs', 'koishi-local.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
}

function appendLocalTaskLog(task, chunk) {
  try {
    fs.mkdirSync(path.dirname(task.logFile), { recursive: true })
    fs.appendFileSync(task.logFile, String(chunk), 'utf8')
  } catch {}
}

function getTaskPublicStatus(key, extra = {}) {
  const task = localTasks[key]
  return {
    state: task.state,
    running: !!task.running,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error,
    pid: task.pid,
    command: task.command,
    cwd: task.cwd,
    logFile: task.logFile,
    logLines: readLastLogLines(task.logFile, 160),
    ...extra,
  }
}

function redactProxyValue(value) {
  const text = String(value || '').trim()
  if (!text || text === 'null' || text === 'undefined') return ''
  return text.replace(/(https?:\/\/)([^/@\s]+)@/i, '$1***@')
}

function runNpmConfigGet(name) {
  const npm = getLocalToolCommand('npm')
  try {
    const args = ['config', 'get', name]
    const output = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(npm)
      ? execFileSync('cmd.exe', ['/d', '/c', npm, ...args], { cwd: KOISHI_DIR, env: getLocalToolEnv(), timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync(npm, args, { cwd: KOISHI_DIR, env: getLocalToolEnv(), timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return redactProxyValue(output)
  } catch { return '' }
}

function psCommandArg(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function formatLocalNpmCommand(args = []) {
  const npm = getLocalToolCommand('npm')
  if (process.platform === 'win32') {
    const prefix = npm === 'npm' ? 'npm' : '& ' + psCommandArg(npm)
    return [prefix].concat(args.map(psCommandArg)).join(' ')
  }
  return [shellQuote(npm)].concat(args.map(shellQuote)).join(' ')
}

function getNoProxyEnvOverrides() {
  return Object.fromEntries(NPM_PROXY_ENV_KEYS.map(key => [key, '']))
}

function runNpmCommand(args, options = {}) {
  const npm = getLocalToolCommand('npm')
  const env = getLocalToolEnv(options.env || {})
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(npm)) {
    return execFileSync('cmd.exe', ['/d', '/c', npm, ...args], { cwd: options.cwd || KOISHI_DIR, env, timeout: options.timeout || 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return execFileSync(npm, args, { cwd: options.cwd || KOISHI_DIR, env, timeout: options.timeout || 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function collectNpmInstallDiagnostics(force = false) {
  const now = Date.now()
  if (!force && npmDiagnosticsCache.data && now - npmDiagnosticsCache.at < 10000) return npmDiagnosticsCache.data
  const nodeInfo = getCommandInfo('node', 18)
  const npmInfo = getCommandInfo('npm')
  const workspace = getLocalWorkDirSafety()
  const env = {
    HTTP_PROXY: redactProxyValue(process.env.HTTP_PROXY || process.env.http_proxy),
    HTTPS_PROXY: redactProxyValue(process.env.HTTPS_PROXY || process.env.https_proxy),
    ALL_PROXY: redactProxyValue(process.env.ALL_PROXY || process.env.all_proxy),
    NO_PROXY: redactProxyValue(process.env.NO_PROXY || process.env.no_proxy),
    npm_config_proxy: redactProxyValue(process.env.npm_config_proxy || process.env.NPM_CONFIG_PROXY),
    npm_config_https_proxy: redactProxyValue(process.env.npm_config_https_proxy || process.env.NPM_CONFIG_HTTPS_PROXY),
    npm_config_all_proxy: redactProxyValue(process.env.npm_config_all_proxy || process.env.NPM_CONFIG_ALL_PROXY),
  }
  const config = {
    proxy: runNpmConfigGet('proxy'),
    httpsProxy: runNpmConfigGet('https-proxy'),
    registry: redactProxyValue(runNpmConfigGet('registry')) || 'https://registry.npmjs.org/',
  }
  const data = {
    env,
    config,
    checkedAt: now,
    workspace,
    paths: {
      projectDir: path.resolve(KOISHI_DIR),
      runtimeDir: runtimePath(),
      portableNodeDir: getPortableNodeDir(),
      nodeModulesPath: path.join(KOISHI_DIR, 'node_modules'),
    },
    tools: {
      nodeSourcePath: nodeInfo.sourcePath || '',
      nodeSource: nodeInfo.source || '',
      npmSourcePath: npmInfo.sourcePath || '',
      npmSource: npmInfo.source || '',
      npmCommand: getLocalToolCommand('npm'),
    },
    dependencies: getProjectDependencyStatus(),
  }
  data.proxy = diagnoseNpmProxy(data)
  npmDiagnosticsCache = { at: now, data }
  return data
}

function collectNpmProxyCandidates(diagnostics = {}) {
  const candidates = []
  for (const [key, value] of Object.entries(diagnostics.env || {})) {
    if (/^no_proxy$/i.test(key)) continue
    const endpoint = parseProxyEndpoint(value)
    if (endpoint) candidates.push({ source: 'env', key, ...endpoint })
  }
  for (const [key, value] of Object.entries({ proxy: diagnostics.config?.proxy, httpsProxy: diagnostics.config?.httpsProxy })) {
    const endpoint = parseProxyEndpoint(value)
    if (endpoint) candidates.push({ source: 'npm config', key, ...endpoint })
  }
  return candidates
}

function diagnoseNpmProxy(diagnostics = {}) {
  const candidates = collectNpmProxyCandidates(diagnostics)
  const loopback = candidates.filter(item => isLoopbackProxyHost(item.hostname))
  const staleLoopback = []
  for (const item of loopback) {
    const portState = checkPortState(item.port)
    if (portState.status !== 'occupied') staleLoopback.push({ ...item, portState })
  }
  return {
    candidates,
    loopback,
    staleLoopback,
    shouldBypass: staleLoopback.length > 0,
    reason: staleLoopback.length ? `检测到失效本机代理 ${staleLoopback.map(item => `${item.hostname}:${item.port}`).join('、')}` : (loopback.length ? '检测到本机代理端口正在监听' : ''),
  }
}

function repairNpmProxyConfig(env = getNoProxyEnvOverrides()) {
  const actions = []
  for (const args of [
    ['config', 'delete', 'proxy'],
    ['config', 'delete', 'https-proxy'],
    ['config', 'set', 'registry', 'https://registry.npmmirror.com'],
  ]) {
    try {
      runNpmCommand(args, { env })
      actions.push({ command: formatLocalNpmCommand(args), ok: true })
    } catch (e) {
      actions.push({ command: formatLocalNpmCommand(args), ok: false, message: String(e.stderr || e.message || '').trim() })
    }
  }
  return actions
}

function prepareNpmInstallRun(options = {}) {
  const forceRepair = !!options.forceRepair
  const diagnostics = collectNpmInstallDiagnostics(true)
  const proxy = diagnostics.proxy || diagnoseNpmProxy(diagnostics)
  const shouldClean = forceRepair || proxy.shouldBypass
  const env = shouldClean ? getNoProxyEnvOverrides() : {}
  const repair = {
    forced: forceRepair,
    automatic: !forceRepair && proxy.shouldBypass,
    envClearedForRetry: shouldClean,
    reason: shouldClean ? (proxy.reason || '已清理本次 npm install 的代理环境') : '',
    actions: [],
  }
  if (shouldClean) repair.actions = repairNpmProxyConfig(env)
  diagnostics.proxy = proxy
  diagnostics.repair = repair
  return { env, diagnostics, repair }
}

function commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy) {
  const commands = []
  if (hasEnvProxy && process.platform === 'win32') {
    for (const key of NPM_PROXY_ENV_KEYS) commands.push(`$env:${key} = ""`)
  }
  if (hasNpmProxy) {
    commands.push(formatLocalNpmCommand(['config', 'delete', 'proxy']))
    commands.push(formatLocalNpmCommand(['config', 'delete', 'https-proxy']))
  }
  commands.push(formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com']))
  return commands
}

function buildNpmInstallFailureGuide(logLines = [], diagnostics = null) {
  const text = Array.isArray(logLines) ? logLines.join('\n') : String(logLines || '')
  const diag = diagnostics || collectNpmInstallDiagnostics()
  const hasNpmProxy = !!(diag.config?.proxy || diag.config?.httpsProxy)
  const hasEnvProxy = Object.entries(diag.env || {}).some(([key, value]) => !/^no_proxy$/i.test(key) && !!value)
  if (!text.trim()) return null

  const refused = /ECONNREFUSED/i.test(text)
  const inline = text.match(/ECONNREFUSED[^\n]*(127(?:\.\d+){3}|localhost)(?::(\d+))?/i)
  const addressMatch = text.match(/address:\s*['"]?([^,'"\s}]+)/i)
  const portMatch = text.match(/port:\s*['"]?(\d+)/i)
  const proxyHost = inline?.[1] || addressMatch?.[1] || ''
  const proxyPort = inline?.[2] || portMatch?.[1] || ''
  if (refused && (proxyHost || proxyPort)) {
    const endpoint = [proxyHost || '127.0.0.1', proxyPort].filter(Boolean).join(':')
    return {
      code: 'NPM_PROXY_REFUSED',
      title: 'npm 连接本机代理失败',
      summary: `npm 正在通过本机代理 ${endpoint} 访问 npm registry，但这个端口连不上。通常是代理软件没有启动、端口变了，或 npm 里残留了旧代理配置。`,
      fixSteps: [
        `如果你需要代理，请先打开代理软件，并确认它监听的是 ${endpoint}。`,
        diag.repair?.envClearedForRetry ? '部署器已尝试清理本次 npm install 的代理环境；如果仍失败，请确认是否还有系统代理或安全软件接管了连接。' : '如果你不需要代理，优先点击“一键修复代理并重试”，部署器会用内部 npm 路径执行修复并清理本次 npm install 的代理环境。',
        '下面的命令已使用部署器实际 npm 路径；普通 PowerShell 里没有全局 npm 时也可以复制执行。',
        '处理完成后，回到部署器点击“执行 npm install”或“一键修复代理并重试”。',
      ],
      commands: commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy),
      diagnostics: diag,
    }
  }
  if (/EAI_AGAIN|ENOTFOUND/i.test(text)) return { code: 'NPM_DNS_FAILED', title: 'npm 域名解析失败', summary: 'npm 无法解析 registry 域名，通常是 DNS、网络或代理配置问题。', fixSteps: ['确认电脑可以打开 npm registry 或 npm 镜像源网站。', '切换网络或 DNS 后重试。', '如果使用代理，请确认代理软件已启动。'], commands: [formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i.test(text)) return { code: 'NPM_TIMEOUT', title: 'npm 下载超时', summary: 'npm registry 响应太慢或网络被代理/防火墙阻断。', fixSteps: ['先确认网络稳定。', '可以切换到 npm 镜像源后重试。', '如果使用代理，请确认代理软件运行正常。'], commands: [formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to verify the first certificate/i.test(text)) return { code: 'NPM_CERT_FAILED', title: 'npm 证书校验失败', summary: '网络代理或证书环境让 npm 无法校验证书。', fixSteps: ['优先检查代理软件的 HTTPS 解密/证书设置。', '确认系统时间正确。', '不要随意关闭 strict-ssl，除非你明确知道当前网络环境需要这样做。'], commands: [formatLocalNpmCommand(['config', 'get', 'strict-ssl'])], diagnostics: diag }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) return { code: 'NPM_PERMISSION_FAILED', title: 'npm 写入文件失败', summary: 'npm 没有权限写入项目目录，或文件正被其他进程占用。', fixSteps: ['关闭正在占用项目目录的终端、编辑器或杀毒拦截。', '确认部署器所在目录可写，不要放在 Program Files 等系统目录。', '重新打开部署器后再试一次。'], commands: [], diagnostics: diag }
  if (/\bE401\b|\bE403\b|unauthorized|forbidden/i.test(text)) return { code: 'NPM_AUTH_FAILED', title: 'npm registry 权限错误', summary: '当前 registry 拒绝访问，可能是私有源认证过期或 registry 配错。', fixSteps: ['检查 npm registry 是否应为公开源。', '如果不需要私有源，切换到 npm 镜像源后重试。'], commands: [formatLocalNpmCommand(['config', 'get', 'registry']), formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/npm error/i.test(text)) return { code: 'NPM_FAILED', title: 'npm install 失败', summary: 'npm install 已退出，部署器暂时无法判断唯一原因。请先查看下方原始日志里最靠前的 npm error。', fixSteps: ['优先处理日志中第一条 npm error。', '确认网络、代理、磁盘权限和项目目录可写。', '处理后点击“执行 npm install”重试。'], commands: [formatLocalNpmCommand(['config', 'get', 'registry'])], diagnostics: diag }
  return null
}

function startNpmInstallTask(options = {}) {
  const prepared = options.prepared || prepareNpmInstallRun({ forceRepair: !!options.forceRepair })
  return spawnLocalTask('npmInstall', getLocalToolCommand('npm'), ['install'], getLocalTaskOptions({ cwd: KOISHI_DIR, shell: process.platform === 'win32', env: { ...prepared.env, ...(options.env || {}) }, diagnostics: prepared.diagnostics }))
}

function repairNpmProxyAndStartInstall() {
  const dependencies = getProjectDependencyStatus()
  if (dependencies.ready) return { ok: true, skipped: true, message: '项目依赖已安装', actions: [], status: getLocalNpmInstallStatus() }
  const npmInfo = getCommandInfo('npm')
  if (!npmInfo.found) return { ok: false, message: '当前 Windows 本机未找到 npm，请先安装便携 Node/npm 后重新检测环境', npm: npmInfo }
  const prepared = prepareNpmInstallRun({ forceRepair: true })
  const started = startNpmInstallTask({ prepared })
  return { ok: true, message: started.alreadyRunning ? 'npm install 正在运行' : '已清理本次部署器 npm 代理并重新启动 npm install', actions: prepared.repair.actions, status: getLocalNpmInstallStatus() }
}

function getBlockedLocalTaskStatus(key, extra = {}) {
  const target = getLocalDeployTarget()
  return getTaskPublicStatus(key, {
    blocked: true,
    localDeployTarget: target,
    running: false,
    message: target.blockedReason,
    ...extra,
  })
}

function spawnLocalTask(key, command, args = [], options = {}) {
  const task = localTasks[key]
  if (!task) throw new Error('unknown local task')
  if (task.running && task.process && !task.process.killed) return { alreadyRunning: true, status: getTaskPublicStatus(key) }
  fs.mkdirSync(path.dirname(task.logFile), { recursive: true })
  task.state = 'running'
  task.running = true
  task.startedAt = Date.now()
  task.finishedAt = 0
  task.exitCode = null
  task.error = ''
  task.diagnostics = options.diagnostics || null
  task.pid = 0
  task.command = [command].concat(args).join(' ')
  task.cwd = options.cwd || KOISHI_DIR
  fs.writeFileSync(task.logFile, `[${new Date().toISOString()}] $ ${task.command}\n`, 'utf8')
  const child = spawn(command, args, {
    cwd: task.cwd,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
    shell: options.shell === true,
  })
  task.process = child
  task.pid = child.pid || 0
  child.stdout?.on('data', chunk => appendLocalTaskLog(task, chunk))
  child.stderr?.on('data', chunk => appendLocalTaskLog(task, chunk))
  child.on('error', err => {
    task.error = err.message
    task.state = 'failed'
    task.running = false
    task.finishedAt = Date.now()
    appendLocalTaskLog(task, `\n[${new Date().toISOString()}] ERROR ${err.message}\n`)
  })
  child.on('close', code => {
    task.running = false
    task.process = null
    task.exitCode = code
    task.finishedAt = Date.now()
    task.state = code === 0 ? 'success' : 'failed'
    appendLocalTaskLog(task, `\n[${new Date().toISOString()}] EXIT ${code}\n`)
  })
  return { alreadyRunning: false, status: getTaskPublicStatus(key) }
}

function getAiKeyStatus(providerInput) {
  const provider = String(providerInput || readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'opencode').trim() || 'opencode'
  const keyFiles = {
    opencode: path.join(DATA_DIR, 'ai-openai-key.txt'),
    deepseek: path.join(DATA_DIR, 'ai-deepseek-key.txt'),
    dashscope: path.join(DATA_DIR, 'ai-dashscope-key.txt'),
    glm: path.join(DATA_DIR, 'ai-glm-key.txt'),
    mimorium: path.join(DATA_DIR, 'ai-mimorium-key.txt'),
  }
  const file = keyFiles[provider] || keyFiles.opencode
  const value = readFileSync(file)
  return {
    provider,
    configured: !!value.trim(),
    path: isInsidePath(KOISHI_DIR, file) ? toProjectRel(file) : file,
    reason: value.trim() ? 'AI Key 已配置' : 'AI Key 未配置，基础部署可继续，AI 回复暂不可用',
  }
}

function getNapcatStartEntry() {
  const detected = detectNapcatInstallation()
  const entryRe = /\.(exe|bat|cmd|js|mjs)$/i
  const direct = detected.entry && entryRe.test(detected.entry) ? detected.entry : ''
  if (direct) return { detected, entry: direct }
  const roots = uniquePaths([detected.path, detected.expectedPath, readFileSync(LOCAL_NAPCAT_DIR_FILE)].filter(Boolean))
  for (const root of roots) {
    const marker = sortNapcatEntries(findNapcatMarkers(root).markers).find(item => entryRe.test(item.path))
    if (marker) return { detected, entry: marker.path }
  }
  return { detected, entry: '' }
}

function getNapcatLoginHint() {
  const lines = readLastLogLines(localTasks.napcat.logFile, 220).join('\n')
  if (/登录成功|已登录|login\s+success|account.*online/i.test(lines)) return { status: 'ok', reason: '日志显示 NapCat 已登录' }
  if (/二维码|扫码|qrcode|scan|login/i.test(lines)) return { status: 'waiting', reason: 'NapCat 已启动，等待扫码或登录确认' }
  return { status: 'unknown', reason: '暂未能从日志确认登录状态，请在 NapCat WebUI 或控制台完成扫码' }
}

function getLocalNapcatDeployStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    return getBlockedLocalTaskStatus('napcat', {
      found: false,
      installation: detectNapcatInstallation(),
      webuiPort: { available: false, status: 'unsupported', reason: target.blockedReason },
      onebotPort: { available: false, status: 'unsupported', reason: target.blockedReason },
      webuiUrl: '',
      tokenAvailable: false,
      login: { status: 'blocked', reason: target.blockedReason },
    })
  }
  const detected = detectNapcatInstallation()
  const webuiPort = checkPortState(6099)
  const onebotPort = checkPortState(8080)
  const token = process.env.NAPCAT_TOKEN || getNapcatToken()
  const login = getNapcatLoginHint()
  return getTaskPublicStatus('napcat', {
    found: detected.found,
    installation: detected,
    running: localTasks.napcat.running || webuiPort.status === 'occupied' || onebotPort.status === 'occupied',
    webuiPort,
    onebotPort,
    webuiUrl: 'http://127.0.0.1:6099/',
    tokenAvailable: !!token,
    login,
  })
}

function getLocalKoishiDeployStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    return getBlockedLocalTaskStatus('koishi', {
      port: { available: false, status: 'unsupported', reason: target.blockedReason },
      loaded: false,
      url: '',
    })
  }
  const port = checkPortState(5140)
  const lines = readLastLogLines(localTasks.koishi.logFile, 220).join('\n')
  const loaded = /adapter-onebot|dongxuelian-ai|server listening|app started|koishi/i.test(lines)
  return getTaskPublicStatus('koishi', {
    running: localTasks.koishi.running || port.status === 'occupied',
    port,
    loaded,
    url: 'http://127.0.0.1:5140/',
  })
}

function getLocalNpmInstallStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    return getBlockedLocalTaskStatus('npmInstall', { dependencies: { ready: false, reason: target.blockedReason } })
  }
  const status = getTaskPublicStatus('npmInstall', { dependencies: getProjectDependencyStatus() })
  const guide = buildNpmInstallFailureGuide(status.logLines, localTasks.npmInstall.diagnostics)
  return { ...status, failureGuide: guide }
}

function buildLocalReadyCheck() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    const checks = { node: false, npm: false, dependencies: false, localConfig: false, napcatInstalled: false, napcatStarted: false, onebotPort: false, koishiStarted: false, aiKey: false }
    return {
      ok: true,
      blocked: true,
      localDeployTarget: target,
      basicReady: false,
      fullyReady: false,
      checks,
      node: { ok: false, reason: target.blockedReason },
      npm: { found: false, reason: target.blockedReason },
      dependencies: { ready: false, reason: target.blockedReason },
      localConfig: { ok: true, files: [], protected: [] },
      napcat: getLocalNapcatDeployStatus(),
      koishi: getLocalKoishiDeployStatus(),
      aiKey: getAiKeyStatus(),
      dashboardUrl: '',
      koishiUrl: '',
      napcatUrl: '',
      message: target.blockedReason,
    }
  }
  const nodeInfo = getCommandInfo('node', 18)
  const npmInfo = getCommandInfo('npm')
  const dependencies = getProjectDependencyStatus()
  const localConfig = buildLocalConfigPreview()
  const napcat = getLocalNapcatDeployStatus()
  const koishi = getLocalKoishiDeployStatus()
  const aiKey = getAiKeyStatus()
  const checks = {
    node: nodeInfo.ok,
    npm: npmInfo.found,
    dependencies: dependencies.ready,
    localConfig: (localConfig.files || []).some(item => item.action === 'delete' && item.path === 'koishi.yml'),
    napcatInstalled: napcat.found,
    napcatStarted: napcat.running,
    onebotPort: napcat.onebotPort.status === 'occupied',
    koishiStarted: koishi.running,
    aiKey: aiKey.configured,
  }
  const basicReady = checks.node && checks.npm && checks.dependencies && checks.localConfig && checks.napcatInstalled && checks.napcatStarted && checks.onebotPort && checks.koishiStarted
  return {
    ok: true,
    blocked: false,
    localDeployTarget: target,
    basicReady,
    fullyReady: basicReady && checks.aiKey,
    checks,
    node: nodeInfo,
    npm: npmInfo,
    dependencies,
    localConfig,
    napcat,
    koishi,
    aiKey,
    dashboardUrl: `http://127.0.0.1:${PORT}/dashboard/`,
    koishiUrl: 'http://127.0.0.1:5140/',
    napcatUrl: 'http://127.0.0.1:6099/',
    message: basicReady ? (aiKey.configured ? '本地部署已完成，AI Key 已配置' : '基础部署已完成，AI Key 未配置，AI 回复暂不可用') : '本地部署尚未完全就绪，请查看未通过的检查项',
  }
}

// 前端重建状态
let rebuildStatus = { state: 'idle', message: '', detail: '', startedAt: 0, finishedAt: 0 }

// 版本指纹：对关键代码文件做 hash，不依赖 git
function computeFingerprint() {
  try {
    const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
    const hash = crypto.createHash('md5')
    const add = rel => hashFile(hash, repoRoot, path.join(repoRoot, rel))
    add('packages/koishi-plugin-dashboard/standalone.js')
    add('packages/koishi-plugin-dashboard/frontend/dist/index.html')
    add('scripts/restart-bot.sh')
    add('scripts/watchdog.sh')
    for (const file of listFilesRecursive(path.join(repoRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'dist', 'assets'))) {
      hashFile(hash, repoRoot, file)
    }
    const packagesDir = path.join(repoRoot, 'packages')
    let packageNames = []
    try { packageNames = fs.readdirSync(packagesDir).sort() } catch {}
    for (const pkg of packageNames) {
      const pkgDir = path.join(packagesDir, pkg)
      try { if (!fs.statSync(pkgDir).isDirectory()) continue } catch { continue }
      add(`packages/${pkg}/package.json`)
      for (const file of listFilesRecursive(path.join(pkgDir, 'lib'), f => /\.js$/i.test(f))) {
        hashFile(hash, repoRoot, file)
      }
    }
    return hash.digest('hex').slice(0, 8)
  } catch { return 'unknown' }
}

// ====== Auth ======
function createToken() {
  return crypto.createHash('sha256').update('dashboard:' + getAccessPassword()).digest('hex')
}

function validateToken(token) {
  return token === createToken()
}

// ====== 管理员密码系统（敏感操作二次验证） ======
function getAdminPassword() {
  return readFileSync(ADMIN_PWD_FILE) || ADMIN_PASSWORD
}
function getAccessPassword() {
  return readFileSync(ACCESS_PWD_FILE) || readFileSync(LEGACY_ACCESS_PWD_FILE) || PASSWORD
}
function createAdminToken() {
  return crypto.createHash('sha256').update('admin:' + getAdminPassword()).digest('hex')
}
function validateAdminToken(token) {
  return token === createAdminToken()
}

function generateResetToken() {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(RESET_TOKEN_FILE), { recursive: true })
    fs.writeFileSync(RESET_TOKEN_FILE, token, 'utf8')
  } catch (e) { log('WARNING: 无法写入重置令牌文件: ' + e.message) }
  return token
}

function getResetToken() {
  return readFileSync(RESET_TOKEN_FILE) || ''
}

function requireAdmin(req, res) {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// ====== NapCat Token ======
function getNapcatToken() {
  if (getNapcatToken._cached) return getNapcatToken._cached
  const recordedDir = readFileSync(LOCAL_NAPCAT_DIR_FILE)
  const candidates = [
    recordedDir ? path.join(recordedDir, 'config', 'webui.json') : '',
    path.join(KOISHI_DIR, 'runtime', 'napcat', 'config', 'webui.json'),
    path.join(KOISHI_DIR, 'runtime', 'NapCat', 'config', 'webui.json'),
    '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json',
    process.env.NAPCAT_CONFIG || '',
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (cfg.token) { getNapcatToken._cached = cfg.token; return cfg.token }
    } catch {}
  }
  return ''
}

// ====== NapCat 代理 ======
function napcatProxy(req, res, targetPath) {
  const host = process.env.NAPCAT_HOST || '127.0.0.1'
  const port = process.env.NAPCAT_PORT || 6099
  const token = process.env.NAPCAT_TOKEN || getNapcatToken()
  const opts = { hostname: host, port, path: targetPath, method: req.method, headers: { ...req.headers, host: host + ':' + port } }
  if (token) opts.headers['Authorization'] = 'Bearer ' + token
  const proxyReq = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode === 401 && token) {
      opts.headers['Authorization'] = ''
      http.request(opts, (r2) => { napcatRespond(res, r2, token) }).on('error', () => { res.writeHead(502); res.end('proxy error') }).end()
      proxyRes.resume()
      return
    }
    napcatRespond(res, proxyRes, token)
  })
  proxyReq.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('NapCat proxy error') })
  req.pipe(proxyReq)
}

function napcatRespond(res, proxyRes, token) {
  const contentType = proxyRes.headers['content-type'] || ''
  if (contentType.includes('text/html') && token) {
    let body = ''
    proxyRes.on('data', c => body += c)
    proxyRes.on('end', () => {
      const injected = body.replace('</head>', `<script>localStorage.setItem('token','${token}');</script></head>`)
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, 'content-length': Buffer.byteLength(injected) })
      res.end(injected)
    })
    return
  }
  res.writeHead(proxyRes.statusCode, proxyRes.headers)
  proxyRes.pipe(res)
}

// ====== HTTP 服务器 ======
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 登录
  if (pathname === '/dashboard/api/login' && req.method === 'POST') {
    collectBody(req, res, (body) => {
      try {
        const { password } = JSON.parse(body)
        const stored = getAccessPassword()
        if (!stored && !isLocalAuthBypass(req)) {
          log('login rejected: access password is not configured')
          return json(res, { ok: false, message: '访问密码未配置' }, 503)
        }
        const match = isLocalAuthBypass(req) || (!!stored && password === stored)
        if (match) return json(res, { ok: true, token: createToken() })
        log('login failed')
        return json(res, { ok: false, message: '密码错误' }, 401)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 管理员验证（不需要普通登录）
  if (pathname === '/dashboard/api/admin/verify' && req.method === 'POST') {
    if (isLocalAuthBypass(req)) return json(res, { ok: true, token: createAdminToken() })
    collectBody(req, res, (body) => {
      try {
        const { password } = JSON.parse(body)
        if (password === getAdminPassword()) return json(res, { ok: true, token: createAdminToken() })
        return json(res, { ok: false, message: '管理员密码错误' }, 401)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 修改密码
  if (pathname === '/dashboard/api/auth/password' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { type, oldPassword, newPassword } = JSON.parse(body)
        if (!newPassword || newPassword.length < 3) return json(res, { ok: false, message: '新密码长度不能少于3位' }, 400)
        if (!/^[A-Za-z0-9_~!@#$%^&*()\-+=\[\]{}<>,.?/|\\:;"'`]+$/.test(newPassword)) {
          return json(res, { ok: false, message: '密码仅支持大小写字母、数字、下划线和常见特殊字符' }, 400)
        }
        if (type === 'admin') {
          if (oldPassword !== getAdminPassword()) return json(res, { ok: false, message: '当前管理员密码错误' }, 401)
          writeFileSync(ADMIN_PWD_FILE, newPassword)
          return json(res, { ok: true, message: '管理员密码已更新' })
        } else if (type === 'access') {
          writeFileSync(ACCESS_PWD_FILE, newPassword)
          return json(res, { ok: true, message: '访问密码已更新，请重新登录' })
        }
        return json(res, { ok: false, message: '无效类型' }, 400)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 忘记密码 - 通过重置令牌恢复默认密码
  if (pathname === '/dashboard/api/auth/reset-password' && req.method === 'POST') {
    collectBody(req, res, (body) => {
      try {
        const { resetToken } = JSON.parse(body)
        const stored = getResetToken()
        if (!stored || !resetToken || resetToken.trim() !== stored.trim()) {
          return json(res, { ok: false, message: '重置令牌无效' }, 403)
        }
        try { fs.unlinkSync(ACCESS_PWD_FILE) } catch {}
        try { fs.unlinkSync(ADMIN_PWD_FILE) } catch {}
        try { fs.unlinkSync(LEGACY_ACCESS_PWD_FILE) } catch {}
        generateResetToken()
        return json(res, { ok: true, message: '所有密码已重置为默认值 123，请登录后在安全设置中修改' })
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // Auth 检查（显式本地模式自动放行）
  if (pathname.startsWith('/dashboard/api/') && !isLocalAuthBypass(req)) {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!validateToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: '请先登录', code: 'AUTH_REQUIRED' }))
      return
    }
  }

  // ===== API 路由 =====
  if (pathname === '/dashboard/api/status' && req.method === 'GET') {
    return json(res, {
      provider: readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
      model: readFileSync(path.join(DATA_DIR, 'ai-model.txt')) || '',
    })
  }

  if (pathname === '/dashboard/api/providers' && req.method === 'GET') {
    const { PROVIDERS } = require(path.join(AI_LIB, 'constants'))
    const merged = { ...PROVIDERS }
    try {
      const raw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
      const custom = JSON.parse(raw)
      if (Array.isArray(custom)) {
        for (const p of custom) {
          if (p.id && p.name && p.baseURL) {
            merged[p.id] = { name: p.name, baseURL: p.baseURL, models: Array.isArray(p.models) ? p.models : [] }
          }
        }
      }
    } catch {}
    return json(res, merged)
  }

  if (pathname === '/dashboard/api/config' && req.method === 'GET') {
    return json(res, {
      provider: readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
      model: readFileSync(path.join(DATA_DIR, 'ai-model.txt')) || '',
      baseUrl: readFileSync(path.join(DATA_DIR, 'ai-base-url.txt')) || '',
    })
  }

  if (pathname === '/dashboard/api/config' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body)
        if (data.provider !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-provider.txt'), data.provider)
        if (data.model !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-model.txt'), data.model)
        if (data.baseUrl !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-base-url.txt'), data.baseUrl)
        const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
        resetConfigCache()
        json(res, { ok: true, message: '配置已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'GET') {
    try {
      const { getAvailablePersonals, loadPersonalSkill } = require(path.join(AI_LIB, 'persona'))
      const name = url.searchParams.get('name')
      if (name) {
        const content = loadPersonalSkill(name)
        if (!content) return json(res, { ok: false, message: '未找到人格' }, 404)
        const m = String(content || '').replace(/^\uFEFF/, '').match(/^---\n([\s\S]*?)\n---\n\n?/)
        let meta = {}
        if (m) {
          for (const line of m[1].split('\n')) {
            const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
            if (kv) meta[kv[1]] = kv[2].trim()
          }
        }
        const bodyContent = m ? content.slice(m[0].length) : content
        return json(res, { ok: true, data: { name, description: meta.description || '', lore: meta.lore || '', will: meta.will || 1.0, nsfw: meta.nsfw || 'none', content: bodyContent } })
      }
      return json(res, getAvailablePersonals().map(p => ({ name: p.name, description: p.description, type: p.type || 'persona' })))
    } catch { return json(res, []) }
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, description, lore, will, nsfw, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const sanitized = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '')
        const filePath = path.join(PERSONAS_DIR, 'SKILL.' + sanitized + '.md')
        if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名人格已存在' }, 400)
        const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
        const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
        const nsfwLine = nsfw && nsfw !== 'none' ? '\nnsfw: ' + nsfw : ''
        const md = '---\nname: ' + sanitized + '\ndescription: ' + (description || '') + loreLine + willLine + nsfwLine + '\n---\n\n' + content
        fs.writeFileSync(filePath, md, 'utf8')
        json(res, { ok: true, message: '人格 ' + sanitized + ' 已创建' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
        const all = require(path.join(AI_LIB, 'persona')).getAvailablePersonals()
        if (all.find(p => p.name === name)?.type === 'core') return json(res, { ok: false, message: '核心规则不可删除' }, 400)
        if (all.find(p => p.name === name)?.type === 'mode') return json(res, { ok: false, message: '默认人格不可删除' }, 400)
        const files = fs.readdirSync(PERSONAS_DIR).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
        let deleted = false
        for (const f of files) {
          const raw = String(fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            fs.unlinkSync(path.join(PERSONAS_DIR, f))
            deleted = true
            break
          }
        }
        if (!deleted) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
        json(res, { ok: true, message: '人格 ' + name + ' 已删除' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, description, lore, will, nsfw, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const searchDirs = [PERSONAS_DIR, CORE_DIR, MODES_DIR]
        let found = false
        for (const dir of searchDirs) {
          const files = fs.readdirSync(dir).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
          for (const f of files) {
            const raw = String(fs.readFileSync(path.join(dir, f), 'utf8') || '').replace(/^\uFEFF/, '')
            const m = raw.match(/^---\n([\s\S]*?)\n---/)
            const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
            if (metaName === name) {
              const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
              const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
              const nsfwLine = nsfw && nsfw !== 'none' ? '\nnsfw: ' + nsfw : ''
              const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + loreLine + willLine + nsfwLine + '\n---\n\n' + content
              fs.writeFileSync(path.join(dir, f), md, 'utf8')
              found = true
              break
            }
          }
          if (found) break
        }
        if (!found) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
        json(res, { ok: true, message: '人格 ' + name + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 可用世界观列表
  if (pathname === '/dashboard/api/lore-list' && req.method === 'GET') {
    try {
      const loreDir = LORES_DIR
      const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
      const list = files.map(f => {
        const raw = String(fs.readFileSync(path.join(loreDir, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('SKILL.', '').replace('.md', '')
        const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
        return { id: name, description: desc, file: f }
      })
      list.unshift({ id: 'none', description: '不绑定任何世界观', file: '' })
      return json(res, list)
    } catch { return json(res, [{ id: 'none', description: '不绑定任何世界观', file: '' }]) }
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'GET') {
    try {
      const loreDir = LORES_DIR
      const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
      return json(res, files.map(f => {
        const raw = String(fs.readFileSync(path.join(loreDir, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?/)
        let name = '', description = '', content = raw
        if (m) {
          for (const line of m[1].split('\n')) {
            const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
            if (kv) { if (kv[1] === 'name') name = kv[2].trim(); else if (kv[1] === 'description') description = kv[2].trim() }
          }
          content = raw.slice(m[0].length)
        } else {
          name = f.replace(/^SKILL\./, '').replace(/\.md$/, '')
        }
        return { name, description, content }
      }))
    } catch { return json(res, []) }
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, description, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const loreDir = LORES_DIR
        const filePath = path.join(loreDir, 'SKILL.' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '') + '.md')
        if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名世界观已存在' }, 400)
        const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
        fs.writeFileSync(filePath, md, 'utf8')
        json(res, { ok: true, message: '世界观 ' + name + ' 已创建' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, description, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const loreDir = LORES_DIR
        const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
        let found = false
        for (const f of files) {
          const raw = String(fs.readFileSync(path.join(loreDir, f), 'utf8') || '').replace(/^\uFEFF/, '')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
            fs.writeFileSync(path.join(loreDir, f), md, 'utf8')
            found = true
            break
          }
        }
        if (!found) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
        json(res, { ok: true, message: '世界观 ' + name + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
        const loreDir = LORES_DIR
        const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
        let deleted = false
        for (const f of files) {
          const raw = String(fs.readFileSync(path.join(loreDir, f), 'utf8') || '').replace(/^\uFEFF/, '')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            fs.unlinkSync(path.join(loreDir, f))
            deleted = true
            break
          }
        }
        if (!deleted) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
        json(res, { ok: true, message: '世界观 ' + name + ' 已删除' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/modes' && req.method === 'GET') {
    try {
      const dir = MODES_DIR
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      return json(res, files.map(f => {
        const raw = String(fs.readFileSync(path.join(dir, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('.md', '')
        const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
        return { name, file: f, description: desc }
      }))
    } catch { return json(res, []) }
  }

  // 白名单/黑名单管理
  const whitelistFiles = {
    summary: { file: 'summary-whitelist.json', label: '解除上限群白名单', type: 'array' },
    random: { file: 'ai-random-whitelist.json', label: '群聊AI白名单', type: 'array' },
    userBlacklist: { file: 'ai-user-blacklist.json', label: '用户黑名单', type: 'array' },
    videoBlacklist: { file: 'video-blacklist.json', label: '视频黑名单', type: 'object', default: { groups: [], users: [] } },
  }

  if (pathname === '/dashboard/api/whitelist' && req.method === 'GET') {
    const result = {}
    for (const [key, cfg] of Object.entries(whitelistFiles)) {
      try {
        result[key] = { label: cfg.label, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.file), 'utf8')) }
      } catch {
        result[key] = { label: cfg.label, data: cfg.default || [] }
      }
    }
    return json(res, result)
  }

  if (pathname === '/dashboard/api/whitelist' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { type, data } = JSON.parse(body)
        const cfg = whitelistFiles[type]
        if (!cfg) return json(res, { ok: false, message: '无效类型' }, 400)
        writeFileSync(path.join(DATA_DIR, cfg.file), JSON.stringify(data, null, 2))
        // 通知主插件刷新缓存
        try {
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
        } catch {}
        json(res, { ok: true, message: cfg.label + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/keys' && req.method === 'GET') {
    const keyFiles = [
      { name: 'OpenAI/OpenCode', file: 'ai-openai-key.txt' },
      { name: 'DeepSeek 官方', file: 'ai-deepseek-key.txt' },
      { name: '阿里云 DashScope', file: 'ai-dashscope-key.txt' },
      { name: '智谱 GLM', file: 'ai-glm-key.txt' },
      { name: '小米 MiMo', file: 'ai-mimorium-key.txt' },
    ]
    return json(res, keyFiles.map(k => {
      const content = readFileSync(path.join(DATA_DIR, k.file))
      return { label: k.name, file: k.file, exists: !!content, prefix: content ? content.slice(0, 8) + '****' : '' }
    }))
  }

  if (pathname === '/dashboard/api/keys/usage' && req.method === 'GET') {
    try {
      const usageFile = path.join(DATA_DIR, 'token-usage.json')
      if (!fs.existsSync(usageFile)) return json(res, { days: [], providers: [] })
      const raw = fs.readFileSync(usageFile, 'utf8')
      const data = JSON.parse(raw)
      const providerSet = new Set()
      const days = Object.keys(data).sort().slice(-30).map(date => {
        const day = { date }
        for (const [prov, count] of Object.entries(data[date] || {})) {
          day[prov] = count
          providerSet.add(prov)
        }
        return day
      })
      const providers = [...providerSet].map(p => ({
        key: p,
        label: p === 'opencode' ? 'OpenCode' : p === 'glm' ? 'GLM' : p === 'dashscope' ? '阿里云' : p === 'deepseek' ? 'DeepSeek' : p === 'mimorium' ? 'MiMo' : p,
      }))
      return json(res, { days, providers })
    } catch { return json(res, { days: [], providers: [] }) }
  }

  if (pathname === '/dashboard/api/keys' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body)
        const file = data.file
        if (!file || file.includes('..') || !file.endsWith('-key.txt')) return json(res, { ok: false, message: '无效文件名' }, 400)
        writeFileSync(path.join(DATA_DIR, file), data.value)
        const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
        resetConfigCache()
        json(res, { ok: true, message: 'Key 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 自定义供应商管理
  if (pathname === '/dashboard/api/providers/custom' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
      return json(res, JSON.parse(raw))
    } catch { return json(res, []) }
  }
  if (pathname === '/dashboard/api/providers/custom' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body)
        if (!Array.isArray(data)) return json(res, { ok: false, message: '参数错误' }, 400)
        fs.writeFileSync(CUSTOM_PROVIDERS_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8')
        fs.renameSync(CUSTOM_PROVIDERS_FILE + '.tmp', CUSTOM_PROVIDERS_FILE)
        json(res, { ok: true, message: '自定义供应商已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // Fallback 链管理
  if (pathname === '/dashboard/api/fallback' && req.method === 'GET') {
    function buildProviderMap() {
      const ps = {}
      const pDefs = require(path.join(AI_LIB, 'constants')).PROVIDERS
      for (const key of Object.keys(pDefs)) ps[key] = pDefs[key]
      try {
        const customRaw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
        const custom = JSON.parse(customRaw)
        if (Array.isArray(custom)) custom.forEach(function(p) { if (p.id) ps[p.id] = p })
      } catch {}
      return ps
    }
    try {
      const raw = fs.readFileSync(FALLBACK_CHAINS_FILE, 'utf8')
      const data = JSON.parse(raw)
      return json(res, { chains: data, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
    } catch {
      return json(res, { chains: DEFAULT_FALLBACK_CHAINS, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
    }
  }
  if (pathname === '/dashboard/api/fallback' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { chains } = JSON.parse(body)
        if (!chains || typeof chains !== 'object') return json(res, { ok: false, message: '参数错误' }, 400)
        const tmp = FALLBACK_CHAINS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), 'utf8')
        fs.renameSync(tmp, FALLBACK_CHAINS_FILE)
        json(res, { ok: true, message: 'Fallback 链已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/features' && req.method === 'GET') {
    return json(res, require('./index').FEATURES_DATA || [])
  }

  if (pathname === '/dashboard/api/commands' && req.method === 'GET') {
    return json(res, require('./index').COMMANDS_DATA || [])
  }

  // 管理员列表管理
  const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json')

  if (pathname === '/dashboard/api/admin-ids' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(ADMIN_IDS_FILE, 'utf8')
      const ids = JSON.parse(raw)
      return json(res, { ids: Array.isArray(ids) ? ids : [] })
    } catch {
      // 文件不存在时返回默认管理员
      const defaults = ['100000000', '200000000']
      try {
        const tmp = ADMIN_IDS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(defaults, null, 2), 'utf8')
        fs.renameSync(tmp, ADMIN_IDS_FILE)
      } catch {}
      return json(res, { ids: defaults })
    }
  }

  if (pathname === '/dashboard/api/admin-ids' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { ids } = JSON.parse(body)
        if (!Array.isArray(ids)) return json(res, { ok: false, message: '参数错误' }, 400)
        const cleaned = ids.map(String).filter(Boolean)
        const tmp = ADMIN_IDS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2), 'utf8')
        fs.renameSync(tmp, ADMIN_IDS_FILE)
        try {
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
        } catch {}
        return json(res, { ok: true, message: '管理员列表已更新' })
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // NapCat 代理
  if (pathname.startsWith('/webui/') || pathname === '/webui') {
    const nToken = process.env.NAPCAT_TOKEN || getNapcatToken()
    const sep = url.search ? '&' : '?'
    return napcatProxy(req, res, pathname + url.search + (nToken ? sep + 'webui_token=' + nToken : ''))
  }
  if (pathname.startsWith('/api/') && !pathname.startsWith('/dashboard/api/')) {
    return napcatProxy(req, res, pathname + url.search)
  }

  // Bot 控制
  if (pathname === '/dashboard/api/bot/status' && req.method === 'GET') {
    try {
      let running = 0
      if (process.platform === 'win32') {
        running = checkPortState(5140).status === 'occupied' ? 1 : 0
      } else {
        const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
        running = out.split('\n').filter(Boolean).length
      }
      let qq = ''
      try {
        const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
        const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
        if (m) qq = m[1]
      } catch {}
      return json(res, { running: running > 0, workers: running, qq })
    } catch { return json(res, { running: false, workers: 0 }) }
  }

  // 日志开关配置
  if (pathname === '/dashboard/api/logging' && req.method === 'GET') {
    return json(res, { ok: true, config: readLoggingConfig() })
  }

  if (pathname === '/dashboard/api/logging' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body || '{}')
        const config = writeLoggingConfig(data)
        return json(res, { ok: true, config, message: config.enabled ? '调试日志已开启' : '调试日志已关闭' })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // Bot 活动日志
  if (pathname === '/dashboard/api/bot/activity' && req.method === 'GET') {
    try {
      return json(res, getFilteredLogEntries({
        limit: url.searchParams.get('limit'),
        levels: url.searchParams.get('levels'),
        module: url.searchParams.get('module'),
        q: url.searchParams.get('q'),
        errorsOnly: url.searchParams.get('errorsOnly'),
        since: url.searchParams.get('since'),
        filterKey: url.searchParams.get('filterKey'),
      }))
    } catch { return json(res, { entries: [], lines: [], total: 0 }) }
  }

  if (pathname === '/dashboard/api/bot/start' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`, (err) => {
      if (err) log('start bot failed: ' + err.message)
    })
    return json(res, { ok: true, message: '启动命令已发送' })
  }

  if (pathname === '/dashboard/api/bot/stop' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      stopKoishiProcesses()
      return json(res, { ok: true, message: '已停止所有 koishi 进程' })
    } catch (e) { return json(res, { ok: false, message: e.message }) }
  }

  // 维护模式
  if (pathname === '/dashboard/api/maintenance' && req.method === 'GET') {
    return json(res, { enabled: !!readFileSync(path.join(DATA_DIR, 'ai-paused.txt')) })
  }
  if (pathname === '/dashboard/api/maintenance' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { enabled } = JSON.parse(body)
        const f = path.join(DATA_DIR, 'ai-paused.txt')
        if (enabled) writeFileSync(f, '优化中，别急')
        else try { fs.unlinkSync(f) } catch {}
        return json(res, { ok: true, message: enabled ? '维护模式已开启' : '维护模式已关闭' })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 发送节流配置
  if (pathname === '/dashboard/api/throttle' && req.method === 'GET') {
    try {
      const raw = readFileSync(path.join(DATA_DIR, 'ai-throttle-config.json'))
      return json(res, JSON.parse(raw))
    } catch { return json(res, { maxPerMinute: 20 }) }
  }
  if (pathname === '/dashboard/api/throttle' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body)
        if (typeof data.maxPerMinute !== 'number' || data.maxPerMinute < 1) {
          return json(res, { ok: false, message: 'maxPerMinute 必须 >= 1' }, 400)
        }
        const f = path.join(DATA_DIR, 'ai-throttle-config.json')
        fs.writeFileSync(f + '.tmp', JSON.stringify({ maxPerMinute: data.maxPerMinute }, null, 2), 'utf8')
        fs.renameSync(f + '.tmp', f)
        json(res, { ok: true, message: '节流配置已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // QQ 管理
  if (pathname === '/dashboard/api/qq/token' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    return json(res, { token: process.env.NAPCAT_TOKEN || getNapcatToken() })
  }
  if (pathname === '/dashboard/api/qq/ssh-info' && req.method === 'GET') {
    return json(res, {
      host: process.env.DASHBOARD_SSH_HOST || '',
      user: process.env.DASHBOARD_SSH_USER || 'root',
      port: 22,
    })
  }

  // QQ 号切换
  if (pathname === '/dashboard/api/qq/selfid' && req.method === 'GET') {
    try {
      const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
      const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
      return json(res, { selfId: m ? m[1] : '' })
    } catch { return json(res, { selfId: '' }) }
  }
  if (pathname === '/dashboard/api/qq/selfid' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { selfId } = JSON.parse(body)
        if (!selfId || !/^\d+$/.test(selfId)) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
        const ymlPath = path.join(KOISHI_DIR, 'koishi.yml')
        let yml = fs.readFileSync(ymlPath, 'utf8')
        yml = yml.replace(/(selfId:\s*['\"]?)\d+(['\"]?)/, '$1' + selfId + '$2')
        fs.writeFileSync(ymlPath, yml, 'utf8')
        // 自动重启 koishi
        exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`)
        json(res, { ok: true, message: 'QQ 号已更新，Koishi 正在重启...' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // NapCat 管理
  if (pathname === '/dashboard/api/napcat/status' && req.method === 'GET') {
    try {
      execSync("ps aux | grep 'qq.*--no-sandbox' | grep -v grep", { encoding: 'utf8', timeout: 3000 })
      return json(res, { running: true })
    } catch { return json(res, { running: false }) }
  }
  if (pathname === '/dashboard/api/napcat/restart' && req.method === 'POST') {
    const raw = process.env.DASHBOARD_QQ_NUMBER || '123456789'
    const qq = raw.replace(/[^0-9]/g, '')
    if (!qq) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
    exec("screen -S napcat -X quit 2>/dev/null; sleep 2; screen -dmS napcat bash -c 'xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q " + qq + "'")
    return json(res, { ok: true, message: 'NapCat 重启命令已发送' })
  }

  // ==== 部署管理 ====
  const DEPLOY_CONFIG_FILE = path.join(DATA_DIR, 'deploy-config.json')
  const DEPLOY_TASKS_DIR = path.join(DATA_DIR, 'deploy-tasks')
  if (!fs.existsSync(DEPLOY_TASKS_DIR)) fs.mkdirSync(DEPLOY_TASKS_DIR, { recursive: true })

  if (pathname === '/dashboard/api/deploy/config' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'))
      let botRunning = false
      try { execSync('ss -tlnp | grep -q :5140', { stdio: 'ignore' }); botRunning = true } catch {}
      cfg._localFingerprint = computeFingerprint()
      return json(res, { ...cfg, botRunning })
    }
    catch { return json(res, { server: '', appDir: '/root/koishi-app', botRunning: false, _localFingerprint: computeFingerprint() }) }
  }

  if (pathname === '/dashboard/api/deploy/check-update' && req.method === 'GET') {
    const local = computeFingerprint()
    let deployed = ''
    try {
      const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'))
      deployed = cfg.deployFingerprint || ''
    } catch {}
    return json(res, { local, deployed, upToDate: local === deployed })
  }

  if (pathname === '/dashboard/api/deploy/config' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const cfg = validateDeployTarget(JSON.parse(body))
        const tmp = DEPLOY_CONFIG_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
        fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
        json(res, { ok: true, message: '配置已保存' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/run' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const cfg = validateDeployTarget(JSON.parse(body))
        if (cfg.mode === 'install') {
          return json(res, { ok: false, message: 'First-time install is not automated yet. Please run setup.sh or a local installer first.' }, 400)
        }
        assertFrontendDistReady()
        if (!cfg.server || !cfg.appDir) return json(res, { ok: false, message: '配置不完整' }, 400)
        const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
        const log = (msg) => { try { fs.appendFileSync(logFile, msg + '\n', 'utf8') } catch {} }
        json(res, { ok: true, taskId })

        const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
        const s = cfg.server
        const d = cfg.appDir
        const pkgs = [
          'koishi-plugin-dongxuelian-ai', 'koishi-plugin-dongxuelian-help',
          'koishi-plugin-group-name-at', 'koishi-plugin-defense',
          'koishi-plugin-local-video-sender', 'koishi-plugin-group-leave-notice',
          'koishi-plugin-dongxuelian-poke', 'koishi-plugin-daily-report',
        ]
        const cmds = []
        const dashboardDir = remoteJoin(d, 'packages', 'koishi-plugin-dashboard')
        const dashboardDistDir = remoteJoin(dashboardDir, 'frontend', 'dist')
        const scriptsDir = remoteJoin(d, 'scripts')
        const dataDir = remoteJoin(d, 'data')
        const existingInstallCheck = `test -f ${shellQuote(remoteJoin(d, 'node_modules', 'koishi', 'bin.js'))} && (test -f ${shellQuote(remoteJoin(d, 'koishi.config.js'))} || test -f ${shellQuote(remoteJoin(d, 'koishi.yml'))})`
        cmds.push(`echo "preflight"`)
        cmds.push(sshCommand(s, existingInstallCheck))
        cmds.push(`echo "prepare dirs"`)
        cmds.push(sshCommand(s, `mkdir -p ${[dataDir, dashboardDir, dashboardDistDir, scriptsDir].concat(pkgs.map(pkg => remoteJoin(d, 'node_modules', pkg, 'lib'))).map(shellQuote).join(' ')}`))
        for (const pkg of pkgs) {
          cmds.push(`echo "→ ${pkg}"`)
          cmds.push(scpCommand(path.join(repoRoot, 'packages', pkg, 'lib'), scpRemoteTarget(s, remoteJoin(d, 'node_modules', pkg)), { recursive: true }))
          cmds.push(scpCommand(path.join(repoRoot, 'packages', pkg, 'package.json'), scpRemoteTarget(s, remoteJoin(d, 'node_modules', pkg, 'package.json'))))
        }
        cmds.push(`echo "Dashboard 前端..."`)
        cmds.push(scpCommand(path.join(PLUGIN_ROOT, 'standalone.js'), scpRemoteTarget(s, remoteJoin(dashboardDir, 'standalone.js'))))
        cmds.push(scpCommand(DIST_DIR, scpRemoteTarget(s, remoteJoin(dashboardDir, 'frontend')), { recursive: true }))
        cmds.push(`echo "重启脚本..."`)
        const restartScript = fs.existsSync(path.join(repoRoot, 'scripts', 'restart-bot.sh'))
          ? path.join(repoRoot, 'scripts', 'restart-bot.sh')
          : path.join(repoRoot, 'restart-bot.sh')
        cmds.push(scpCommand(restartScript, scpRemoteTarget(s, remoteJoin(d, 'restart.sh'))))
        if (fs.existsSync(path.join(repoRoot, 'scripts', 'watchdog.sh'))) cmds.push(scpCommand(path.join(repoRoot, 'scripts', 'watchdog.sh'), scpRemoteTarget(s, remoteJoin(scriptsDir, 'watchdog.sh'))))
        if (fs.existsSync(path.join(DATA_DIR, 'bilibili-cookies.txt'))) cmds.push(scpCommand(path.join(DATA_DIR, 'bilibili-cookies.txt'), scpRemoteTarget(s, '/root/bilibili-cookies.txt')))
        cmds.push(`echo "重启 Bot..."`)
        cmds.push(sshCommand(s, `bash ${shellQuote(remoteJoin(d, 'restart.sh'))}`))
        cmds.push(sshCommand(s, `if ss -tlnp | grep -q :5140 || curl -fsS http://127.0.0.1:5140 >/dev/null; then exit 0; fi; echo ${shellQuote('health check failed; last koishi.log lines:')}; tail -30 ${shellQuote(remoteJoin(d, 'koishi.log'))}; exit 1`))
        cmds.push(`echo "✅ 部署完成"`)

        let idx = 0
        function runNext() {
          if (idx >= cmds.length) {
            try { writeDeployFingerprint(DEPLOY_CONFIG_FILE, { server: s, appDir: d, mode: cfg.mode }) }
            catch (e) { log('warning: deploy fingerprint write failed: ' + e.message) }
            log('DONE')
            return
          }
          log('$ ' + cmds[idx])
          exec(cmds[idx], { cwd: repoRoot, timeout: 60000 }, (err, stdout, stderr) => {
            if (stdout) log(stdout.trim())
            if (stderr) log(stderr.trim())
            if (err) { log('❌ ' + err.message); log('FAIL'); return }
            idx++; runNext()
          })
        }
        runNext()
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname.startsWith('/dashboard/api/deploy/progress/') && req.method === 'GET') {
    const taskId = pathname.split('/').pop()
    if (!taskId) return json(res, { ok: false, message: '缺少 taskId' }, 400)
    try {
      const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
      if (!fs.existsSync(logFile)) return json(res, { ok: false, lines: [], done: false })
      const raw = fs.readFileSync(logFile, 'utf8').trim()
      const lines = raw ? raw.split('\n') : []
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
      const done = lastLine === 'DONE' || lastLine === 'FAIL'
      return json(res, { ok: true, lines, done, success: lastLine === 'DONE' })
    } catch { return json(res, { ok: false, lines: [], done: false }) }
  }

  if (pathname === '/dashboard/api/frontend/rebuild' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (rebuildStatus.state === 'building') {
      return json(res, { ok: false, message: '正在构建中，请等待完成' })
    }
    const FE_DIR = path.join(PLUGIN_ROOT, 'frontend')
    if (!fs.existsSync(path.join(FE_DIR, 'node_modules'))) {
      return json(res, { ok: false, message: '前端依赖未安装，请先在 frontend 目录执行 npm install' })
    }
    const distDir = path.join(FE_DIR, 'dist')
    const backupDir = path.join(FE_DIR, 'dist.bak')
    try {
      fs.rmSync(backupDir, { recursive: true, force: true })
      if (fs.existsSync(distDir)) fs.renameSync(distDir, backupDir)
    } catch (e) {
      return json(res, { ok: false, message: 'frontend backup failed: ' + e.message }, 500)
    }
    rebuildStatus = { state: 'building', message: 'building', detail: '', startedAt: Date.now(), finishedAt: 0 }
    exec('npm run build', { cwd: FE_DIR, timeout: 120000 }, (err, stdout, stderr) => {
      try {
        if (err) {
          const rollbackError = rollbackFrontendDist(distDir, backupDir)
          const detail = [stderr || err.message || '', rollbackError].filter(Boolean).join('\n').slice(-600)
          rebuildStatus = { state: 'failed', message: 'frontend build failed and rolled back', detail, startedAt: rebuildStatus.startedAt, finishedAt: Date.now() }
          log('frontend rebuild failed: ' + detail)
          return
        }
        if (!hasFrontendDistAssets(distDir)) {
          const rollbackError = rollbackFrontendDist(distDir, backupDir)
          rebuildStatus = { state: 'failed', message: 'frontend dist is incomplete and rolled back', detail: rollbackError, startedAt: rebuildStatus.startedAt, finishedAt: Date.now() }
          return
        }
        fs.rmSync(backupDir, { recursive: true, force: true })
        rebuildStatus = { state: 'success', message: 'frontend build success', detail: '', startedAt: rebuildStatus.startedAt, finishedAt: Date.now() }
        log('frontend rebuild success')
      } catch (e) {
        rebuildStatus = { state: 'failed', message: 'frontend rebuild cleanup failed', detail: e.message, startedAt: rebuildStatus.startedAt, finishedAt: Date.now() }
        log('frontend rebuild cleanup failed: ' + e.message)
      }
    })
    return json(res, { ok: true, message: '前端构建已启动' })
  }

  if (pathname === '/dashboard/api/frontend/rebuild-status' && req.method === 'GET') {
    return json(res, rebuildStatus)
  }

  if (pathname === '/dashboard/api/deploy/confirm' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8')) } catch {}
      cfg.deployedAt = Date.now()
      cfg.deployFingerprint = computeFingerprint()
      const tmp = DEPLOY_CONFIG_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
      json(res, { ok: true })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    return
  }

  if (pathname === '/dashboard/api/deploy/upload' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, data } = JSON.parse(body)
        if (!name || !data) return json(res, { ok: false, message: '文件名或内容为空' }, 400)
        if (name !== 'bilibili-cookies.txt') return json(res, { ok: false, message: 'only bilibili-cookies.txt can be uploaded here' }, 400)
        const filePath = path.join(DATA_DIR, 'bilibili-cookies.txt')
        const buf = Buffer.from(data, 'base64')
        fs.mkdirSync(DATA_DIR, { recursive: true })
        fs.writeFileSync(filePath, buf)
        json(res, { ok: true, message: 'bilibili-cookies.txt 已保存到本地，部署时将自动推送' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/gallery' && req.method === 'GET') {
    try { return json(res, { ok: true, images: listGalleryImages(), maxBytes: GALLERY_MAX_BYTES }) }
    catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/gallery' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const item = writeGalleryImage(JSON.parse(body || '{}'))
        return json(res, { ok: true, image: item, message: '图片已加入莲莲图集' })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/gallery' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { id, ids } = JSON.parse(body || '{}')
        const result = deleteGalleryImages(Array.isArray(ids) ? ids : id)
        const ok = result.errors.length === 0
        return json(res, { ok, ...result, message: ok ? `已删除 ${result.deleted.length} 张图片` : `已删除 ${result.deleted.length} 张图片，${result.errors.length} 张删除失败` }, ok ? 200 : 400)
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/gallery/style' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { id, foilStyle } = JSON.parse(body || '{}')
        const image = updateGalleryImageStyle(id, foilStyle)
        return json(res, { ok: true, image, message: '闪卡样式已保存' })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname.startsWith('/dashboard/api/gallery/image/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(pathname.slice('/dashboard/api/gallery/image/'.length))
      const filePath = resolveGalleryId(id)
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      res.writeHead(200, { 'Content-Type': galleryMimeFromName(id), 'Cache-Control': 'public, max-age=3600' })
      res.end(fs.readFileSync(filePath))
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
    }
    return
  }

  // 环境检测
  if (pathname === '/dashboard/api/env/check' && req.method === 'GET') {
    const localDeployTarget = getLocalDeployTarget()
    const nodeInfo = getCommandInfo('node', 18)
    const npmInfo = getCommandInfo('npm')
    const dependencyStatus = getProjectDependencyStatus()
    const uninstallPreview = buildLocalUninstallPreview()
    const portList = [5140, Number(PORT), 8080, 6099]
    const ports = {}
    for (const port of portList) ports[port] = checkPortState(port)
    return json(res, {
      platform: process.platform,
      host: { platform: process.platform, arch: process.arch, hostname: os.hostname() },
      localDeployTarget,
      blocked: localDeployTarget.blocked,
      blockedReason: localDeployTarget.blockedReason,
      projectDir: path.resolve(KOISHI_DIR),
      runtimeDir: runtimePath(),
      node: nodeInfo,
      npm: npmInfo,
      dependencies: dependencyStatus,
      localConfig: buildLocalConfigPreview(),
      managedArtifacts: { deleteItems: uninstallPreview.deleteItems.length, userDataItems: uninstallPreview.userDataItems.length, deleteSize: uninstallPreview.stats.deleteSize, userDataSize: uninstallPreview.stats.userDataSize },
      workDir: { exists: fs.existsSync(KOISHI_DIR), path: path.resolve(KOISHI_DIR), writable: null, reason: '环境检测不写入项目目录' },
      pathEncoding: inspectChinesePathWrite(runtimePath('logs')),
      ports,
      napcat: detectNapcatInstallation(),
    })
  }

  // 本地部署
  let localBotProcess = null

  if (pathname === '/dashboard/api/deploy/local' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const cfg = JSON.parse(body)
        const workDir = path.resolve(KOISHI_DIR)
        const qq = String(cfg.qq || '').trim()
        const provider = String(cfg.provider || 'opencode').trim() || 'opencode'
        const model = String(cfg.model || '').trim()
        const baseUrl = String(cfg.baseUrl || '').trim()
        if (!/^\d+$/.test(qq)) return json(res, { ok: false, message: 'QQ 号不能为空或格式错误' }, 400)
        if (!/^[A-Za-z0-9._-]+$/.test(provider)) return json(res, { ok: false, message: '供应商名称格式错误' }, 400)
        if (!model) return json(res, { ok: false, message: '模型不能为空' }, 400)
        if (baseUrl) { try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad') } catch { return json(res, { ok: false, message: 'API 地址必须是 http/https URL' }, 400) } }
        if (!isInsidePath(KOISHI_DIR, workDir)) return json(res, { ok: false, message: '本地部署目录必须在当前项目目录内' }, 400)
        writeRuntimeLayout()
        const pkgs = ['koishi-plugin-dongxuelian-ai','koishi-plugin-dongxuelian-help','koishi-plugin-group-name-at','koishi-plugin-defense','koishi-plugin-local-video-sender','koishi-plugin-group-leave-notice','koishi-plugin-dongxuelian-poke','koishi-plugin-daily-report']
        const copiedPlugins = []
        for (const pkg of pkgs) {
          const src = path.join(PLUGIN_ROOT, '..', pkg)
          const dst = path.join(workDir, 'node_modules', pkg)
          if (fs.existsSync(src)) {
            copyRecursiveSync(path.join(src, 'lib'), path.join(dst, 'lib'))
            copyRecursiveSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
            copiedPlugins.push(pkg)
          }
        }
        const timestamp = Date.now()
        const files = []
        files.push(writeTrackedLocalFile('data/ai-provider.txt', provider + '\n', { deleteByDefault: true, kind: 'provider' }, timestamp))
        files.push(writeTrackedLocalFile('data/ai-model.txt', model + '\n', { deleteByDefault: true, kind: 'model' }, timestamp))
        files.push(writeTrackedLocalFile('data/ai-base-url.txt', baseUrl + '\n', { deleteByDefault: true, kind: 'baseUrl' }, timestamp))
        const inputApiKey = String(cfg.apiKey || '').trim()
        if (inputApiKey) files.push(writeTrackedLocalFile('data/ai-openai-key.txt', inputApiKey + '\n', { deleteByDefault: false, sensitive: true, kind: 'apiKey' }, timestamp))
        if (cfg.adminIds) files.push(writeTrackedLocalFile('data/ai-admin-ids.json', JSON.stringify(cfg.adminIds, null, 2) + '\n', { deleteByDefault: false, sensitive: true, kind: 'adminIds' }, timestamp))
        const yml = `port: 5140\nselfUrl: http://localhost:5140\nplugins:\n  adapter-onebot:\n    protocol: ws\n    selfId: '${qq}'\n    endpoint: ws://127.0.0.1:8080/onebot/v11/ws\n  dongxuelian-ai: {}\n  dongxuelian-help: {}\n  group-name-at: {}\n  defense: {}\n  local-video-sender: {}\n  group-leave-notice: {}\n  dongxuelian-poke: {}\n  daily-report: {}\n`
        files.push(writeTrackedLocalFile('koishi.yml', yml, { deleteByDefault: true, kind: 'koishiConfig' }, timestamp))
        const helper = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif exist "%~dp0runtime\\node\\node.exe" set "PATH=%~dp0runtime\\node;%PATH%"\r\nif not exist node_modules ( call npm install )\r\ncall npm exec -- koishi start\r\n`
        files.push(writeTrackedLocalFile('start-local.bat', helper, { deleteByDefault: true, kind: 'startScript' }, timestamp))
        const aiKey = getAiKeyStatus(provider)
        const manifest = { version: 1, generatedAt: timestamp, qq, onebotEndpoint: 'ws://127.0.0.1:8080/onebot/v11/ws', aiKeyConfigured: aiKey.configured, files }
        writeLocalDeployManifest(manifest)
        json(res, { ok: true, message: aiKey.configured ? 'Koishi 本地配置已写入，NapCat 使用 8080 OneBot WebSocket' : 'Koishi 本地配置已写入；AI Key 未配置，基础部署可继续，AI 回复暂不可用', files, copiedPlugins, aiKeyConfigured: aiKey.configured, aiKey, manifest: { path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE), generatedAt: timestamp } })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/local-config-preview' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try { return json(res, buildLocalConfigPreview()) }
    catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/local-config-delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, () => {
      try {
        const result = deleteLocalConfigFiles()
        return json(res, { ...result, message: result.errors.length ? '部分配置未能删除' : 'Koishi 本地配置已删除' }, result.errors.length ? 400 : 200)
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/local-uninstall-preview' && req.method === 'GET') {
    if (!requireStrictAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try { return json(res, buildLocalUninstallPreview()) }
    catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/local-uninstall' && req.method === 'POST') {
    if (!requireStrictAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const cfg = JSON.parse(body || '{}')
        if (!cfg.confirm) return json(res, { ok: false, message: '缺少一键卸载确认标记' }, 400)
        const result = runLocalUninstall({ deleteUserDataKeys: cfg.deleteUserDataKeys })
        return json(res, result, result.errors.length ? 400 : 200)
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/napcat-download' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { url } = JSON.parse(body)
        if (!url) return json(res, { ok: false, message: '下载地址不能为空' }, 400)
        downloadToRuntime(url, { preferredName: 'napcat-manual.zip', expectedExt: '.zip', minBytes: 128 * 1024 }, (err, filePath, download) => {
          if (err) return json(res, { ok: false, message: err.message }, 400)
          json(res, { ok: true, message: 'NapCat 包已下载到 ' + filePath, path: filePath, download })
        })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/napcat-windows-download' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { installDir } = JSON.parse(body || '{}')
        const targetDir = validateNapcatInstallDir(installDir)
        downloadNapcatWindowsRelease(targetDir, (err, detail = {}) => {
          if (err) return json(res, { ok: false, message: err.message, ...detail }, 400)
          writeFileSync(LOCAL_NAPCAT_DIR_FILE, targetDir)
          json(res, { ok: true, message: detail.message || 'NapCat（Windows）OneKey 包已下载并解压', ...detail, napcat: detectNapcatInstallation() })
        })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/node-windows-install' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    collectBody(req, res, () => {
      try {
        installPortableNodeWindows((err, detail = {}) => {
          if (err) return json(res, { ok: false, message: err.message, ...detail }, 400)
          json(res, { ok: true, ...detail, message: detail.message || '便携 Node/npm 已安装' })
        })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/npm-install' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try {
      const dependencies = getProjectDependencyStatus()
      if (dependencies.ready) return json(res, { ok: true, skipped: true, message: '项目依赖已安装', status: getLocalNpmInstallStatus() })
      const npmInfo = getCommandInfo('npm')
      if (!npmInfo.found) return json(res, { ok: false, message: '当前 Windows 本机未找到 npm，请先安装便携 Node/npm 后重新检测环境', npm: npmInfo }, 400)
      const prepared = prepareNpmInstallRun()
      const started = startNpmInstallTask({ prepared })
      return json(res, { ok: true, message: started.alreadyRunning ? 'npm install 正在运行' : 'npm install 已启动', status: getLocalNpmInstallStatus() })
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/npm-repair-and-install' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try {
      const result = repairNpmProxyAndStartInstall()
      return json(res, result, result.ok ? 200 : 400)
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/npm-install-status' && req.method === 'GET') {
    return json(res, { ok: true, status: getLocalNpmInstallStatus() })
  }

  if (pathname === '/dashboard/api/deploy/napcat-start' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try {
      const current = getLocalNapcatDeployStatus()
      if (current.running) return json(res, { ok: true, message: 'NapCat 看起来已经在运行', status: current })
      const { detected, entry } = getNapcatStartEntry()
      if (!detected.found || !entry) return json(res, { ok: false, message: detected.reason || '未找到可启动的 NapCat，请先安装官方 Windows 包', napcat: detected }, 400)
      const ext = path.extname(entry).toLowerCase()
      const cwd = path.dirname(entry)
      let command = entry
      let args = []
      if (ext === '.bat' || ext === '.cmd') { command = 'cmd.exe'; args = ['/d', '/c', entry] }
      else if (/^NapCatWinBootMain\.exe$/i.test(path.basename(entry))) { args = ['10001'] }
      else if (ext === '.js' || ext === '.mjs') { command = getLocalToolCommand('node'); args = [entry] }
      spawnLocalTask('napcat', command, args, getLocalTaskOptions({ cwd }))
      return json(res, { ok: true, message: 'NapCat 已启动，请等待 WebUI 或控制台二维码出现后扫码登录', status: getLocalNapcatDeployStatus() })
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/napcat-status' && req.method === 'GET') {
    return json(res, { ok: true, status: getLocalNapcatDeployStatus() })
  }

  if (pathname === '/dashboard/api/deploy/koishi-start' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try {
      const current = getLocalKoishiDeployStatus()
      if (current.running) return json(res, { ok: true, message: 'Koishi 看起来已经在运行', status: current })
      const dependencies = getProjectDependencyStatus()
      if (!dependencies.ready) return json(res, { ok: false, message: '项目依赖尚未完整安装，请先执行 npm install 站点', dependencies }, 400)
      if (process.platform === 'win32' && fs.existsSync(path.join(KOISHI_DIR, 'start-local.bat'))) {
        spawnLocalTask('koishi', 'cmd.exe', ['/d', '/c', path.join(KOISHI_DIR, 'start-local.bat')], getLocalTaskOptions({ cwd: KOISHI_DIR }))
      } else {
        spawnLocalTask('koishi', getLocalToolCommand('npm'), ['exec', '--', 'koishi', 'start'], getLocalTaskOptions({ cwd: KOISHI_DIR, shell: process.platform === 'win32' }))
      }
      return json(res, { ok: true, message: 'Koishi 已启动，正在等待 5140 端口和 OneBot 连接', status: getLocalKoishiDeployStatus() })
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/deploy/koishi-status' && req.method === 'GET') {
    return json(res, { ok: true, status: getLocalKoishiDeployStatus() })
  }

  if (pathname === '/dashboard/api/deploy/local-ready-check' && req.method === 'GET') {
    try { return json(res, buildLocalReadyCheck()) }
    catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  }

  if (pathname === '/dashboard/api/bot/local-status' && req.method === 'GET') {
    try {
      const target = getLocalDeployTarget()
      if (!target.canRunWindowsLocalDeploy) return json(res, { running: false, workers: 0, blocked: true, localDeployTarget: target, message: target.blockedReason })
      if (process.platform === 'win32') {
        const port = checkPortState(5140)
        return json(res, { running: port.status === 'occupied', workers: port.status === 'occupied' ? 1 : 0, port })
      }
      const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
      const running = out.split('\n').filter(Boolean).length
      return json(res, { running: running > 0, workers: running })
    } catch { return json(res, { running: false, workers: 0 }) }
  }

  if (pathname === '/dashboard/api/bot/local-stop' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (!requireWindowsLocalDeployTarget(req, res)) return
    try {
      stopKoishiProcesses()
      return json(res, { ok: true, message: '本地 Bot 已停止' })
    } catch (e) { return json(res, { ok: false, message: e.message }) }
  }

  if (pathname === '/dashboard') {
    res.writeHead(302, { Location: '/dashboard/' })
    res.end()
    return
  }

  const serveFile = (filePath) => {
    try {
      if (!isInsidePath(DIST_DIR, filePath)) {
        res.writeHead(403)
        res.end('Forbidden')
        return true
      }
      if (fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath)
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream'
        const rel = path.relative(DIST_DIR, filePath).replace(/\\/g, '/')
        const cache = rel === 'index.html' ? 'no-cache' : (rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600')
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache })
        res.end(fs.readFileSync(filePath))
        return true
      }
    } catch {}
    return false
  }
  let reqPath = pathname.replace(/^\/dashboard\/?/, '')
  try { reqPath = decodeURIComponent(reqPath) } catch {}
  if (serveFile(path.join(DIST_DIR, reqPath || 'index.html'))) return
  if (!pathname.startsWith('/dashboard/api/') && serveFile(path.join(DIST_DIR, 'index.html'))) return
    res.writeHead(404)
    res.end('Not Found')
})

if (!getResetToken()) generateResetToken()

server.listen(PORT, () => {
  log(`LianBoard running on http://localhost:${PORT}/dashboard/`)
  log(`bot control: start/stop/maintenance`)
  log(`napcat proxy: /webui/ -> NapCat WebUI`)
  log(`密码重置令牌文件: ${RESET_TOKEN_FILE}`)
  if (!getAccessPassword() && !isLocalAuthBypass()) log('WARNING: dashboard access password is not configured; login is disabled')
  if (!readFileSync(ADMIN_PWD_FILE) && !process.env.DASHBOARD_ADMIN_PASSWORD) log('WARNING: 管理员密码使用默认值 123，请登录后在安全设置中修改')
})

process.on('SIGINT', () => { log('shutting down'); server.close(); process.exit(0) })
process.on('SIGTERM', () => { log('shutting down'); server.close(); process.exit(0) })
