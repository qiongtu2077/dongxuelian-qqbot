'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { execFileSync } = require('child_process')
const { parsePositiveInt, json, log, shellQuote, commandQuote, isInsidePath, describeFsError, removePathWithRetry, ensureCleanDirectory, copyRecursiveSync, listFilesRecursive, uniquePaths } = require('./utils')
const { KOISHI_DIR, DATA_DIR, PORT, PLUGIN_ROOT, FE_DIR, DIST_DIR, LOCAL_DEPLOY_MANIFEST_FILE, LOCAL_NAPCAT_DIR_FILE, NPM_PROXY_ENV_KEYS, isGlobalLocalMode, isPackagedLocalWorkspace, getResourceRoot, toProjectRel, resolveProjectRel, runtimePath } = require('./paths')
const { getCommandInfo, getLocalToolCommand, getLocalToolEnv, getPortableNodeDir, checkPortState, redactProxyValue, parseProxyEndpoint, isLoopbackProxyHost, resolveKoishiListenPort } = require('./tools')
const { detectNapcatInstallation, getNapcatStartEntry: napcatGetStartEntry, findNapcatMarkers, sortNapcatEntries, inspectNapcatCandidate, resolveNapcatWebuiListenPort, resolveNapcatOnebotListenPort, getNapcatToken } = require('./napcat')
const { readLastLogLines } = require('./logging')
const { localTasks, getTaskPublicStatus, spawnLocalTask, getNpmDiagnosticsCache, setNpmDiagnosticsCache, getRebuildStatus, setRebuildStatus } = require('./deploy-state')

const MAX_DOWNLOAD_BYTES = parsePositiveInt(process.env.DASHBOARD_MAX_DOWNLOAD_BYTES, 256 * 1024 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024)
const MAX_DEPLOY_TASK_LOG_BYTES = parsePositiveInt(process.env.DASHBOARD_MAX_DEPLOY_TASK_LOG_BYTES, 512 * 1024, 64 * 1024, 4 * 1024 * 1024)
const MAX_DEPLOY_UPLOAD_BYTES = parsePositiveInt(process.env.DASHBOARD_DEPLOY_UPLOAD_MAX_BYTES, 1024 * 1024, 4 * 1024, 4 * 1024 * 1024)
const MAX_DOWNLOAD_REDIRECTS = parsePositiveInt(process.env.DASHBOARD_MAX_DOWNLOAD_REDIRECTS, 5, 0, 10)
const MAX_JSON_RESPONSE_BYTES = parsePositiveInt(process.env.DASHBOARD_MAX_JSON_RESPONSE_BYTES, 10 * 1024 * 1024, 1024, 64 * 1024 * 1024)
const HASH_CHUNK_BYTES = 64 * 1024

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
  return { ...cfg, server: validateDeployServer(cfg?.server), appDir: validateDeployAppDir(cfg?.appDir), mode: cfg?.mode === 'install' ? 'install' : 'update' }
}

