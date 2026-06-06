/**
 * MODULE: Agent 长期记忆。
 * 职责: 管理显式写入的关键词记忆，支持检索、列出和删除。
 * 边界: 不自动抓取聊天内容、不调用模型、不和 conversation summary 混用。
 * 状态: 无长期内存状态，按用户 JSON 文件持久化。
 */
const fsp = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { safeUserId, legacySafeUserId } = require('../core/utils') as typeof import('../core/utils')

const MEMORY_DIR: string = path.join(DATA_DIR, 'agent-memory')
const DASHBOARD_MEMORY_DIR: string = path.join(DATA_DIR, 'agent-memory-dashboard')
const MAX_MEMORY_FILE_BYTES = 512 * 1024
const writeLocks: Map<string, Promise<unknown>> = new Map()

interface MemoryItem {
  id: string
  text: string
  tags?: string[]
  channelKey?: string
  keywords?: string[]
  createdAt: number
  updatedAt?: number
}

interface MemoryFileData {
  items: MemoryItem[]
}

interface RememberInput {
  userId?: unknown
  channelKey?: unknown
  text?: unknown
  tags?: unknown
}

interface SearchMemoryInput {
  userId?: unknown
  channelKey?: unknown
  query?: unknown
  limit?: unknown
}

interface ForgetMemoryInput {
  userId?: unknown
  memoryId?: unknown
}

interface ListMemoryInput {
  userId?: unknown
  limit?: unknown
}

interface SearchDashboardMemoryInput {
  userId?: unknown
  query?: unknown
}

function withUserLock<T>(userId: unknown, fn: () => Promise<T> | T): Promise<T> {
  const key = safeUserId(String(userId || ''))
  const prev = writeLocks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn) as Promise<T>
  writeLocks.set(key, next)
  next.finally(() => { if (writeLocks.get(key) === next) writeLocks.delete(key) })
  return next
}

function getMemoryFileCandidates(userId: unknown): string[] {
  const current = safeUserId(String(userId || ''))
  const legacy = legacySafeUserId(String(userId || ''))
  const files = [path.join(MEMORY_DIR, current + '.json')]
  if (legacy !== current) files.push(path.join(MEMORY_DIR, legacy + '.json'))
  return files
}

function getMemoryFile(userId: unknown): string {
  return getMemoryFileCandidates(userId)[0]
}

function normalizeMemoryFileData(data: unknown): MemoryFileData {
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return { items: (data as { items: MemoryItem[] }).items }
  }
  return { items: [] }
}

async function readMemoryFile(userId: unknown): Promise<MemoryFileData> {
  for (const file of getMemoryFileCandidates(userId)) {
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) continue
      const data = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
      return normalizeMemoryFileData(data)
    } catch { /* non-critical: missing or invalid memory candidate falls through to next candidate */ }
  }
  return { items: [] }
}

