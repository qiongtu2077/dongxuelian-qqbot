'use strict'

const fs = require('fs')
const path = require('path')
const { KOISHI_DIR, DEBUG_LOG_CONFIG_FILE, MAX_LOG_LIMIT } = require('./paths')
const { redactSensitiveText } = require('koishi-plugin-dongxuelian-ai/lib/core/redactor')

let logEntryCache = { file: '', size: -1, mtimeMs: -1, entries: [] }

function normalizeLoggingConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const enabled = !!(Object.prototype.hasOwnProperty.call(source, 'enabled') ? source.enabled : source.debug)
  const modules = {}
  if (source.modules && typeof source.modules === 'object' && !Array.isArray(source.modules)) {
    for (const [key, value] of Object.entries(source.modules)) {
      if (key) modules[String(key)] = !!value
    }
  }
  return { enabled, updatedAt: source.updatedAt || 0, modules }
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

function readLastLogItems(file, limit = MAX_LOG_LIMIT) {
  if (!fs.existsSync(file)) return []
  const stat = fs.statSync(file)
  const maxBytes = Math.min(stat.size, Math.max(256 * 1024, Math.min(4 * 1024 * 1024, clampLogLimit(limit) * 900)))
  const buffer = Buffer.alloc(maxBytes)
  const fd = fs.openSync(file, 'r')
  const startOffset = stat.size - maxBytes
  try { fs.readSync(fd, buffer, 0, maxBytes, startOffset) }
  finally { fs.closeSync(fd) }
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

function readLastLogLines(file, limit) {
  return readLastLogItems(file, limit).map(item => item.text)
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
  const line = redactSensitiveText(typeof item === 'object' && item ? String(item.text || '') : String(item || ''))
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

module.exports = {
  normalizeLoggingConfig,
  readLoggingConfig,
  writeLoggingConfig,
  clampLogLimit,
  readLastLogItems,
  readLastLogLines,
  classifyLogLevel,
  detectLogModule,
  parseLogLine,
  getFilteredLogEntries,
}