function remoteJoin(base, ...parts) {
  const root = validateDeployAppDir(base)
  const suffix = parts.map(part => String(part || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
  return suffix ? root.replace(/\/+$/, '') + '/' + suffix : root
}

function sshCommand(server, remoteCmd) {
  return `ssh -o StrictHostKeyChecking=no -- ${server} ${commandQuote(remoteCmd)}`
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

function hashFile(hash, repoRoot, filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/')
    hash.update(rel)
    hash.update('\0')
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(1, stat.size || 1)))
    try {
      let position = 0
      while (position < stat.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally { fs.closeSync(fd) }
  } catch {}
}

function computeFingerprint() {
  try {
    const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
    const hash = crypto.createHash('md5')
    const add = rel => hashFile(hash, repoRoot, path.join(repoRoot, rel))
    add('packages/koishi-plugin-dashboard/standalone.js')
    add('packages/koishi-plugin-dashboard/frontend/index.html')
    add('packages/koishi-plugin-dashboard/frontend/package.json')
    add('packages/koishi-plugin-dashboard/frontend/package-lock.json')
    add('packages/koishi-plugin-dashboard/frontend/vite.config.js')
    add('packages/koishi-plugin-dashboard/frontend/dist/index.html')
    add('scripts/restart-bot.sh')
    add('scripts/watchdog.sh')
    for (const file of listFilesRecursive(path.join(repoRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'src'))) hashFile(hash, repoRoot, file)
    for (const file of listFilesRecursive(path.join(repoRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'public'))) hashFile(hash, repoRoot, file)
    for (const file of listFilesRecursive(path.join(repoRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'dist', 'assets'))) hashFile(hash, repoRoot, file)
    const packagesDir = path.join(repoRoot, 'packages')
    let packageNames = []
    try { packageNames = fs.readdirSync(packagesDir).sort() } catch {}
    for (const pkg of packageNames) {
      const pkgDir = path.join(packagesDir, pkg)
      try { if (!fs.statSync(pkgDir).isDirectory()) continue } catch { continue }
      add(`packages/${pkg}/package.json`)
      for (const file of listFilesRecursive(path.join(pkgDir, 'lib'), f => /\.js$/i.test(f))) hashFile(hash, repoRoot, file)
    }
    return hash.digest('hex').slice(0, 8)
  } catch { return 'unknown' }
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

function isBlockedDownloadHost(hostname) {
  const h = String(hostname || '')
  if (/^::1$/i.test(h)) return true
  return /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost$|\[::1\])/i.test(h)
}

function getLocalWorkDirSafety() {
  const projectDir = path.resolve(KOISHI_DIR)
  const rDir = runtimePath()
  const tempDir = path.resolve(os.tmpdir()).toLowerCase()
  const values = [projectDir, rDir].map(item => item.toLowerCase())
  const reasons = []
  if (values.some(item => item === tempDir || item.startsWith(tempDir + path.sep.toLowerCase()))) reasons.push('工作目录位于系统临时目录')
  if (values.some(item => /[\\/]resources[\\/]app(?:[\\/]|$)/i.test(item))) reasons.push('工作目录位于 Electron 资源临时目录')
  const fallbackReason = String(process.env.LIANLIAN_WORKSPACE_FALLBACK_REASON || '').trim()
  if (fallbackReason) reasons.push(fallbackReason)
  return { ok: reasons.length === 0, isTempRuntime: reasons.length > 0, reasons, projectDir, runtimeDir: rDir, workspaceRoot: process.env.LIANLIAN_WORKSPACE_ROOT || projectDir, resourceRoot: process.env.LIANLIAN_RESOURCE_ROOT || '', packaged: /^(?:1|true|yes|on)$/i.test(String(process.env.LIANLIAN_PACKAGED || '').trim()) }
}

function getLocalDeployTarget() {
  const isWindowsBackend = process.platform === 'win32'
  const workDirSafety = getLocalWorkDirSafety()
  const blockedReason = isWindowsBackend ? '' : `当前 Dashboard 后端是 ${process.platform}/${process.arch}，Windows 本地部署需要在 Windows 部署器软件中运行。远端网页只能检测服务器，不能检测浏览器所在的 Windows 电脑。`
  return { kind: 'dashboard-backend', scope: 'backend-machine', platform: process.platform, arch: process.arch, hostname: os.hostname(), projectDir: path.resolve(KOISHI_DIR), runtimeDir: runtimePath(), workspace: workDirSafety, isWindowsBackend, isLocalDeployer: isGlobalLocalMode(), canRunWindowsLocalDeploy: isWindowsBackend, blocked: !isWindowsBackend, blockedReason, guidance: isWindowsBackend ? '当前 Dashboard 后端运行在 Windows，可作为本地部署目标。' : `请在要部署的 Windows 本机启动部署器软件，并访问 http://127.0.0.1:${PORT}/dashboard/。` }
}

function requireWindowsLocalDeployTarget(req, res) {
  const target = getLocalDeployTarget()
  if (target.canRunWindowsLocalDeploy) return true
  json(res, { ok: false, blocked: true, localDeployTarget: target, message: target.blockedReason }, 403)
  return false
}

function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.write-test-' + Date.now().toString(36))
  fs.writeFileSync(probe, 'ok', 'utf8')
  fs.unlinkSync(probe)
}

function copyWorkspaceResource(sourceRoot, targetRoot, relativePath, options = {}) {
  const source = path.join(sourceRoot, relativePath)
  const target = path.join(targetRoot, relativePath)
  if (!fs.existsSync(source)) return false
  if (options.replace) fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  copyRecursiveSync(source, target)
  return true
}

function ensurePackagedWorkspace(options = {}) {
  if (!isPackagedLocalWorkspace()) return { ok: true, skipped: true, workspaceRoot: path.resolve(KOISHI_DIR), resourceRoot: getResourceRoot() }
  const resourceRoot = getResourceRoot()
  const workspaceRoot = path.resolve(process.env.LIANLIAN_WORKSPACE_ROOT || KOISHI_DIR)
  if (workspaceRoot.toLowerCase() === resourceRoot.toLowerCase()) return { ok: true, skipped: true, workspaceRoot, resourceRoot }
  ensureWritableDir(workspaceRoot)
  for (const dir of ['packages', 'scripts']) copyWorkspaceResource(resourceRoot, workspaceRoot, dir, { replace: true })
  for (const file of ['package.json', 'package-lock.json', 'start.js', 'koishi.example.yml']) copyWorkspaceResource(resourceRoot, workspaceRoot, file, { replace: true })
  const dirs = [path.join(workspaceRoot, 'data'), path.join(workspaceRoot, 'runtime'), path.join(workspaceRoot, 'runtime', 'downloads'), path.join(workspaceRoot, 'runtime', 'logs')]
  if (options.includeNapcat !== false) dirs.push(path.join(workspaceRoot, 'runtime', 'napcat'))
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'package.json'), 'utf8')).version || '' } catch {}
  fs.writeFileSync(path.join(workspaceRoot, '.lianlian-workspace.json'), JSON.stringify({ version, resourceRoot, workspaceRoot, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  return { ok: true, skipped: false, workspaceRoot, resourceRoot, version }
}

function writeRuntimeLayout(options = {}) {
  ensurePackagedWorkspace(options)
  const includeNapcat = options.includeNapcat !== false
  const includeNodeModules = options.includeNodeModules !== false
  const dirs = [runtimePath(), runtimePath('downloads'), runtimePath('logs'), path.join(KOISHI_DIR, 'data')]
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

function inspectChinesePathWrite(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return testChinesePathWrite(dir)
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
  if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(`下载文件过大：${stat.size} bytes`)
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

function downloadToRuntime(url, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  options = options || {}
  const redirects = Number.isFinite(options.redirects) ? options.redirects : 0
  let settled = false
  let currentFilePath = ''
  const finish = (err, filePath, detail) => {
    if (settled) return
    settled = true
    if (err && filePath) {
      try { fs.unlinkSync(filePath) } catch {}
    }
    callback(err, filePath, detail)
  }
  let parsed
  try { parsed = new URL(url) } catch { finish(new Error('下载地址无效')); return }
  if (!['http:', 'https:'].includes(parsed.protocol)) { finish(new Error('只支持 http/https 下载地址')); return }
  if (isBlockedDownloadHost(parsed.hostname)) { finish(new Error('blocked: private or local download host')); return }
  try { writeRuntimeLayout({ includeNapcat: false, includeNodeModules: false }) }
  catch (e) { finish(new Error('准备本地部署工作目录失败：' + describeFsError(e))); return }
  const client = parsed.protocol === 'https:' ? https : http
  const req = client.get(parsed, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume()
      if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
        finish(new Error('too many download redirects'))
        return
      }
      downloadToRuntime(new URL(response.headers.location, parsed).toString(), { ...options, redirects: redirects + 1 }, finish)
      return
    }
    if (response.statusCode !== 200) { response.resume(); finish(new Error('下载失败：HTTP ' + response.statusCode)); return }
    const declared = parseInt(response.headers['content-length'], 10)
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) { response.resume(); finish(new Error('下载文件过大：' + declared + ' bytes')); return }
    const name = getDownloadFileName(parsed, response, options)
    const filePath = runtimePath('downloads', name)
    currentFilePath = filePath
    const stream = fs.createWriteStream(filePath)
    let received = 0
    response.on('data', chunk => {
      received += chunk.length
      if (received > MAX_DOWNLOAD_BYTES) {
        finish(new Error('下载文件过大：' + received + ' bytes'), filePath)
        try { req.destroy(new Error('too large')) } catch {}
        try { stream.destroy() } catch {}
      }
    })
    response.pipe(stream)
    stream.on('finish', () => stream.close(() => { try { finish(null, filePath, validateDownloadedFile(filePath, { ...options, expectedContentType: response.headers['content-type'] })) } catch (e) { finish(e, filePath) } }))
    stream.on('error', err => finish(err, filePath))
    response.on('error', err => finish(err, filePath))
  })
  req.setTimeout(120000, () => req.destroy(new Error('下载超时')))
  req.on('error', err => finish(err, currentFilePath))
}

