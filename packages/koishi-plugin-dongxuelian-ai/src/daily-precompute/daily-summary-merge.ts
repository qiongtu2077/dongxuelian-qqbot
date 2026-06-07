/**
 * MODULE: S3 分片合并。
 * 职责: 合并 slot 和未覆盖 index，生成日报 final-input。
 * 边界: 不渲染日报，不调用 AI。
 */
const path = require('path') as typeof import('path')
const { FINAL_INPUT_ROOT, SLOTS_ROOT } = require('./precompute-status') as typeof import('./precompute-status')
const { readPrecomputeIndex, writePrecomputeEvent } = require('./precompute-index') as typeof import('./precompute-index')
const { listJsonFiles, readJsonFile, sanitizeId, writeJsonAtomic } = require('../resource-common/files') as typeof import('../resource-common/files')

interface PrecomputeRecordLike extends Record<string, unknown> {
  messageId?: string
}

interface DailySlotLike extends Record<string, unknown> {
  slotId?: unknown
  messageCount?: unknown
  coveredMessageIds?: unknown
  keywords?: unknown
  stats?: unknown
}

// 读取指定频道的全部 slot。
function readDailySlots(date: string, channelKey: string): DailySlotLike[] {
  const dir = path.join(SLOTS_ROOT, sanitizeId(date), sanitizeId(channelKey))
  return listJsonFiles(dir, { maxFiles: 20000 }).map(file => readJsonFile<DailySlotLike>(file, null)).filter((slot): slot is DailySlotLike => Boolean(slot))
}

// 合并分片产物和尾部未覆盖消息，写 final-input。
function mergeDailyFinalInput(date: string, channelKey: string): Record<string, unknown> {
  const slots = readDailySlots(date, channelKey)
  const index = readPrecomputeIndex(date, channelKey) as PrecomputeRecordLike[]
  const coveredIds = new Set<string>()
  for (const slot of slots) {
    for (const id of Array.isArray(slot.coveredMessageIds) ? slot.coveredMessageIds : []) coveredIds.add(String(id))
  }
  const uncoveredTail = index.filter(item => !coveredIds.has(String(item.messageId || ''))).slice(-200)
  const keywords: Record<string, number> = {}
  for (const slot of slots) {
    for (const keyword of Array.isArray(slot.keywords) ? slot.keywords : []) keywords[String(keyword)] = (keywords[String(keyword)] || 0) + 1
  }
  const finalInput = {
    date,
    channelKey,
    slotCount: slots.length,
    totalMessages: index.length,
    coveredMessages: coveredIds.size,
    coverageRate: index.length ? Number((Math.min(index.length, coveredIds.size) / index.length).toFixed(3)) : 0,
    keywords: Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([keyword]) => keyword),
    slots: slots.map(slot => ({
      slotId: slot.slotId,
      messageCount: slot.messageCount,
      keywords: slot.keywords || [],
      stats: slot.stats || {},
    })),
    uncoveredTail,
    updatedAt: new Date().toISOString(),
  }
  const file = path.join(FINAL_INPUT_ROOT, sanitizeId(date), `${sanitizeId(channelKey)}.json`)
  writeJsonAtomic(file, finalInput)
  writePrecomputeEvent('daily_final_input_written', { date, channelKey, slotCount: slots.length, totalMessages: index.length })
  return finalInput
}

export = {
  readDailySlots,
  mergeDailyFinalInput,
}
