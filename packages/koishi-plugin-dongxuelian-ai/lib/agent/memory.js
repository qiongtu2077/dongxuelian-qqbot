/**
 * MODULE: Agent 长期记忆。
 * 职责: 管理显式写入的关键词记忆，支持检索、列出和删除。
 * 边界: 不自动抓取聊天内容、不调用模型、不和 conversation summary 混用。
 * 状态: 无长期内存状态，按用户 JSON 文件持久化。
 */
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../constants')

const MEMORY_DIR = path.join(DATA_DIR, 'agent-memory')
const DASHBOARD_MEMORY_DIR = path.join(DATA_DIR, 'agent-memory-dashboard')
const MAX_MEMORY_FILE_BYTES = 512 * 1024

function safeUserId(userId = '') {
  return String(userId || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 100) || 'unknown'
}

function getMemoryFile(userId) {
  return path.join(MEMORY_DIR, safeUserId(userId) + '.json')
}

async function readMemoryFile(userId) {
  try {
    const file = getMemoryFile(userId)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) return { items: [] }
    const data = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    return { items: Array.isArray(data.items) ? data.items : [] }
  } catch {
    return { items: [] }
  }
}

async function writeMemoryFile(userId, data) {
  await fsp.mkdir(MEMORY_DIR, { recursive: true })
  const file = getMemoryFile(userId)
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, JSON.stringify({ items: data.items.slice(0, 500) }, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

function buildMemoryId(now = Date.now()) {
  return `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function tokenize(text = '') {
  const value = String(text || '').toLowerCase()
  const tokens = []
  const re = /[\u4e00-\u9fff]{2,}|[a-z0-9_+-]{2,}/gi
  let match
  while ((match = re.exec(value))) tokens.push(match[0])
  if (!tokens.length && value.trim()) tokens.push(value.trim())
  return Array.from(new Set(tokens)).slice(0, 32)
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，;；\s]+/)
  return list.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12)
}

async function remember({ userId, channelKey = '', text, tags = [] } = {}) {
  const content = String(text || '').trim()
  if (!content) throw new Error('记忆内容不能为空')
  const data = await readMemoryFile(userId)
  const now = Date.now()
  const item = {
    id: buildMemoryId(now),
    text: content.slice(0, 2000),
    tags: normalizeTags(tags),
    channelKey: String(channelKey || '').slice(0, 120),
    keywords: tokenize(content + ' ' + normalizeTags(tags).join(' ')),
    createdAt: now,
    updatedAt: now,
  }
  data.items.unshift(item)
  await writeMemoryFile(userId, data)
  return item
}

function scoreMemory(item, queryTokens, channelKey = '') {
  const haystack = `${item.text}\n${(item.tags || []).join(' ')}\n${(item.keywords || []).join(' ')}`.toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    if (haystack.includes(token.toLowerCase())) score += token.length >= 4 ? 3 : 1
  }
  if (channelKey && item.channelKey === channelKey) score += 1
  score += Math.max(0, 1 - (Date.now() - (item.createdAt || 0)) / (180 * 24 * 60 * 60 * 1000))
  return score
}

async function searchMemory({ userId, channelKey = '', query = '', limit = 5 } = {}) {
  const data = await readMemoryFile(userId)
  const tokens = tokenize(query)
  const max = Math.max(1, Math.min(20, parseInt(limit, 10) || 5))
  return data.items
    .map(item => ({ item, score: scoreMemory(item, tokens, String(channelKey || '')) }))
    .filter(entry => tokens.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
    .slice(0, max)
    .map(entry => entry.item)
}

async function forgetMemory({ userId, memoryId } = {}) {
  const data = await readMemoryFile(userId)
  const before = data.items.length
  data.items = data.items.filter(item => item.id !== memoryId)
  await writeMemoryFile(userId, data)
  return before - data.items.length
}

async function listMemory({ userId, limit = 20 } = {}) {
  const data = await readMemoryFile(userId)
  return data.items.slice(0, Math.max(1, Math.min(100, parseInt(limit, 10) || 20)))
}

function formatMemoryItems(items = []) {
  if (!items.length) return '没有找到相关记忆。'
  return items.map((item, index) => {
    const tags = item.tags && item.tags.length ? ` #${item.tags.join(' #')}` : ''
    return `${index + 1}. ${item.id}${tags}\n${String(item.text || '').slice(0, 300)}`
  }).join('\n')
}

async function searchDashboardMemory({ userId, query = '' } = {}) {
  const longTermFile = path.join(DASHBOARD_MEMORY_DIR, safeUserId(userId) + '.md')
  try {
    const stat = await fsp.stat(longTermFile)
    if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) return ''
    const content = await fsp.readFile(longTermFile, 'utf8')
    if (!content.trim()) return ''
    if (!query.trim()) return content.trim().slice(0, 2000)
    const tokens = tokenize(query)
    if (!tokens.length) return content.trim().slice(0, 2000)
    const lines = content.split('\n').filter(l => l.trim())
    const matched = lines.filter(line => {
      const lower = line.toLowerCase()
      return tokens.some(t => lower.includes(t.toLowerCase()))
    })
    if (matched.length) return matched.join('\n').slice(0, 2000)
    return content.trim().slice(0, 2000)
  } catch {
    return ''
  }
}

module.exports = {
  MEMORY_DIR,
  DASHBOARD_MEMORY_DIR,
  remember,
  searchMemory,
  searchDashboardMemory,
  forgetMemory,
  listMemory,
  formatMemoryItems,
  tokenize,
}