function psCommandArg(value) { return "'" + String(value).replace(/'/g, "''") + "'" }

function formatLocalNpmCommand(args = []) {
  const npm = getLocalToolCommand('npm')
  if (process.platform === 'win32') {
    const prefix = npm === 'npm' ? 'npm' : '& ' + psCommandArg(npm)
    return [prefix].concat(args.map(psCommandArg)).join(' ')
  }
  return [shellQuote(npm)].concat(args.map(shellQuote)).join(' ')
}

function getNoProxyEnvOverrides() { return Object.fromEntries(NPM_PROXY_ENV_KEYS.map(key => [key, ''])) }

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

function runNpmCommand(args, options = {}) {
  const npm = getLocalToolCommand('npm')
  const env = getLocalToolEnv(options.env || {})
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(npm)) {
    return execFileSync('cmd.exe', ['/d', '/c', npm, ...args], { cwd: options.cwd || KOISHI_DIR, env, timeout: options.timeout || 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return execFileSync(npm, args, { cwd: options.cwd || KOISHI_DIR, env, timeout: options.timeout || 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function collectNpmInstallDiagnostics(force = false) {
  const cache = getNpmDiagnosticsCache()
  const now = Date.now()
  if (!force && cache.data && now - cache.at < 10000) return cache.data
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
  const config = { proxy: runNpmConfigGet('proxy'), httpsProxy: runNpmConfigGet('https-proxy'), registry: redactProxyValue(runNpmConfigGet('registry')) || 'https://registry.npmjs.org/' }
  const data = { env, config, checkedAt: now, workspace, paths: { projectDir: path.resolve(KOISHI_DIR), runtimeDir: runtimePath(), portableNodeDir: getPortableNodeDir(), nodeModulesPath: path.join(KOISHI_DIR, 'node_modules') }, tools: { nodeSourcePath: nodeInfo.sourcePath || '', nodeSource: nodeInfo.source || '', npmSourcePath: npmInfo.sourcePath || '', npmSource: npmInfo.source || '', npmCommand: getLocalToolCommand('npm') }, dependencies: getProjectDependencyStatus() }
  data.proxy = diagnoseNpmProxy(data)
  setNpmDiagnosticsCache({ at: now, data })
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
  return { candidates, loopback, staleLoopback, shouldBypass: staleLoopback.length > 0, reason: staleLoopback.length ? `检测到失效本机代理 ${staleLoopback.map(item => `${item.hostname}:${item.port}`).join('、')}` : (loopback.length ? '检测到本机代理端口正在监听' : '') }
}

function repairNpmProxyConfig(env = getNoProxyEnvOverrides()) {
  const actions = []
  for (const args of [['config', 'delete', 'proxy', '--location=project'], ['config', 'delete', 'https-proxy', '--location=project'], ['config', 'set', 'registry', 'https://registry.npmmirror.com', '--location=project']]) {
    try { runNpmCommand(args, { env }); actions.push({ command: formatLocalNpmCommand(args), ok: true }) }
    catch (e) { actions.push({ command: formatLocalNpmCommand(args), ok: false, message: String(e.stderr || e.message || '').trim() }) }
  }
  return actions
}

function commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy) {
  const commands = []
  if (hasEnvProxy && process.platform === 'win32') { for (const key of NPM_PROXY_ENV_KEYS) commands.push(`$env:${key} = ""`) }
  if (hasNpmProxy) { commands.push(formatLocalNpmCommand(['config', 'delete', 'proxy'])); commands.push(formatLocalNpmCommand(['config', 'delete', 'https-proxy'])) }
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
    return { code: 'NPM_PROXY_REFUSED', title: 'npm 连接本机代理失败', summary: `npm 正在通过本机代理 ${endpoint} 访问 npm registry，但这个端口连不上。通常是代理软件没有启动、端口变了，或 npm 里残留了旧代理配置。`, fixSteps: [`如果你需要代理，请先打开代理软件，并确认它监听的是 ${endpoint}。`, diag.repair?.envClearedForRetry ? '部署器已尝试清理本次 npm install 的代理环境；如果仍失败，请确认是否还有系统代理或安全软件接管了连接。' : '如果你不需要代理，优先点击"一键修复代理并重试"，部署器会用内部 npm 路径执行修复并清理本次 npm install 的代理环境。', '下面的命令已使用部署器实际 npm 路径；普通 PowerShell 里没有全局 npm 时也可以复制执行。', '处理完成后，回到部署器点击"执行 npm install"或"一键修复代理并重试"。'], commands: commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy), diagnostics: diag }
  }
  if (/EAI_AGAIN|ENOTFOUND/i.test(text)) return { code: 'NPM_DNS_FAILED', title: 'npm 域名解析失败', summary: 'npm 无法解析 registry 域名，通常是 DNS、网络或代理配置问题。', fixSteps: ['确认电脑可以打开 npm registry 或 npm 镜像源网站。', '切换网络或 DNS 后重试。', '如果使用代理，请确认代理软件已启动。'], commands: [formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i.test(text)) return { code: 'NPM_TIMEOUT', title: 'npm 下载超时', summary: 'npm registry 响应太慢或网络被代理/防火墙阻断。', fixSteps: ['先确认网络稳定。', '可以切换到 npm 镜像源后重试。', '如果使用代理，请确认代理软件运行正常。'], commands: [formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to verify the first certificate/i.test(text)) return { code: 'NPM_CERT_FAILED', title: 'npm 证书校验失败', summary: '网络代理或证书环境让 npm 无法校验证书。', fixSteps: ['优先检查代理软件的 HTTPS 解密/证书设置。', '确认系统时间正确。', '不要随意关闭 strict-ssl，除非你明确知道当前网络环境需要这样做。'], commands: [formatLocalNpmCommand(['config', 'get', 'strict-ssl'])], diagnostics: diag }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) return { code: 'NPM_PERMISSION_FAILED', title: 'npm 写入文件失败', summary: 'npm 没有权限写入项目目录，或文件正被其他进程占用。', fixSteps: ['关闭正在占用项目目录的终端、编辑器或杀毒拦截。', '确认部署器所在目录可写，不要放在 Program Files 等系统目录。', '重新打开部署器后再试一次。'], commands: [], diagnostics: diag }
  if (/\bE401\b|\bE403\b|unauthorized|forbidden/i.test(text)) return { code: 'NPM_AUTH_FAILED', title: 'npm registry 权限错误', summary: '当前 registry 拒绝访问，可能是私有源认证过期或 registry 配错。', fixSteps: ['检查 npm registry 是否应为公开源。', '如果不需要私有源，切换到 npm 镜像源后重试。'], commands: [formatLocalNpmCommand(['config', 'get', 'registry']), formatLocalNpmCommand(['config', 'set', 'registry', 'https://registry.npmmirror.com'])], diagnostics: diag }
  if (/npm error/i.test(text)) return { code: 'NPM_FAILED', title: 'npm install 失败', summary: 'npm install 已退出，部署器暂时无法判断唯一原因。请先查看下方原始日志里最靠前的 npm error。', fixSteps: ['优先处理日志中第一条 npm error。', '确认网络、代理、磁盘权限和项目目录可写。', '处理后点击"执行 npm install"重试。'], commands: [formatLocalNpmCommand(['config', 'get', 'registry'])], diagnostics: diag }
  return null
}

function getBlockedLocalTaskStatus(key, extra = {}) {
  const target = getLocalDeployTarget()
  return getTaskPublicStatus(key, { blocked: true, localDeployTarget: target, running: false, message: target.blockedReason, ...extra })
}

function fileSha256(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return ''
    const hash = crypto.createHash('sha256')
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(1, stat.size || 1)))
    try {
      let position = 0
      while (position < stat.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally { fs.closeSync(fd) }
    return hash.digest('hex')
  } catch { return '' }
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
  if (!unchanged) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, text, 'utf8') }
  const hash = fileSha256(filePath)
  return { path: rel, action: unchanged ? 'unchanged' : (existed ? 'overwritten' : 'created'), backup, beforeHash, sha256: hash, deleteByDefault: cfg.deleteByDefault !== false, sensitive: !!cfg.sensitive, kind: cfg.kind || 'config' }
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
  const missing = required.filter(name => !packages[name])
  const ready = fs.existsSync(nodeModules) && required.every(name => packages[name])
  return { ready, nodeModules: { exists: fs.existsSync(nodeModules), path: nodeModules }, packageLock: { exists: fs.existsSync(packageLock), path: packageLock }, packages, missing, reason: ready ? '项目依赖已安装' : `项目依赖未完整安装${missing.length ? '，缺少：' + missing.join('、') : ''}` }
}

function getAiKeyStatus(providerInput) {
  const readFileSync = (p) => { try { const c = fs.readFileSync(p, 'utf8'); return String(c || '').trim() } catch { return '' } }
  const provider = String(providerInput || readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'opencode').trim() || 'opencode'
  const keyFiles = { opencode: path.join(DATA_DIR, 'ai-openai-key.txt'), deepseek: path.join(DATA_DIR, 'ai-deepseek-key.txt'), dashscope: path.join(DATA_DIR, 'ai-dashscope-key.txt'), glm: path.join(DATA_DIR, 'ai-glm-key.txt'), mimorium: path.join(DATA_DIR, 'ai-mimorium-key.txt') }
  const file = keyFiles[provider] || keyFiles.opencode
  const value = readFileSync(file)
  return { provider, configured: !!value.trim(), path: isInsidePath(KOISHI_DIR, file) ? toProjectRel(file) : file, reason: value.trim() ? 'AI Key 已配置' : 'AI Key 未配置，基础部署可继续，AI 回复暂不可用' }
}

function getNapcatLoginHint() {
  const lines = readLastLogLines(localTasks.napcat.logFile, 220).join('\n')
  if (/Usage:\s*\.\\NapCatWinBootMain\.exe\s+<quickLogin>|Error Code:\s*2|Process Path:.*QQ\.exe/i.test(lines)) return { status: 'failed', reason: 'NapCat 启动入口失败：当前包可能缺少 bootmain/QQ.exe，或启动脚本缺少 quickLogin 参数。请重新安装官方 Windows 包后重试。' }
  if (/登录成功|已登录|login\s+success|account.*online/i.test(lines)) return { status: 'ok', reason: '日志显示 NapCat 已登录' }
  if (/二维码|扫码|qrcode|scan|login/i.test(lines)) return { status: 'waiting', reason: 'NapCat 已启动，等待扫码或登录确认' }
  return { status: 'unknown', reason: '暂未能从日志确认登录状态，请在 NapCat WebUI 或控制台完成扫码' }
}

function getLocalNapcatDeployStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    return getBlockedLocalTaskStatus('napcat', { found: false, installation: detectNapcatInstallation(), webuiPort: { available: false, status: 'unsupported', reason: target.blockedReason }, onebotPort: { available: false, status: 'unsupported', reason: target.blockedReason }, webuiUrl: '', tokenAvailable: false, login: { status: 'blocked', reason: target.blockedReason } })
  }
  const detected = detectNapcatInstallation()
  const webuiListen = resolveNapcatWebuiListenPort()
  const onebotListen = resolveNapcatOnebotListenPort()
  const webuiPort = checkPortState(webuiListen)
  const onebotPort = checkPortState(onebotListen)
  const token = process.env.NAPCAT_TOKEN || getNapcatToken()
  const login = getNapcatLoginHint()
  return getTaskPublicStatus('napcat', { found: detected.found, installation: detected, running: localTasks.napcat.running || webuiPort.status === 'occupied' || onebotPort.status === 'occupied', webuiPort, onebotPort, webuiUrl: 'http://127.0.0.1:' + webuiListen + '/', tokenAvailable: !!token, login })
}

function getLocalKoishiDeployStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) return getBlockedLocalTaskStatus('koishi', { port: { available: false, status: 'unsupported', reason: target.blockedReason }, loaded: false, url: '' })
  const koishiListen = resolveKoishiListenPort()
  const port = checkPortState(koishiListen)
  const lines = readLastLogLines(localTasks.koishi.logFile, 220).join('\n')
  const loaded = /adapter-onebot|dongxuelian-ai|server listening|app started|koishi/i.test(lines)
  return getTaskPublicStatus('koishi', { running: localTasks.koishi.running || port.status === 'occupied', port, loaded, url: 'http://127.0.0.1:' + koishiListen + '/' })
}

function getLocalNpmInstallStatus() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) return getBlockedLocalTaskStatus('npmInstall', { dependencies: { ready: false, reason: target.blockedReason } })
  const status = getTaskPublicStatus('npmInstall', { dependencies: getProjectDependencyStatus() })
  const guide = buildNpmInstallFailureGuide(status.logLines, localTasks.npmInstall.diagnostics)
  return { ...status, failureGuide: guide }
}

function buildLocalReadyCheck() {
  const target = getLocalDeployTarget()
  if (!target.canRunWindowsLocalDeploy) {
    const checks = { node: false, npm: false, dependencies: false, localConfig: false, napcatInstalled: false, napcatStarted: false, onebotPort: false, koishiStarted: false, aiKey: false }
    return { ok: true, blocked: true, localDeployTarget: target, basicReady: false, fullyReady: false, checks, node: { ok: false, reason: target.blockedReason }, npm: { found: false, reason: target.blockedReason }, dependencies: { ready: false, reason: target.blockedReason }, localConfig: { ok: true, files: [], protected: [] }, napcat: getLocalNapcatDeployStatus(), koishi: getLocalKoishiDeployStatus(), aiKey: getAiKeyStatus(), dashboardUrl: '', koishiUrl: '', napcatUrl: '', message: target.blockedReason }
  }
  const nodeInfo = getCommandInfo('node', 18)
  const npmInfo = getCommandInfo('npm')
  const dependencies = getProjectDependencyStatus()
  const localConfig = buildLocalConfigPreview()
  const napcat = getLocalNapcatDeployStatus()
  const koishi = getLocalKoishiDeployStatus()
  const aiKey = getAiKeyStatus()
  const checks = { node: nodeInfo.ok, npm: npmInfo.found, dependencies: dependencies.ready, localConfig: (localConfig.files || []).some(item => item.action === 'delete' && item.path === 'koishi.yml'), napcatInstalled: napcat.found, napcatStarted: napcat.running, onebotPort: napcat.onebotPort.status === 'occupied', koishiStarted: koishi.running, aiKey: aiKey.configured }
  const basicReady = checks.node && checks.npm && checks.dependencies && checks.localConfig && checks.napcatInstalled && checks.napcatStarted && checks.onebotPort && checks.koishiStarted
  return { ok: true, blocked: false, localDeployTarget: target, basicReady, fullyReady: basicReady && checks.aiKey, checks, node: nodeInfo, npm: npmInfo, dependencies, localConfig, napcat, koishi, aiKey, dashboardUrl: `http://127.0.0.1:${PORT}/dashboard/`, koishiUrl: 'http://127.0.0.1:' + resolveKoishiListenPort() + '/', napcatUrl: 'http://127.0.0.1:' + resolveNapcatWebuiListenPort() + '/', message: basicReady ? (aiKey.configured ? '本地部署已完成，AI Key 已配置' : '基础部署已完成，AI Key 未配置，AI 回复暂不可用') : '本地部署尚未完全就绪，请查看未通过的检查项' }
}

