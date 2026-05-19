'use strict'
const fs = require('fs')
const path = require('path')

function parsePositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function log(msg) {
  console.log(`[dashboard] ${msg}`)
}

function getRemoteAddress(req) {
  return String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '').trim()
}

function isLoopbackAddress(address) {
  const value = String(address || '').trim()
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function commandQuote(value) {
  const text = String(value)
  if (process.platform !== 'win32') return shellQuote(text)
  return '"' + text.replace(/"/g, '""') + '"'
}

function isInsidePath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function sleepSync(ms) {
  if (!ms) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function describeFsError(e, fallback = '') {
  const code = e && e.code ? String(e.code) : ''
  if (code === 'ENOTDIR') return '路径冲突：目标路径的某一级已经是文件，不是目录。请删除冲突文件后重试。' + (e.path ? ` 冲突路径：${e.path}` : '')
  if (code === 'EACCES' || code === 'EPERM') return '权限不足或文件被占用。请关闭占用程序，或把部署器移动到可写目录后重试。' + (e.path ? ` 路径：${e.path}` : '')
  if (code === 'EBUSY' || code === 'ENOTEMPTY') return '文件正在被占用或目录未能清空。请关闭 NapCat/QQ/Node 相关进程后重试。' + (e.path ? ` 路径：${e.path}` : '')
  return fallback || String(e?.message || e || '未知错误')
}

function pathConflictError(conflictPath, message = '路径冲突：目标路径的某一级已经是文件，不是目录') {
  const error = new Error(message + '：' + conflictPath)
  error.code = 'ENOTDIR'
  error.path = conflictPath
  return error
}

function isRetriableFsError(error) {
  return ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(String(error?.code || ''))
}

function assertParentDirectories(targetPath) {
  const resolved = path.resolve(targetPath)
  const root = path.parse(resolved).root
  const parts = path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) throw pathConflictError(current)
  }
}

function removePathWithRetry(targetPath, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 5
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 180
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: delayMs })
      if (!fs.existsSync(targetPath)) return true
      lastError = new Error('路径仍然存在，可能被占用：' + targetPath)
      lastError.code = 'EBUSY'
      lastError.path = targetPath
    } catch (error) {
      lastError = error
      if (!isRetriableFsError(error)) break
    }
    if (attempt < retries) sleepSync(delayMs * (attempt + 1))
  }
  if (lastError) throw lastError
  return !fs.existsSync(targetPath)
}

function ensureCleanDirectory(dir) {
  assertParentDirectories(dir)
  removePathWithRetry(dir)
  if (fs.existsSync(dir)) throw pathConflictError(dir, '目标目录清理失败')
  fs.mkdirSync(dir, { recursive: true })
}

function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.write-test-' + Date.now().toString(36))
  fs.writeFileSync(probe, 'ok', 'utf8')
  fs.unlinkSync(probe)
}

function copyRecursiveSync(src, dst) {
  if (!fs.existsSync(src)) return
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    assertParentDirectories(dst)
    if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) throw pathConflictError(dst)
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyRecursiveSync(path.join(src, entry), path.join(dst, entry))
    return
  }
  assertParentDirectories(dst)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) throw pathConflictError(dst, '目标路径已经是目录，无法覆盖为文件')
  fs.copyFileSync(src, dst)
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

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter(item => {
    const key = path.resolve(item).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readFileContent(p, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(p)
    if (stat.isFile() && stat.size <= maxBytes) return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {}
  return ''
}

module.exports = {
  parsePositiveInt,
  json,
  log,
  getRemoteAddress,
  isLoopbackAddress,
  shellQuote,
  commandQuote,
  isInsidePath,
  sleepSync,
  describeFsError,
  pathConflictError,
  isRetriableFsError,
  assertParentDirectories,
  removePathWithRetry,
  ensureCleanDirectory,
  ensureWritableDir,
  copyRecursiveSync,
  listFilesRecursive,
  uniquePaths,
  readFileContent,
}
