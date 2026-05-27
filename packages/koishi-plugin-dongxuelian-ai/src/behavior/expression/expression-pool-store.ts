/**
 * MODULE: 表达学习候选池 v2.1（落盘层）。
 * 职责: 提供 channel 隔离的候选池读写——load / append / merge / archive。
 *      存原始候选条目（situation + style + contributors + count + lastUsedAt 等）。
 * 边界: 纯存储；不调模型、不读 today-cache、不发送消息、不被 chat 主链路 require。
 *      不持有长寿命缓存；写入用 atomic rename，超大文件直接清掉。
 * 状态: 模块级仅 writeQueues（按 channelKey 串行化写），无对外可变状态。
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { EXPRESSION_POOL_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { writeJsonFile, safeChannelKey, truncateText } = require('../../core/utils') as typeof import('../../core/utils')

type ExpressionPoolStatus = 'candidate' | 'reviewed' | 'archived'
type AppendMode = 'created' | 'merged' | 'rejected'

interface ExpressionEntry {
  id: string
  channelKey: string
  situation: string
  style: string
  count: number
  contributors: string[]
  status: ExpressionPoolStatus
  createdAt: number
  lastUsedAt: number
  lastMergedAt: number
}

interface ExpressionPool {
  entries: ExpressionEntry[]
  updatedAt: number
  channelKey: string
}

interface ExpressionCandidate {
  situation?: string
  style?: string
  contributors?: string[]
}

interface AppendOptions {
  now?: number
  similarityThreshold?: number
}

interface AppendResult {
  mode: AppendMode
  reason?: string
  entry: ExpressionEntry | null
  score?: number
}

const EXPRESSION_POOL_STORE_VERSION = 1
const EXPRESSION_POOL_SIMILARITY_MERGE_THRESHOLD = 0.75
const EXPRESSION_POOL_MAX_ENTRIES_PER_CHANNEL = 500
const EXPRESSION_POOL_MIN_USE_COUNT = 2
const EXPRESSION_POOL_MAX_FILE_BYTES = 1024 * 1024
const EXPRESSION_POOL_MAX_CONTRIBUTORS = 50
const EXPRESSION_POOL_MAX_TEXT_LEN = 20

const POOL_STATUS: Readonly<Record<ExpressionPoolStatus, ExpressionPoolStatus>> = Object.freeze({
  candidate: 'candidate',
  reviewed: 'reviewed',
  archived: 'archived',
})

const APPEND_MODES: Readonly<Record<AppendMode, AppendMode>> = Object.freeze({
  created: 'created',
  merged: 'merged',
  rejected: 'rejected',
})

const writeQueues: Map<string, Promise<unknown>> = new Map()

const expressionPoolSafeChannelKey = safeChannelKey

function expressionPoolFilePath(channelKey: string): string {
  return path.join(EXPRESSION_POOL_DIR, expressionPoolSafeChannelKey(channelKey) + '.json')
}

function expressionPoolNormalizeText(value: unknown, maxLen: number = EXPRESSION_POOL_MAX_TEXT_LEN): string {
  const normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return truncateText(normalized, maxLen)
}

function expressionPoolNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function expressionPoolHashId(channelKey: string, situation: string, style: string): string {
  const text = `${expressionPoolSafeChannelKey(channelKey)}::${situation}::${style}`
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function expressionPoolReadFileSafe(file: string): unknown {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    if (stat.size > EXPRESSION_POOL_MAX_FILE_BYTES) {
      try { fs.unlinkSync(file) } catch { /* non-critical: oversized expression pool cleanup best effort */ }
      return null
    }
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw) return null
    return JSON.parse(raw)
  } catch { /* non-critical: missing or invalid expression pool starts empty */
    return null
  }
}