function buildLocalConfigPreview() {
  const manifest = readLocalDeployManifest()
  const files = []
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : []
  const byPath = new Map(manifestFiles.map(item => [item.path, item]))
  for (const rel of ['koishi.yml', 'start-local.bat']) { if (!byPath.has(rel)) byPath.set(rel, { path: rel, deleteByDefault: true, kind: 'config', reason: '标准本地部署文件' }) }
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
  const protectedPaths = ['runtime/napcat', 'runtime/downloads', 'data/ai-openai-key.txt', 'data/ai-deepseek-key.txt', 'data/ai-dashscope-key.txt', 'data/user-profiles', 'runtime/logs'].filter(rel => fs.existsSync(resolveProjectRel(rel))).map(rel => ({ path: rel, action: 'keep', reason: '用户数据或运行时文件默认保留' }))
  return { ok: true, files, protected: protectedPaths, manifest: { exists: fs.existsSync(LOCAL_DEPLOY_MANIFEST_FILE), path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE) } }
}

function deleteLocalConfigFiles() {
  const preview = buildLocalConfigPreview()
  const deleted = [], kept = [], errors = []
  for (const item of preview.files) {
    if (item.action !== 'delete') { kept.push(item); continue }
    try { fs.unlinkSync(resolveProjectRel(item.path)); deleted.push({ path: item.path, size: item.size, status: 'ok' }) }
    catch (e) { errors.push({ path: item.path, reason: e.message }) }
  }
  return { ok: errors.length === 0, deleted, kept: kept.concat(preview.protected || []), errors }
}

