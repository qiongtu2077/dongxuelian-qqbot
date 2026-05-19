'use strict'
const fs = require('fs')
const path = require('path')
const { execSync, execFileSync } = require('child_process')
const { shellQuote, isInsidePath } = require('./utils')
const { KOISHI_DIR, runtimePath } = require('./paths')

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

function redactProxyValue(value) {
  const text = String(value || '').trim()
  if (!text || text === 'null' || text === 'undefined') return ''
  return text.replace(/(https?:\/\/)([^/@\s]+)@/i, '$1***@')
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

function resolveKoishiListenPort() {
  const raw = String(process.env.KOISHI_PORT || '').trim()
  if (raw) { const n = Number(raw); if (Number.isFinite(n) && n > 0 && n <= 65535) return n }
  try {
    const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8').replace(/^\uFEFF/, '')
    const m = String(yml).match(/^\s*port:\s*(\d+)/m)
    if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n > 0 && n <= 65535) return n }
  } catch {}
  return 5140
}

module.exports = {
  getCommandVersion,
  getCommandPath,
  getPortableNodeDir,
  getPortableToolPath,
  getLocalToolEnv,
  getToolVersion,
  getLocalToolCommand,
  getLocalTaskOptions,
  normalizeProxyValue,
  parseProxyEndpoint,
  redactProxyValue,
  isLoopbackProxyHost,
  isProjectOwnedTool,
  getCommandInfo,
  checkPortState,
  checkPortAvailable,
  resolveKoishiListenPort,
}