function expressionPoolNormalizeEntry(raw: Record<string, unknown> | null | undefined, channelKey: string): ExpressionEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const situation = expressionPoolNormalizeText(raw.situation)
  const style = expressionPoolNormalizeText(raw.style)
  if (!situation || !style) return null
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  const id = String(raw.id || '').trim() || expressionPoolHashId(safeChannelKey, situation, style)
  const statusKey = String(raw.status || '').toLowerCase() as ExpressionPoolStatus
  const status = POOL_STATUS[statusKey] || POOL_STATUS.candidate
  const contributorsSource = Array.isArray(raw.contributors) ? raw.contributors : []
  const contributors = []
  const seen = new Set()
  for (const c of contributorsSource) {
    const id = String(c || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    contributors.push(id)
    if (contributors.length >= EXPRESSION_POOL_MAX_CONTRIBUTORS) break
  }
  return {
    id,
    channelKey: safeChannelKey,
    situation,
    style,
    count: Math.max(0, Math.floor(expressionPoolNumber(raw.count, 1))),
    contributors,
    status,
    createdAt: Math.max(0, Math.floor(expressionPoolNumber(raw.createdAt, 0))),
    lastUsedAt: Math.max(0, Math.floor(expressionPoolNumber(raw.lastUsedAt, 0))),
    lastMergedAt: Math.max(0, Math.floor(expressionPoolNumber(raw.lastMergedAt, 0))),
  }
}

function expressionPoolNormalizeFileShape(raw: unknown, channelKey: string): ExpressionPool {
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  if (!raw || typeof raw !== 'object') return { entries: [], updatedAt: 0, channelKey: safeChannelKey }
  const rawRecord = raw as { entries?: unknown[]; updatedAt?: unknown }
  const entriesSource = Array.isArray(rawRecord.entries) ? rawRecord.entries : []
  const entries: ExpressionEntry[] = []
  const seenIds: Set<string> = new Set()
  for (const item of entriesSource) {
    const normalized = expressionPoolNormalizeEntry(item as Record<string, unknown>, channelKey)
    if (!normalized) continue
    if (seenIds.has(normalized.id)) continue
    seenIds.add(normalized.id)
    entries.push(normalized)
  }
  return {
    entries,
    updatedAt: Math.max(0, Math.floor(expressionPoolNumber(rawRecord.updatedAt, 0))),
    channelKey: safeChannelKey,
  }
}

function loadExpressionPool(channelKey: string): ExpressionPool {
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  const file = expressionPoolFilePath(safeChannelKey)
  const raw = expressionPoolReadFileSafe(file)
  return expressionPoolNormalizeFileShape(raw, safeChannelKey)
}

function expressionPoolCharSet(value: string): Set<string> {
  const set: Set<string> = new Set()
  for (const ch of String(value || '')) set.add(ch)
  return set
}

function expressionPoolJaccard(a: string, b: string): number {
  const sa = expressionPoolCharSet(a)
  const sb = expressionPoolCharSet(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let overlap = 0
  for (const ch of sa) { if (sb.has(ch)) overlap += 1 }
  const union: Set<string> = new Set()
  for (const ch of sa) union.add(ch)
  for (const ch of sb) union.add(ch)
  return union.size === 0 ? 0 : overlap / union.size
}

function computeSituationStyleSimilarity(left: Partial<ExpressionEntry> = {}, right: Partial<ExpressionEntry> = {}): number {
  if (!left || !right) return 0
  const sit = expressionPoolJaccard(expressionPoolNormalizeText(left.situation), expressionPoolNormalizeText(right.situation))
  const sty = expressionPoolJaccard(expressionPoolNormalizeText(left.style), expressionPoolNormalizeText(right.style))
  return sit * 0.6 + sty * 0.4
}

function expressionPoolEnqueueWrite<T>(channelKey: string, fn: () => T | Promise<T>): Promise<T> {
  const key = expressionPoolSafeChannelKey(channelKey)
  const prev = writeQueues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  writeQueues.set(key, next)
  next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key) })
  return next
}

async function expressionPoolPersist(channelKey: string, pool: ExpressionPool): Promise<void> {
  const file = expressionPoolFilePath(channelKey)
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* non-critical: writeJsonFile will surface mkdir/write failures */ }
  await writeJsonFile(file, { entries: pool.entries, updatedAt: pool.updatedAt, channelKey: pool.channelKey, version: EXPRESSION_POOL_STORE_VERSION })
}