function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'" }

function validateNapcatInstallDir(input) {
  ensurePackagedWorkspace()
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

function httpsGetJson(url, callback, redirects = 0) {
  let settled = false
  const finish = (err, data) => {
    if (settled) return
    settled = true
    callback(err, data)
  }
  const req = https.get(url, { headers: { 'User-Agent': 'LianBoard-Dashboard' } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume()
      if (redirects >= MAX_DOWNLOAD_REDIRECTS) { finish(new Error('GitHub API 重定向次数过多')); return }
      httpsGetJson(new URL(response.headers.location, url).toString(), finish, redirects + 1)
      return
    }
    if (response.statusCode !== 200) { response.resume(); finish(new Error('GitHub API 请求失败：HTTP ' + response.statusCode)); return }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => {
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
        finish(new Error('GitHub API 响应过大'))
        try { req.destroy(new Error('response too large')) } catch {}
      }
    })
    response.on('end', () => { try { finish(null, JSON.parse(body)) } catch (e) { finish(e) } })
  })
  req.setTimeout(30000, () => req.destroy(new Error('GitHub API 请求超时')))
  req.on('error', finish)
}

function pickNapcatWindowsAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const zipAssets = assets.filter(item => /\.zip$/i.test(item.name || '') && !/(linux|darwin|mac|android|arm64|aarch64)/i.test(item.name || ''))
  return zipAssets.find(item => /^NapCat\.Shell\.Windows\.OneKey\.zip$/i.test(item.name || '')) || zipAssets.find(item => /^NapCat\.Shell\.Windows\.Node\.zip$/i.test(item.name || '')) || zipAssets.find(item => /(win|windows)/i.test(item.name || '')) || zipAssets[0] || null
}

function findFilesRecursive(root, matcher, maxDepth = 6, maxCount = 600) {
  const matches = []
  let count = 0
  function walk(dir, depth) {
    if (depth > maxDepth || count > maxCount) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      count++
      if (count > maxCount) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (matcher(entry.name, full)) matches.push(full)
    }
  }
  walk(root, 0)
  return matches
}

function cleanupRuntimeInstallStaging(prefix) {
  const rDir = runtimePath()
  try {
    for (const entry of fs.readdirSync(rDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        try { removePathWithRetry(path.join(rDir, entry.name)) } catch {}
      }
    }
  } catch {}
}

