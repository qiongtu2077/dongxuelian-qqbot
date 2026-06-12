/**
 * MODULE: S3 日报预计算轻量索引。
 * 职责: 将群消息写入 daily-precompute/index，并维护最小 coverage。
 * 边界: 不调用 AI，不执行分片摘要。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { todayCst } = require('../core/utils') as typeof import('../core/utils')
const { appendJsonlEvent, ensureDir, readJsonFile, sanitizeId, writeJsonAtomic } = require('../resource-common/files') as typeof import('../resource-common/files')

const PRECOMPUTE_ROOT = path.join(DATA_DIR, 'daily-precompute')
const INDEX_ROOT = path.join(PRECOMPUTE_ROOT, 'index')
const COVERAGE_ROOT = path.join(PRECOMPUTE_ROOT, 'coverage')

interface PrecomputeIndexInput {
  date?: string
  channelKey: string
  messageId?: string
  timestamp?: number
  userId?: string
  userName?: string
  text?: string
  media?: Array<Record<string, unknown>>
}

interface PrecomputeRecord extends Record<string, unknown> {
  messageId: string
  timestamp: number
  userId: string
  userName: string
  text: string
  media: Array<Record<string, unknown>>
}

interface DailySlotLike extends Record<string, unknown> {
  slotId?: unknown
  failed?: unknown
  coveredMessageIds?: unknown
}

interface CoverageSnapshotLike extends Record<string, unknown> {
  date?: unknown
  channelKey?: unknown
  totalMessages?: unknown
  coveredMessages?: unknown
  coverageRate?: unknown
  failedSlots?: unknown
  updatedAt?: unknown
  slotStamp?: unknown
}

function parsePrecomputeRecord(line: string): PrecomputeRecord | null {
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return {
      ...record,
      messageId: String(record.messageId || ''),
      timestamp: Number(record.timestamp || 0),
      userId: String(record.userId || ''),
      userName: String(record.userName || ''),
      text: String(record.text || ''),
      media: Array.isArray(record.media) ? record.media.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>> : [],
    }
  } catch {
    return null
  }
}

// 返回预计算事件日志文件路径。
function precomputeEventFile(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(PRECOMPUTE_ROOT, `events-${stamp}.jsonl`)
}

// 写入 S3 事件。
function writePrecomputeEvent(event: string, data: Record<string, unknown> = {}): void {
  ensureDir(PRECOMPUTE_ROOT)
  appendJsonlEvent(precomputeEventFile(), { event, ...data })
}

// 返回频道索引文件路径。
function getPrecomputeIndexFile(date: string, channelKey: string): string {
  return path.join(INDEX_ROOT, sanitizeId(date), `${sanitizeId(channelKey)}.jsonl`)
}

// 返回频道覆盖率文件路径。
function getPrecomputeCoverageFile(date: string, channelKey: string): string {
  return path.join(COVERAGE_ROOT, sanitizeId(date), `${sanitizeId(channelKey)}.json`)
}

// 读取当前 coverage 快照；缺失或损坏时返回 null。
function readPrecomputeCoverage(date: string, channelKey: string): CoverageSnapshotLike | null {
  return readJsonFile<CoverageSnapshotLike>(getPrecomputeCoverageFile(date, channelKey), null)
}

// 生成当前 slot 面的轻量目录戳；slot 未变化时可复用现有 covered 口径。
function getPrecomputeSlotStamp(date: string, channelKey: string): string {
  const slotsDir = path.join(PRECOMPUTE_ROOT, 'slots', sanitizeId(date), sanitizeId(channelKey))
  try {
    const stat = fs.statSync(slotsDir)
    return `${slotsDir}:${Number(stat.mtimeMs || 0)}`
  } catch {
    return `${slotsDir}:missing`
  }
}

// 当 slot 面未变化时，直接在旧 coverage 上增量更新 totalMessages，避免每条消息全量重算。
function tryUpdatePrecomputeCoverageIncrementally(date: string, channelKey: string): Record<string, unknown> | null {
  const current = readPrecomputeCoverage(date, channelKey)
  if (!current) return null
  const slotStamp = getPrecomputeSlotStamp(date, channelKey)
  if (String(current.slotStamp || '') !== slotStamp) return null
  const totalMessages = Math.max(0, Number(current.totalMessages || 0) + 1)
  const coveredMessages = Math.max(0, Math.min(totalMessages, Number(current.coveredMessages || 0)))
  const next = {
    ...current,
    date,
    channelKey,
    totalMessages,
    coveredMessages,
    coverageRate: totalMessages > 0 ? Number((coveredMessages / totalMessages).toFixed(3)) : 0,
    updatedAt: new Date().toISOString(),
    slotStamp,
  }
  writeJsonAtomic(getPrecomputeCoverageFile(date, channelKey), next)
  return next
}

// 将一条消息写入轻量索引。
function appendPrecomputeIndex(input: PrecomputeIndexInput): PrecomputeRecord | null {
  const channelKey = String(input.channelKey || '')
  const text = String(input.text || '').slice(0, 1200)
  const media = Array.isArray(input.media) ? input.media.slice(0, 8) : []
  if (!channelKey || (!text && !media.length)) return null
  const timestamp = Number(input.timestamp || Date.now())
  const date = String(input.date || todayCst(new Date(timestamp)))
  const record = {
    messageId: String(input.messageId || `msg-${timestamp}`),
    timestamp,
    userId: String(input.userId || ''),
    userName: String(input.userName || ''),
    text,
    media,
  }
  appendJsonlEvent(getPrecomputeIndexFile(date, channelKey), record)
  tryUpdatePrecomputeCoverageIncrementally(date, channelKey) || updatePrecomputeCoverage(date, channelKey)
  writePrecomputeEvent('precompute_index_appended', { date, channelKey, messageId: record.messageId, hasMedia: media.length > 0 })
  return record
}

// 读取频道索引记录。
function readPrecomputeIndex(date: string, channelKey: string, limit = 20000): PrecomputeRecord[] {
  const file = getPrecomputeIndexFile(date, channelKey)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(50000, Number(limit || 20000))))
  return lines.map(parsePrecomputeRecord).filter((item): item is PrecomputeRecord => Boolean(item))
}

// 从 slots 反推已覆盖消息数；避免 coverage 与 slot 文件失配。
function countCoveredMessagesFromSlots(date: string, channelKey: string): { covered: number; failedSlots: string[] } {
  const { listJsonFiles, readJsonFile } = require('../resource-common/files') as typeof import('../resource-common/files')
  const slotsDir = path.join(PRECOMPUTE_ROOT, 'slots', sanitizeId(date), sanitizeId(channelKey))
  const ids = new Set<string>()
  const failedSlots: string[] = []
  for (const file of listJsonFiles(slotsDir, { maxFiles: 20000 })) {
    const slot = readJsonFile<DailySlotLike>(file, null)
    if (!slot) continue
    if (slot.failed) failedSlots.push(String(slot.slotId || path.basename(file)))
    const covered = Array.isArray(slot.coveredMessageIds) ? slot.coveredMessageIds : []
    for (const id of covered) ids.add(String(id))
  }
  return { covered: ids.size, failedSlots }
}

// 更新 coverage 文件。
function updatePrecomputeCoverage(date: string, channelKey: string): Record<string, unknown> {
  const index = readPrecomputeIndex(date, channelKey)
  const covered = countCoveredMessagesFromSlots(date, channelKey)
  const totalMessages = index.length
  const slotStamp = getPrecomputeSlotStamp(date, channelKey)
  const coverage = {
    date,
    channelKey,
    totalMessages,
    coveredMessages: Math.min(totalMessages, covered.covered),
    coverageRate: totalMessages > 0 ? Number((Math.min(totalMessages, covered.covered) / totalMessages).toFixed(3)) : 0,
    failedSlots: covered.failedSlots,
    updatedAt: new Date().toISOString(),
    slotStamp,
  }
  writeJsonAtomic(getPrecomputeCoverageFile(date, channelKey), coverage)
  return coverage
}

export = {
  PRECOMPUTE_ROOT,
  INDEX_ROOT,
  COVERAGE_ROOT,
  precomputeEventFile,
  writePrecomputeEvent,
  getPrecomputeIndexFile,
  getPrecomputeCoverageFile,
  appendPrecomputeIndex,
  readPrecomputeIndex,
  updatePrecomputeCoverage,
}