function expressionPoolMergeContributors(target: string[], incoming: string[]): void {
  const seen: Set<string> = new Set(target)
  for (const id of incoming) {
    const value = String(id || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    target.push(value)
    if (target.length >= EXPRESSION_POOL_MAX_CONTRIBUTORS) break
  }
}

function expressionPoolEvictWeakest(entries: ExpressionEntry[]): void {
  if (entries.length <= EXPRESSION_POOL_MAX_ENTRIES_PER_CHANNEL) return
  const indexed = entries.map((entry, index) => ({ entry, index }))
  indexed.sort((a, b) => {
    if (a.entry.status === POOL_STATUS.archived && b.entry.status !== POOL_STATUS.archived) return -1
    if (b.entry.status === POOL_STATUS.archived && a.entry.status !== POOL_STATUS.archived) return 1
    if (a.entry.count !== b.entry.count) return a.entry.count - b.entry.count
    return (a.entry.lastMergedAt || a.entry.createdAt || 0) - (b.entry.lastMergedAt || b.entry.createdAt || 0)
  })
  while (entries.length > EXPRESSION_POOL_MAX_ENTRIES_PER_CHANNEL && indexed.length) {
    const victim = indexed.shift()
    const idx = entries.indexOf(victim.entry)
    if (idx >= 0) entries.splice(idx, 1)
  }
}

function appendExpressionCandidate(channelKey: string, candidate: ExpressionCandidate, options: AppendOptions = {}): Promise<AppendResult> {
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  const situation = expressionPoolNormalizeText(candidate && candidate.situation)
  const style = expressionPoolNormalizeText(candidate && candidate.style)
  if (!situation || !style) {
    return Promise.resolve({ mode: APPEND_MODES.rejected, reason: 'empty', entry: null })
  }
  const contributorsInput = Array.isArray(candidate && candidate.contributors) ? candidate.contributors : []
  const now = expressionPoolNumber(options.now, Date.now())
  const threshold = expressionPoolNumber(options.similarityThreshold, EXPRESSION_POOL_SIMILARITY_MERGE_THRESHOLD)
  return expressionPoolEnqueueWrite(safeChannelKey, async () => {
    const pool = loadExpressionPool(safeChannelKey)
    const entries = pool.entries
    const probe = { situation, style }
    let bestIndex = -1
    let bestScore = 0
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry.status === POOL_STATUS.archived) continue
      const score = computeSituationStyleSimilarity(probe, entry)
      if (score >= threshold && score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    let mode
    let resultEntry
    if (bestIndex >= 0) {
      const target = entries[bestIndex]
      target.count = Math.max(0, target.count) + 1
      expressionPoolMergeContributors(target.contributors, contributorsInput)
      target.lastMergedAt = now
      mode = APPEND_MODES.merged
      resultEntry = target
    } else {
      const created = expressionPoolNormalizeEntry({
        situation,
        style,
        count: 1,
        contributors: contributorsInput,
        status: POOL_STATUS.candidate,
        createdAt: now,
        lastMergedAt: now,
      }, safeChannelKey)
      if (!created) return { mode: APPEND_MODES.rejected, reason: 'normalize_failed', entry: null }
      entries.push(created)
      mode = APPEND_MODES.created
      resultEntry = created
    }
    expressionPoolEvictWeakest(entries)
    pool.updatedAt = now
    await expressionPoolPersist(safeChannelKey, pool)
    return { mode, entry: resultEntry, score: bestScore }
  })
}

function archiveByContributor(channelKey: string, userId: string): Promise<{ archived: number }> {
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  const target = String(userId || '').trim()
  if (!target) return Promise.resolve({ archived: 0 })
  return expressionPoolEnqueueWrite(safeChannelKey, async () => {
    const pool = loadExpressionPool(safeChannelKey)
    let archived = 0
    for (const entry of pool.entries) {
      if (entry.status === POOL_STATUS.archived) continue
      if (!entry.contributors.includes(target)) continue
      entry.status = POOL_STATUS.archived
      entry.contributors = entry.contributors.filter((id) => id !== target)
      archived += 1
    }
    if (archived > 0) {
      pool.updatedAt = Date.now()
      await expressionPoolPersist(safeChannelKey, pool)
    }
    return { archived }
  })
}

export = {
  EXPRESSION_POOL_STORE_VERSION,
  EXPRESSION_POOL_SIMILARITY_MERGE_THRESHOLD,
  EXPRESSION_POOL_MAX_ENTRIES_PER_CHANNEL,
  EXPRESSION_POOL_MIN_USE_COUNT,
  EXPRESSION_POOL_MAX_FILE_BYTES,
  EXPRESSION_POOL_MAX_CONTRIBUTORS,
  EXPRESSION_POOL_MAX_TEXT_LEN,
  EXPRESSION_POOL_STATUS: POOL_STATUS,
  EXPRESSION_POOL_APPEND_MODES: APPEND_MODES,
  loadExpressionPool,
  appendExpressionCandidate,
  archiveByContributor,
  computeSituationStyleSimilarity,
  expressionPoolSafeChannelKey,
  expressionPoolFilePath,
}