async function writeMemoryFile(userId: unknown, data: MemoryFileData): Promise<void> {
  await fsp.mkdir(MEMORY_DIR, { recursive: true })
  const file = getMemoryFile(userId)
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, JSON.stringify({ items: data.items.slice(0, 500) }, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

function buildMemoryId(now: number = Date.now()): string {
  return `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function tokenize(text: unknown = ''): string[] {
  const value = String(text || '').toLowerCase()
  const tokens: string[] = []
  const re = /[\u4e00-\u9fff]{2,}|[a-z0-9_+-]{2,}/gi
  let match
  while ((match = re.exec(value))) tokens.push(match[0])
  if (!tokens.length && value.trim()) tokens.push(value.trim())
  return Array.from(new Set(tokens)).slice(0, 32)
}

function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，;；\s]+/)
  return list.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12)
}

async function remember({ userId, channelKey = '', text, tags = [] }: RememberInput = {}): Promise<MemoryItem> {
  const content = String(text || '').trim()
  if (!content) throw new Error('记忆内容不能为空')
  return withUserLock(userId, async () => {
    const data = await readMemoryFile(userId)
    const now = Date.now()
    const item: MemoryItem = {
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
  })
}

function scoreMemory(item: MemoryItem, queryTokens: string[], channelKey: unknown = ''): number {
  const haystack = `${item.text}\n${(item.tags || []).join(' ')}\n${(item.keywords || []).join(' ')}`.toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    if (haystack.includes(token.toLowerCase())) score += token.length >= 4 ? 3 : 1
  }
  if (channelKey && item.channelKey === channelKey) score += 1
  score += Math.max(0, 1 - (Date.now() - (item.createdAt || 0)) / (180 * 24 * 60 * 60 * 1000))
  return score
}

async function searchMemory({ userId, channelKey = '', query = '', limit = 5 }: SearchMemoryInput = {}): Promise<MemoryItem[]> {
  const data = await readMemoryFile(userId)
  const tokens = tokenize(query)
  const max = Math.max(1, Math.min(20, parseInt(String(limit), 10) || 5))
  return data.items
    .map(item => ({ item, score: scoreMemory(item, tokens, String(channelKey || '')) }))
    .filter(entry => tokens.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
    .slice(0, max)
    .map(entry => entry.item)
}

async function forgetMemory({ userId, memoryId }: ForgetMemoryInput = {}): Promise<number> {
  return withUserLock(userId, async () => {
    const data = await readMemoryFile(userId)
    const before = data.items.length
    data.items = data.items.filter(item => item.id !== memoryId)
    await writeMemoryFile(userId, data)
    return before - data.items.length
  })
}

async function listMemory({ userId, limit = 20 }: ListMemoryInput = {}): Promise<MemoryItem[]> {
  const data = await readMemoryFile(userId)
  return data.items.slice(0, Math.max(1, Math.min(100, parseInt(String(limit), 10) || 20)))
}

function formatMemoryItems(items: MemoryItem[] = []): string {
  if (!items.length) return '没有找到相关记忆。'
  return items.map((item, index) => {
    const tags = item.tags && item.tags.length ? ` #${item.tags.join(' #')}` : ''
    return `${index + 1}. ${item.id}${tags}\n${String(item.text || '').slice(0, 300)}`
  }).join('\n')
}

async function searchDashboardMemory({ userId, query = '' }: SearchDashboardMemoryInput = {}): Promise<string> {
  for (const longTermFile of getDashboardMemoryFileCandidates(userId)) {
    try {
    const stat = await fsp.stat(longTermFile)
    if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) continue
    const content = await fsp.readFile(longTermFile, 'utf8')
    if (!content.trim()) continue
    if (!String(query).trim()) return content.trim().slice(0, 2000)
    const tokens = tokenize(query)
    if (!tokens.length) return content.trim().slice(0, 2000)
    const lines = content.split('\n').filter(l => l.trim())
    const matched = lines.filter(line => {
      const lower = line.toLowerCase()
      return tokens.some(t => lower.includes(t.toLowerCase()))
    })
    if (matched.length) return matched.join('\n').slice(0, 2000)
    return content.trim().slice(0, 2000)
    } catch { /* non-critical: missing or unreadable dashboard memory candidate falls through */ }
  }
  return ''
}

function getDashboardMemoryFileCandidates(userId: unknown): string[] {
  const current = safeUserId(String(userId || ''))
  const legacy = legacySafeUserId(String(userId || ''))
  const files = [path.join(DASHBOARD_MEMORY_DIR, current + '.md')]
  if (legacy !== current) files.push(path.join(DASHBOARD_MEMORY_DIR, legacy + '.md'))
  return files
}

export = {
  MEMORY_DIR,
  DASHBOARD_MEMORY_DIR,
  remember,
  searchMemory,
  searchDashboardMemory,
  forgetMemory,
  listMemory,
  formatMemoryItems,
  tokenize,
  safeUserId,
}
