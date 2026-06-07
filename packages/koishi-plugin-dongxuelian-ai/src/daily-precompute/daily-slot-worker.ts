/**
 * MODULE: S3 分片 worker。
 * 职责: 生成非 AI 分片统计并写 slot 文件。
 * 边界: 不调用 AI；AI 摘要留给后续受控 worker 扩展。
 */
const path = require('path') as typeof import('path')
const { SLOTS_ROOT } = require('./precompute-status') as typeof import('./precompute-status')
const { readPrecomputeIndex, updatePrecomputeCoverage, writePrecomputeEvent } = require('./precompute-index') as typeof import('./precompute-index')
const { sanitizeId, writeJsonAtomic } = require('../resource-common/files') as typeof import('../resource-common/files')

interface PrecomputeRecordLike extends Record<string, unknown> {
  messageId?: string
  userId?: string
  text?: string
  media?: unknown
}

interface DailySlotTaskLike {
  id?: string
  channelKey?: string
  payload?: {
    date?: unknown
    channelKey?: unknown
    slotId?: unknown
    messageIds?: unknown
  }
}

// 粗略提取关键词，避免引入分词和 AI。
function extractSimpleKeywords(records: PrecomputeRecordLike[], limit = 12): string[] {
  const counts: Record<string, number> = {}
  const stop = new Set(['今天', '这个', '那个', '一下', '什么', '不是', '还是', '可以', '没有', '哈哈', '怎么'])
  for (const record of records) {
    const words = String(record.text || '').match(/[\u4e00-\u9fa5]{2,8}|[a-zA-Z0-9_.-]{3,24}/g) || []
    for (const word of words) {
      if (stop.has(word)) continue
      counts[word] = (counts[word] || 0) + 1
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word)
}

// 统计分片基础数据。
function buildSlotStats(records: PrecomputeRecordLike[]): Record<string, unknown> {
  const activeUsers = new Set(records.map(item => String(item.userId || '')).filter(Boolean)).size
  const mediaCount = records.reduce((sum, item) => sum + (Array.isArray(item.media) ? item.media.length : 0), 0)
  return {
    activeUsers,
    mediaCount,
    charCount: records.reduce((sum, item) => sum + String(item.text || '').length, 0),
  }
}

// 执行一个 slot 统计任务并写入 slots 目录。
function runDailySlotTask(task: DailySlotTaskLike): Record<string, unknown> {
  const payload = task?.payload || {}
  const date = String(payload.date || '')
  const channelKey = String(payload.channelKey || task?.channelKey || '')
  const slotId = String(payload.slotId || task?.id || '')
  const messageIds = new Set(Array.isArray(payload.messageIds) ? payload.messageIds.map(String) : [])
  if (!date || !channelKey || !slotId) throw new Error('daily slot task missing date/channelKey/slotId')
  const records = readPrecomputeIndex(date, channelKey).filter(item => !messageIds.size || messageIds.has(String(item.messageId || '')))
  const slot = {
    slotId,
    date,
    channelKey,
    messageCount: records.length,
    coveredMessageIds: records.map(item => String(item.messageId || '')).filter(Boolean),
    keywords: extractSimpleKeywords(records),
    topics: [],
    stats: buildSlotStats(records),
    generatedBy: 'daily-slot-worker:non-ai',
    updatedAt: new Date().toISOString(),
  }
  const file = path.join(SLOTS_ROOT, sanitizeId(date), sanitizeId(channelKey), `${sanitizeId(slotId)}.json`)
  writeJsonAtomic(file, slot)
  const coverage = updatePrecomputeCoverage(date, channelKey)
  writePrecomputeEvent('daily_slot_written', { date, channelKey, slotId, messageCount: records.length })
  return { slotFile: file, coverage }
}

export = {
  runDailySlotTask,
  extractSimpleKeywords,
}