function extractZipArchive(archivePath, destinationDir) {
  if (!fs.existsSync(archivePath)) throw new Error('解压源文件不存在：' + archivePath)
  const stat = fs.statSync(archivePath)
  if (!stat.isFile()) throw new Error('解压源路径不是文件：' + archivePath)
  if (stat.size <= 0) throw new Error('解压源文件为空：' + archivePath)
  if (!hasZipMagic(archivePath)) throw new Error('解压源文件不是有效 zip 包：' + archivePath)
  ensureCleanDirectory(destinationDir)
  const attempts = []
  try { execFileSync('tar.exe', ['-xf', archivePath, '-C', destinationDir], { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }); return { method: 'tar.exe', attempts, archivePath, destinationDir, size: stat.size } }
  catch (e) { attempts.push({ method: 'tar.exe', code: e.status || e.code || '', error: String(e.stderr || e.message || '').trim() }) }
  try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destinationDir)} -Force`], { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }); return { method: 'PowerShell Expand-Archive', attempts, archivePath, destinationDir, size: stat.size } }
  catch (e) {
    attempts.push({ method: 'PowerShell Expand-Archive', code: e.status || e.code || '', error: String(e.stderr || e.message || '').trim() })
    try { removePathWithRetry(destinationDir) } catch {}
    const err = new Error('自动解压失败：' + attempts.map(item => `${item.method}: ${item.error || '失败'}`).join('；'))
    err.attempts = attempts; err.stage = 'extract'; err.archivePath = archivePath; err.destinationDir = destinationDir; err.fileSize = stat.size
    throw err
  }
}

function runNapcatInstallerIfPresent(stagingDir) {
  const installers = findFilesRecursive(stagingDir, name => /^NapCatInstaller\.exe$/i.test(name), 6, 800)
  if (!installers.length) return { ran: false, ok: false, reason: '未找到 NapCatInstaller.exe，可手动运行解压目录内的安装器' }
  const installer = installers[0]
  try { execFileSync(installer, [], { cwd: path.dirname(installer), timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }); return { ran: true, ok: true, path: installer, reason: 'NapCatInstaller.exe 已执行' } }
  catch (e) { return { ran: true, ok: false, path: installer, reason: 'NapCatInstaller.exe 执行失败或被中断：' + String(e.stderr || e.message || '').trim() } }
}

function findNapcatCopyRoot(stagingDir) {
  const candidates = [stagingDir]
  function walk(dir, depth) {
    if (depth >= 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) { if (entry.isDirectory()) { const full = path.join(dir, entry.name); candidates.push(full); walk(full, depth + 1) } }
  }
  walk(stagingDir, 0)
  const inspected = candidates.map(dir => inspectNapcatCandidate(dir))
  const installed = inspected.filter(item => item.found).sort((a, b) => { const aD = a.entry ? path.relative(a.path, a.entry).split(path.sep).filter(Boolean).length : 99; const bD = b.entry ? path.relative(b.path, b.entry).split(path.sep).filter(Boolean).length : 99; return aD - bD || b.path.length - a.path.length })[0]
  if (installed?.path) return installed.path
  const partial = inspected.find(item => item.exists && item.status === 'partial' && /启动文件|配置|安装器|bootmain/i.test(item.reason || ''))
  return partial?.path || stagingDir
}

function buildNapcatManualSteps(archivePath, installDir) {
  return [`打开下载包：${archivePath}`, `把压缩包完整解压到：${installDir}`, '进入解压出的 NapCat.XXXX.Shell 目录，运行 NapCatInstaller.exe 等待自动配置完成。', '确认目录里出现 napcat.bat 或 NapCatWinBootMain.exe 后，回到部署器点击"检测环境"。']
}

function downloadNapcatWindowsRelease(installDir, callback) {
  httpsGetJson('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest', (apiErr, release) => {
    if (apiErr) return callback(apiErr)
    const asset = pickNapcatWindowsAsset(release)
    if (!asset?.browser_download_url) { return callback(new Error('未找到可自动安装的 Windows zip 资产' + ((release?.assets || []).map(item => item.name).filter(Boolean).join(', ') ? '，候选：' + (release?.assets || []).map(item => item.name).filter(Boolean).join(', ') : ''))) }
    downloadToRuntime(asset.browser_download_url, { preferredName: asset.name, expectedExt: '.zip', minBytes: 128 * 1024 }, (downloadErr, filePath, download) => {
      if (downloadErr) return callback(downloadErr)
      const stagingDir = runtimePath('napcat-install-' + Date.now().toString(36))
      try {
        cleanupRuntimeInstallStaging('napcat-install-')
        removePathWithRetry(installDir)
        const extraction = extractZipArchive(filePath, stagingDir)
        const installer = runNapcatInstallerIfPresent(stagingDir)
        fs.mkdirSync(installDir, { recursive: true })
        const sourceRoot = findNapcatCopyRoot(stagingDir)
        const content = fs.readdirSync(sourceRoot)
        if (!content.length) throw new Error('NapCat zip 解压后目录为空')
        copyRecursiveSync(sourceRoot, installDir)
        const detected = inspectNapcatCandidate(installDir)
        const needsManualSetup = !detected.found || (installer.ran && !installer.ok)
        callback(null, { asset: asset.name, filePath, download, installDir, extraction, installer, napcat: detected, needsManualSetup, manualSteps: needsManualSetup ? buildNapcatManualSteps(filePath, installDir) : [], message: needsManualSetup ? 'NapCat OneKey 包已下载并解压，但仍需要按提示完成安装器配置' : 'NapCat OneKey 包已下载、解压并完成检测' })
      } catch (e) {
        try { removePathWithRetry(installDir) } catch {}
        callback(new Error('NapCat 下载完成但自动解压/安装失败：' + describeFsError(e, String(e.message || '').trim())), { asset: asset.name, filePath, download, installDir, manualSteps: buildNapcatManualSteps(filePath, installDir), attempts: e.attempts || [], stage: e.stage || 'install', archivePath: e.archivePath || filePath, fileSize: e.fileSize })
      } finally { try { removePathWithRetry(stagingDir) } catch {} }
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
  return { version, arch, fileName, url: `https://nodejs.org/dist/${version}/${fileName}` }
}

