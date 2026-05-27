/**
 * MODULE: 表达学习候选池 v1（学习侧硬过滤）。
 * 职责: 接收一段 today-cache 风格的群消息列表，按硬过滤规则筛掉不该被学习的条目，
 *      返回保留消息和按原因聚合的丢弃统计，作为后续 situation/style 抽象的前置纯函数。
 * 边界: 纯函数；不读写文件、不访问模型、不发送消息、不持有模块级状态、不修改传入数组。
 * 状态: 无。
 */
const { SENSITIVE_KEYWORDS_RE } = require('../../core/constants') as typeof import('../../core/constants')

interface LearningMessage {
  role?: string
  userId?: string
  content?: string
  ts?: number
  messageId?: string
  mentionUserIds?: Array<string | number>
}

interface LearningOptions {
  repeatWindowMs?: number
  repeatMinUsers?: number
  sensitiveTopicWindowMs?: number
  selfUserIds?: string[]
  botUserIds?: string[]
  botName?: string
}

interface IndexedLearningMessage {
  entry: LearningMessage
  index: number
  ts: number
}

interface FilteredLearningMessage {
  userId: string
  content: string
  ts: number | null
  messageId: string
  mentionUserIds: string[]
}

interface FilterExpressionResult {
  kept: FilteredLearningMessage[]
  skipped: Record<string, number>
  total: number
}

const EXPRESSION_LEARNER_VERSION = 1

const DEFAULT_REPEAT_WINDOW_MS = 120000
const DEFAULT_REPEAT_MIN_USERS = 2
const DEFAULT_SENSITIVE_TOPIC_WINDOW_MS = 300000

const IMAGE_OR_EMOJI_RE = /\[(?:图片|表情包|表情|动画表情|商城表情|图像|图)\]|<image[\s>/]|<img[\s>/]|<face[\s>/]|\[CQ:(?:image|face|mface|sface)[,\]]/i
const SELF_USER_TOKENS: Set<string> = new Set(['bot', 'self', 'assistant'])
const SENSITIVE_TOPIC_KEYWORDS: readonly string[] = Object.freeze(['住院', '去世', '过世', '死了', '分手', '离婚', '抑郁', '自杀', '癌症', '重病', '葬礼'])
const MAX_LEARN_CONTENT_CHARS = 400
const MAX_SCAN_CONTENT_CHARS = 2000

const SKIP_REASONS = Object.freeze({
  selfBot: 'selfBot',
  emptyText: 'emptyText',
  hasImageOrEmoji: 'hasImageOrEmoji',
  mentionsBot: 'mentionsBot',
  sensitiveKeyword: 'sensitiveKeyword',
  repeatWindow: 'repeatWindow',
  sensitiveTopicWindow: 'sensitiveTopicWindow',
})

