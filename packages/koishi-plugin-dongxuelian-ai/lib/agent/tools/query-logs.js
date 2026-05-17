/**
 * MODULE: 运行日志查询工具。
 * 安全：只读 runtime/logs 与数据目录下常见日志，输出脱敏和限长。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../constants')

const LOG_DIRS = [path.resolve(process.cwd(), 'runtime', 'logs'), path.join(DATA_DIR, 'logs')]
const FALLBACK_LOG_FILE = path.resolve(process.cwd(), 'koishi.log')
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LOG_TAIL_BYTES = 256 * 1024
const SECRET_RE = /(?:api[_-]?key|token|authorization|password|secret)[=:：\s]+[^\s,;]+/ig

function redact(text = '') {
  return String(text).replace(SECRET_RE, m => m.replace(/([=:：\s]+).+$/, '$1[REDACTED]'))
}

async function collectLogFiles() {
  const files = []
  for (const dir of LOG_DIRS) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:log|txt)$/i.test(entry.name)) files.push(path.join(dir, entry.name))
    }
  }
  try {
    const st = await fs.stat(FALLBACK_LOG_FILE)
    if (st.isFile() && !files.includes(FALLBACK_LOG_FILE)) files.push(FALLBACK_LOG_FILE)
  } catch {}
  return files
}

function parseSince(value = '') {
  const raw = String(value || '').trim()
  if (!raw || raw === 'today') {
    const d = new Date()
    // Use local date, not UTC: today 00:00 in server's timezone
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const hours = raw.match(/^(\d+)h$/i)
  if (hours) return Date.now() - Number(hours[1]) * 3600000
  const ts = Date.parse(raw)
  return Number.isFinite(ts) ? ts : 0
}

async function readLogTail(file, stat) {
  const size = Number(stat?.size || 0)
  const handle = await fs.open(file, 'r')
  try {
    const length = Math.min(MAX_LOG_TAIL_BYTES, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

module.exports = {
  definition: {
    name: 'query_logs',
    description: '查看近期服务器/Koishi 日志。不传 query 时直接展示最近日志行（tail 模式）；传 query 时按关键词/正则过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或正则过滤，例如 retcode、ERROR；不传则返回最近日志原文' },
        level: { type: 'string', description: '日志级别过滤，例如 error、warn，可选' },
        since: { type: 'string', description: '时间范围，默认 today；也支持 6h 或 ISO 时间' },
        limit: { type: 'number', description: '最大返回行数，默认 80，最大 200' },
      },
    },
  },
  async execute(params = {}) {
    const hasQuery = typeof params.query === 'string' && params.query.trim().length > 0
    const query = hasQuery ? params.query.trim() : (params.level || '')
    const limit = Math.max(1, Math.min(200, parseInt(params.limit, 10) || 80))
    const since = parseSince(params.since || 'today')
    const level = String(params.level || '').trim().toLowerCase()
    const files = await collectLogFiles()
    const matches = []

    const tailMode = !hasQuery && !level
    if (tailMode) {
      for (const file of files) {
        const stat = await fs.stat(file).catch(() => null)
        if (!stat || stat.size > MAX_FILE_BYTES || (since && stat.mtimeMs < since)) continue
        const text = await readLogTail(file, stat).catch(() => '')
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          const line = lines[i].trim()
          if (line) matches.push(`${path.basename(file)}:${i + 1}: ${redact(line).slice(0, 260)}`)
        }
      }
      return matches.length ? `最近 ${matches.length} 条日志：\n${matches.join('\n')}` : '未找到日志。'
    }

    let regex
    try { regex = new RegExp(query, 'i') } catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null)
      if (!stat || stat.size > MAX_FILE_BYTES || (since && stat.mtimeMs < since)) continue
      const text = await readLogTail(file, stat).catch(() => '')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (level && !line.toLowerCase().includes(level)) continue
        if (regex.test(line)) {
          matches.push(`${path.basename(file)}:${i + 1}: ${redact(line).slice(0, 260)}`)
          if (matches.length >= limit) return `找到 ${matches.length} 条日志（已达上限）：\n${matches.join('\n')}`
        }
        regex.lastIndex = 0
      }
    }
    return matches.length ? `找到 ${matches.length} 条日志：\n${matches.join('\n')}` : '未找到匹配日志。'
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