function findExtractedNodeRoot(stagingDir) {
  const direct = path.join(stagingDir, 'node.exe')
  if (fs.existsSync(direct)) return stagingDir
  let entries = []
  try { entries = fs.readdirSync(stagingDir, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) { if (entry.isDirectory() && fs.existsSync(path.join(stagingDir, entry.name, 'node.exe'))) return path.join(stagingDir, entry.name) }
  return ''
}

function installPortableNodeWindows(callback) {
  if (process.platform !== 'win32') return callback(new Error('便携 Node/npm 自动安装只支持 Windows 本地部署器'))
  const currentNode = getCommandInfo('node', 18)
  const currentNpm = getCommandInfo('npm')
  if (currentNode.ok && currentNpm.found && currentNode.ownedByProject && currentNpm.ownedByProject) return callback(null, { skipped: true, message: '项目便携 Node/npm 已安装', node: currentNode, npm: currentNpm })
  httpsGetJson('https://nodejs.org/dist/index.json', (apiErr, releases) => {
    if (apiErr) return callback(apiErr)
    let asset
    try { asset = pickNodeWindowsRelease(releases) } catch (e) { return callback(e) }
    downloadToRuntime(asset.url, { preferredName: asset.fileName, expectedExt: '.zip', minBytes: 1024 * 1024 }, (downloadErr, archivePath, download) => {
      if (downloadErr) return callback(downloadErr)
      const stagingDir = runtimePath('node-install-' + Date.now().toString(36))
      const targetDir = getPortableNodeDir()
      try {
        cleanupRuntimeInstallStaging('node-install-')
        ensureCleanDirectory(stagingDir)
        extractZipArchive(archivePath, stagingDir)
        const nodeRoot = findExtractedNodeRoot(stagingDir)
        if (!nodeRoot) throw new Error('Node zip 解压后未找到 node.exe')
        ensureCleanDirectory(targetDir)
        copyRecursiveSync(nodeRoot, targetDir)
        for (const rel of ['node.exe', 'npm.cmd', 'npx.cmd']) { if (process.platform === 'win32' && !fs.existsSync(path.join(targetDir, rel))) throw new Error('便携 Node/npm 安装不完整，缺少：' + rel) }
        const node = getCommandInfo('node', 18)
        const npm = getCommandInfo('npm')
        if (!node.ok || !node.ownedByProject) throw new Error('便携 Node 校验失败：' + (node.reason || 'node 不可用'))
        if (!npm.found || !npm.ownedByProject) throw new Error('便携 npm 校验失败：' + (npm.reason || 'npm 不可用'))
        callback(null, { skipped: false, message: '便携 Node/npm 已安装到 runtime/node', asset, archivePath, download, installDir: targetDir, node, npm })
      } catch (e) {
        try { removePathWithRetry(targetDir) } catch {}
        callback(new Error('便携 Node/npm 安装失败：' + describeFsError(e, String(e.stderr || e.message || '').trim())), { asset, archivePath, download, installDir: targetDir, attempts: e.attempts || [], stage: e.stage || 'install' })
      } finally { try { removePathWithRetry(stagingDir) } catch {} }
    })
  })
}

function getNapcatStartEntry() {
  const result = napcatGetStartEntry()
  return result
}

function prepareNpmInstallRun(options = {}) {
  const forceRepair = !!options.forceRepair
  const diagnostics = collectNpmInstallDiagnostics(true)
  const proxy = diagnostics.proxy || diagnoseNpmProxy(diagnostics)
  const shouldClean = forceRepair || proxy.shouldBypass
  const env = shouldClean ? getNoProxyEnvOverrides() : {}
  const repair = { forced: forceRepair, automatic: !forceRepair && proxy.shouldBypass, envClearedForRetry: shouldClean, reason: shouldClean ? (proxy.reason || '已清理本次 npm install 的代理环境') : '', actions: [] }
  if (shouldClean) repair.actions = repairNpmProxyConfig(env)
  diagnostics.proxy = proxy
  diagnostics.repair = repair
  return { env, diagnostics, repair }
}

module.exports = {
  MAX_DOWNLOAD_BYTES, MAX_DEPLOY_TASK_LOG_BYTES, MAX_DEPLOY_UPLOAD_BYTES, MAX_DOWNLOAD_REDIRECTS, MAX_JSON_RESPONSE_BYTES, HASH_CHUNK_BYTES,
  validateDeployServer, validateDeployAppDir, validateDeployTarget,
  remoteJoin, sshCommand, scpRemoteTarget, scpCommand,
  hashFile, computeFingerprint, writeDeployFingerprint,
  isBlockedDownloadHost, getLocalWorkDirSafety, getLocalDeployTarget, requireWindowsLocalDeployTarget,
  ensureWritableDir, copyWorkspaceResource, ensurePackagedWorkspace, writeRuntimeLayout,
  testChinesePathWrite, inspectChinesePathWrite,
  safeDecodeURIComponent, sanitizeDownloadName, getContentDispositionFileName, ensureExtension,
  hasZipMagic, validateDownloadedFile, getDownloadFileName, downloadToRuntime,
  psCommandArg, formatLocalNpmCommand, getNoProxyEnvOverrides, runNpmConfigGet, runNpmCommand,
  collectNpmInstallDiagnostics, collectNpmProxyCandidates, diagnoseNpmProxy,
  repairNpmProxyConfig, commandListForNpmProxyFix, buildNpmInstallFailureGuide,
  getBlockedLocalTaskStatus, fileSha256,
  readLocalDeployManifest, backupLocalDeployFile, writeTrackedLocalFile, writeLocalDeployManifest,
  getProjectDependencyStatus, getAiKeyStatus,
  getNapcatLoginHint, resolveKoishiListenPort,
  getLocalNapcatDeployStatus, getLocalKoishiDeployStatus, getLocalNpmInstallStatus, buildLocalReadyCheck,
  buildLocalConfigPreview, deleteLocalConfigFiles,
  psQuote, validateNapcatInstallDir, httpsGetJson, pickNapcatWindowsAsset,
  findFilesRecursive, cleanupRuntimeInstallStaging, extractZipArchive,
  runNapcatInstallerIfPresent, findNapcatCopyRoot, buildNapcatManualSteps,
  downloadNapcatWindowsRelease, pickNodeWindowsRelease, findExtractedNodeRoot, installPortableNodeWindows,
  getNapcatStartEntry, prepareNpmInstallRun,
}