function expressionLearnerString(value: unknown, maxLength: number = MAX_LEARN_CONTENT_CHARS): string {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function expressionLearnerScanText(entry: LearningMessage): string {
  return expressionLearnerString(entry && entry.content, MAX_SCAN_CONTENT_CHARS)
}

function expressionLearnerNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function expressionLearnerTimestamp(entry: LearningMessage): number {
  const ts = expressionLearnerNumber(entry && entry.ts, NaN)
  if (Number.isFinite(ts) && ts > 0) return ts
  return NaN
}

function expressionLearnerBotNamePatterns(botName: string): RegExp[] {
  const cleaned = expressionLearnerString(botName, 40)
  if (!cleaned) return []
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [new RegExp('@\\s*' + escaped, 'i')]
}

function expressionLearnerHasBotMention(content: string, botName: string, botUserIds: string[], mentionUserIds?: Array<string | number>): boolean {
  if (Array.isArray(mentionUserIds) && Array.isArray(botUserIds)) {
    for (const uid of mentionUserIds) {
      if (botUserIds.some((b) => String(b) === String(uid))) return true
    }
  }
  if (!content) return false
  for (const pattern of expressionLearnerBotNamePatterns(botName)) {
    if (pattern.test(content)) return true
  }
  return false
}

function expressionLearnerIsSelfMessage(entry: LearningMessage, selfUserIds: string[]): boolean {
  const role = String(entry && entry.role || '').toLowerCase()
  if (role === 'assistant' || role === 'bot' || role === 'self') return true
  const rawUserId = String(entry && entry.userId || '')
  if (!rawUserId) return false
  if (SELF_USER_TOKENS.has(rawUserId.toLowerCase())) return true
  if (Array.isArray(selfUserIds)) {
    for (const sid of selfUserIds) {
      if (String(sid) === rawUserId) return true
    }
  }
  return false
}

function expressionLearnerSortByTime(messages: LearningMessage[]): IndexedLearningMessage[] {
  const indexed = messages.map((entry, index) => ({ entry, index, ts: expressionLearnerTimestamp(entry) }))
  indexed.sort((a, b) => {
    const at = Number.isFinite(a.ts) ? a.ts : a.index
    const bt = Number.isFinite(b.ts) ? b.ts : b.index
    if (at !== bt) return at - bt
    return a.index - b.index
  })
  return indexed
}

function expressionLearnerBuildRepeatSkipSet(indexed: IndexedLearningMessage[], options: LearningOptions): Set<number> {
  const windowMs = Math.max(1000, expressionLearnerNumber(options && options.repeatWindowMs, DEFAULT_REPEAT_WINDOW_MS))
  const minUsers = Math.max(2, Math.floor(expressionLearnerNumber(options && options.repeatMinUsers, DEFAULT_REPEAT_MIN_USERS)))
  const skipIndexes: Set<number> = new Set()
  for (let i = 0; i < indexed.length; i += 1) {
    const baseEntry = indexed[i].entry
    const baseText = expressionLearnerScanText(baseEntry)
    if (!baseText) continue
    const baseTs = Number.isFinite(indexed[i].ts) ? indexed[i].ts : null
    const window = [indexed[i]]
    const speakers: Set<string> = new Set([String(baseEntry.userId || '')])
    for (let j = i + 1; j < indexed.length; j += 1) {
      const nextEntry = indexed[j].entry
      const nextText = expressionLearnerScanText(nextEntry)
      if (nextText !== baseText) continue
      if (baseTs != null && Number.isFinite(indexed[j].ts) && (indexed[j].ts - baseTs) > windowMs) break
      if (baseTs == null && (j - i) > 50) break
      window.push(indexed[j])
      speakers.add(String(nextEntry.userId || ''))
    }
    if (window.length >= minUsers && speakers.size >= minUsers) {
      for (const item of window) skipIndexes.add(item.index)
    }
  }
  return skipIndexes
}

function expressionLearnerBuildSensitiveTopicSkipSet(indexed: IndexedLearningMessage[], options: LearningOptions): Set<number> {
  const windowMs = Math.max(60000, expressionLearnerNumber(options && options.sensitiveTopicWindowMs, DEFAULT_SENSITIVE_TOPIC_WINDOW_MS))
  const triggers: Array<{ index: number; ts: number | null }> = []
  for (const item of indexed) {
    const text = expressionLearnerScanText(item.entry)
    if (!text) continue
    if (SENSITIVE_TOPIC_KEYWORDS.some((kw) => text.includes(kw))) {
      const ts = Number.isFinite(item.ts) ? item.ts : null
      triggers.push({ index: item.index, ts })
    }
  }
  if (!triggers.length) return new Set()
  const skipIndexes: Set<number> = new Set()
  for (const item of indexed) {
    for (const trigger of triggers) {
      if (trigger.ts != null && Number.isFinite(item.ts)) {
        if (Math.abs(item.ts - trigger.ts) <= windowMs) { skipIndexes.add(item.index); break }
      } else if (Math.abs(item.index - trigger.index) <= 10) {
        skipIndexes.add(item.index); break
      }
    }
  }
  return skipIndexes
}

function expressionLearnerEmptySkipped(): Record<string, number> {
  const skipped: Record<string, number> = {}
  for (const reason of Object.values(SKIP_REASONS)) skipped[reason] = 0
  return skipped
}

function filterExpressionLearningMessages(messages: LearningMessage[] = [], options: LearningOptions = {}): FilterExpressionResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { kept: [], skipped: expressionLearnerEmptySkipped(), total: 0 }
  }
  const indexed = expressionLearnerSortByTime(messages)
  const repeatSkip = expressionLearnerBuildRepeatSkipSet(indexed, options)
  const sensitiveTopicSkip = expressionLearnerBuildSensitiveTopicSkipSet(indexed, options)
  const selfUserIds = Array.isArray(options.selfUserIds) ? options.selfUserIds.map(String) : []
  const botUserIds = Array.isArray(options.botUserIds) ? options.botUserIds.map(String) : selfUserIds
  const botName = expressionLearnerString(options.botName, 40)
  const skipped = expressionLearnerEmptySkipped()
  const kept: FilteredLearningMessage[] = []
  for (const item of indexed) {
    const entry = item.entry
    if (!entry || typeof entry !== 'object') continue
    if (expressionLearnerIsSelfMessage(entry, selfUserIds)) { skipped[SKIP_REASONS.selfBot] += 1; continue }
    const rawContent = String(entry.content == null ? '' : entry.content)
    if (IMAGE_OR_EMOJI_RE.test(rawContent)) { skipped[SKIP_REASONS.hasImageOrEmoji] += 1; continue }
    const scanContent = expressionLearnerString(rawContent, MAX_SCAN_CONTENT_CHARS)
    if (!scanContent) { skipped[SKIP_REASONS.emptyText] += 1; continue }
    if (expressionLearnerHasBotMention(scanContent, botName, botUserIds, entry.mentionUserIds)) {
      skipped[SKIP_REASONS.mentionsBot] += 1; continue
    }
    if (SENSITIVE_KEYWORDS_RE.test(scanContent)) { skipped[SKIP_REASONS.sensitiveKeyword] += 1; continue }
    if (repeatSkip.has(item.index)) { skipped[SKIP_REASONS.repeatWindow] += 1; continue }
    if (sensitiveTopicSkip.has(item.index)) { skipped[SKIP_REASONS.sensitiveTopicWindow] += 1; continue }
    kept.push({
      userId: String(entry.userId || ''),
      content: scanContent.slice(0, MAX_LEARN_CONTENT_CHARS),
      ts: Number.isFinite(item.ts) ? item.ts : null,
      messageId: String(entry.messageId || ''),
      mentionUserIds: Array.isArray(entry.mentionUserIds) ? entry.mentionUserIds.map(String).filter(Boolean) : [],
    })
  }
  return { kept, skipped, total: messages.length }
}

export = {
  EXPRESSION_LEARNER_VERSION,
  EXPRESSION_LEARNER_SKIP_REASONS: SKIP_REASONS,
  EXPRESSION_LEARNER_REPEAT_WINDOW_MS: DEFAULT_REPEAT_WINDOW_MS,
  EXPRESSION_LEARNER_REPEAT_MIN_USERS: DEFAULT_REPEAT_MIN_USERS,
  EXPRESSION_LEARNER_SENSITIVE_TOPIC_WINDOW_MS: DEFAULT_SENSITIVE_TOPIC_WINDOW_MS,
  EXPRESSION_LEARNER_SENSITIVE_TOPIC_KEYWORDS: SENSITIVE_TOPIC_KEYWORDS,
  filterExpressionLearningMessages,
}
