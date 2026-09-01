/**
 * MODULE: 今日情绪命令。
 * 边界: 只处理群聊情绪报告命令、情绪历史读写与图片渲染回退；不改聊天主流程，不写 conversation。
 * 状态: 复用 index.js 注入的 channelTodayCache / lastEmotionCache，不自建跨模块全局状态。
 */

const path = require('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client') as typeof import('../resource-workers/task-client')
const { findResourceTaskByKindAndChannel } = require('../resource-workers/task-store') as typeof import('../resource-workers/task-store')
const {
  readJsonFile,
  writeJsonFile,
  todayCst,
  todayCstMinusDays,
  safeChannelKey,
  truncateText,
} = require('../core/utils') as typeof import('../core/utils')
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')
const { handled, notHandled } = require('./command-result') as typeof import('./command-result')

const EMOTION_IMAGE_TEXT_LIMIT = 1500
const EMOTION_ANALYSIS_MAX_MESSAGES = 1200
const EMOTION_COMPRESS_BATCH_SIZE = 100
const EMOTION_MAX_SUMMARY_CHARS = 10000
const EMOTION_RENDER_TIMEOUT_MS = 180000
const EMOTION_RENDER_EXPIRY_GRACE_MS = Math.max(
  60 * 1000,
  Math.min(10 * 60 * 1000, Number(process.env.EMOTION_RENDER_EXPIRY_GRACE_MS || 2 * 60 * 1000)),
)

interface LoggerLike {
  warn: (message: string) => void
  info?: (message: string) => void
}

interface EmotionContextLike {
  logger: (name: string) => LoggerLike
}

interface EmotionSessionLike {
  send: (content: unknown) => unknown | Promise<unknown>
}

interface ModelMessage {
  role: string
  content: string
}

type CallOpenAI = (messages: ModelMessage[], stream?: boolean, options?: Record<string, unknown>) => Promise<unknown>

interface EmotionMessage {
  time?: unknown
  user?: unknown
  content?: unknown
  userId?: unknown
}

interface EmotionTodayCache {
  date: string
  messages: EmotionMessage[]
}

interface EmotionStats {
  messageCount: number
  userCount: number
}

interface EmotionAnalysis {
  score: number
  confidence: number
  mood: string
  summary: string
  reasons: string[]
  keywords: string[]
}

interface EmotionHistoryItem {
  date: string
  score: number
  mood: string
  summary: string
}

interface EmotionCacheItem {
  response?: unknown
  text?: string
  ts: number
}

interface EmotionTaskLike {
  id?: unknown
  payload?: Record<string, unknown>
}

interface EmotionSummary {
  sample: EmotionMessage[]
  text: string
}

interface EmotionCommandState {
  plain: string
  inGuild: boolean
  channelKey: string
  loadConfig: (force?: boolean) => unknown | Promise<unknown>
  callOpenAI: CallOpenAI
  channelTodayCache: Map<string, EmotionTodayCache>
  lastEmotionCache: Map<string, EmotionCacheItem>
}

function isEmotionRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function getEmotionCommandErrorMessage(error: unknown, fallback: string = ''): string {
  return error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message || fallback)
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = parseInt(String(value), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function cleanEmotionText(value: unknown = '', max: number = 120): string {
  const text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateText(text, max)
}

function limitPlainText(value: unknown = '', max: number = 500): string {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= max) return text
  return truncateText(text, Math.max(0, max - 3)).trim() + '...'
}

function truncateEmotionText(value: unknown = '', max: number = 120): string {
  const text = cleanEmotionText(value, max + 20)
  if (text.length <= max) return text
  return truncateText(text, Math.max(0, max - 3)).trim() + '...'
}

function normalizeEmotionMood(score: number, mood: unknown = ''): string {
  const value = String(mood || '')
  if (/悲|低|消沉|焦虑|负/.test(value)) return '偏悲观'
  if (/乐|活跃|积极|高涨|正/.test(value)) return '偏乐观'
  if (/中|平/.test(value)) return '中性'
  if (score >= 65) return '偏乐观'
  if (score <= 40) return '偏悲观'
  return '中性'
}

function parseJsonObject(text: unknown = ''): Record<string, unknown> | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    /* non-critical: model output may wrap JSON with prose, fallback regex handles it */
  }
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    /* non-critical: invalid model JSON falls back to text heuristics */
    return null
  }
}

function normalizeEmotionReasons(value: unknown, fallbackSummary: string): string[] {
  const source = Array.isArray(value) ? value : String(value || '').split(/(?:\d+[.、]\s*|[；;])/)
  const reasons = source.map(item => cleanEmotionText(item, 300)).filter(Boolean)
  if (reasons.length >= 2) return reasons.slice(0, 4)
  if (reasons.length === 1) return [reasons[0], '群聊样本仍在积累，结论以当前收录文本为准。']
  return [fallbackSummary || '聊天内容整体较平稳，没有明显单一情绪压倒其他话题。', '群聊样本仍在积累，结论以当前收录文本为准。']
}

function parseEmotionAnalysis(rawText: unknown, stats: EmotionStats, summaryText: string = ''): EmotionAnalysis {
  const parsed = parseJsonObject(rawText)
  const text = String(rawText || '')
  const fallbackSummary = cleanEmotionText(summaryText || text, 80) || '今天整体情绪比较平稳。'
  const scoreMatch = text.match(/(?:score|指数)[^\d]*(\d{1,3})/i)
  const confidenceMatch = text.match(/(?:confidence|置信度)[^\d]*(\d{1,3})/i)
  const score = clampInteger(parsed?.score ?? parsed?.emotionScore ?? scoreMatch?.[1], 0, 100, 50)
  const confidence = clampInteger(parsed?.confidence ?? confidenceMatch?.[1], 0, 100, stats.messageCount >= 50 ? 78 : 65)
  const summary = cleanEmotionText(parsed?.summary || parsed?.comment || parsed?.overall || fallbackSummary, 80) || fallbackSummary
  const mood = normalizeEmotionMood(score, parsed?.mood || parsed?.label)
  const reasons = normalizeEmotionReasons(parsed?.reasons || parsed?.reason, summary)
  const keywords = Array.isArray(parsed?.keywords)
    ? parsed.keywords.map(item => cleanEmotionText(item, 16)).filter(Boolean).slice(0, 6)
    : []
  return { score, confidence, mood, summary, reasons, keywords }
}

function normalizeEmotionHistoryItem(item: unknown): EmotionHistoryItem | null {
  if (!isEmotionRecord(item) || !item.date) return null
  const score = clampInteger(item.score, 0, 100, 50)
  return {
    date: String(item.date),
    score,
    mood: normalizeEmotionMood(score, item.mood),
    summary: cleanEmotionText(item.summary || item.text || '', 70),
  }
}

function renderEmotionReport(analysis: EmotionAnalysis, stats: EmotionStats, history: EmotionHistoryItem[] = []): string {
  const lines = [
    `群聊情绪指数：${analysis.score}/100（${analysis.mood}）`,
    `置信度：${analysis.confidence}%`,
    `今日样本：${stats.messageCount} 条文本消息，${stats.userCount} 位活跃成员`,
    '',
  ]
  if (history.length) {
    lines.push('近5日对比：')
    for (const item of history) {
      const suffix = item.summary ? ` ${item.summary}` : ''
      lines.push(`- ${item.date}：${item.score}/100（${item.mood}）${suffix}`)
    }
  } else {
    lines.push('近5日对比：暂无对比数据')
  }
  lines.push('', `总评：${analysis.summary}`, '原因：')
  analysis.reasons.forEach((reason, index) => lines.push(`${index + 1}. ${reason}`))
  if (analysis.keywords.length) lines.push('', `关键词：${analysis.keywords.join('、')}`)
  return lines.join('\n').trim()
}

function limitEmotionAnalysisForImage(analysis: EmotionAnalysis, stats: EmotionStats, history: EmotionHistoryItem[] = [], max: number = EMOTION_IMAGE_TEXT_LIMIT): EmotionAnalysis {
  const base = {
    ...analysis,
    summary: truncateEmotionText(analysis.summary, 80),
    reasons: (Array.isArray(analysis.reasons) ? analysis.reasons : [])
      .map(reason => truncateEmotionText(reason, 300))
      .filter(Boolean)
      .slice(0, 4),
    keywords: (Array.isArray(analysis.keywords) ? analysis.keywords : [])
      .map(keyword => truncateEmotionText(keyword, 16))
      .filter(Boolean)
      .slice(0, 6),
  }
  if (renderEmotionReport(base, stats, history).length <= max) return base

  for (const reasonLimit of [240, 200, 160, 120, 90, 70, 50]) {
    const candidate = {
      ...base,
      reasons: base.reasons.map(reason => truncateEmotionText(reason, reasonLimit)),
    }
    if (renderEmotionReport(candidate, stats, history).length <= max) return candidate
  }

  return {
    ...base,
    summary: truncateEmotionText(base.summary, 60),
    reasons: base.reasons.slice(0, 2).map(reason => truncateEmotionText(reason, 50)),
    keywords: [],
  }
}

function trimEmotionCache(map: Map<string, EmotionCacheItem>): void {
  const ttl = 5 * 60 * 1000
  const now = Date.now()
  for (const [key, value] of map.entries()) {
    if (!value || now - (value.ts || 0) > ttl) map.delete(key)
  }
  while (map.size > 200) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break
    map.delete(oldestKey)
  }
}

function getEmotionRenderExpiryIso(timeoutMs: number = EMOTION_RENDER_TIMEOUT_MS): string {
  return new Date(Date.now() + Math.max(60 * 1000, timeoutMs + EMOTION_RENDER_EXPIRY_GRACE_MS)).toISOString()
}

function buildQueuedEmotionResponse(text: string, taskId: string, accepted: boolean): string {
  const suffix = accepted
    ? `\n\n图片版已加入后台队列，完成后会自动发回。\n任务ID：${taskId}`
    : `\n\n当前资源紧张，图片版已延期；资源恢复后会继续尝试。\n任务ID：${taskId || '未生成'}`
  return `${text}${suffix}`
}

function findOpenEmotionRenderTask(channelKey: string): EmotionTaskLike | null {
  return findResourceTaskByKindAndChannel('emotion_render', channelKey, ['pending', 'claiming', 'running', 'deferred']) as EmotionTaskLike | null
}

async function summarizeEmotionMessages(msgs: EmotionMessage[], callOpenAI: CallOpenAI): Promise<EmotionSummary> {
  const source = (Array.isArray(msgs) ? msgs : []).slice(-EMOTION_ANALYSIS_MAX_MESSAGES)
  const summaries: string[] = []
  for (let i = 0; i < source.length; i += EMOTION_COMPRESS_BATCH_SIZE) {
    const batch = source.slice(i, i + EMOTION_COMPRESS_BATCH_SIZE)
    const batchText = batch.map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n')
    try {
      const summary = await callOpenAI([
        { role: 'system', content: '你是群聊消息摘要助手。将以下群聊记录压缩成一段100字以内的摘要，保留主要话题和情绪倾向。不要评价，只摘要。不得扩写，不得输出分析报告。' },
        { role: 'user', content: batchText.slice(0, 4000) },
      ], false)
      if (summary) summaries.push(String(summary))
    } catch {
      /* non-critical: failed compression batch falls back to recent raw sample */
    }
    if (summaries.join('\n---\n').length >= EMOTION_MAX_SUMMARY_CHARS) break
  }
  const fallback = source.slice(-80).map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n').slice(0, 8000)
  return {
    sample: source,
    text: (summaries.filter(Boolean).join('\n---\n') || fallback).slice(0, EMOTION_MAX_SUMMARY_CHARS),
  }
}

// Submit the prepared emotion image render to S2; Chromium runs only in the daily worker.
function submitEmotionRenderTask(channelKey: string, analysis: EmotionAnalysis, stats: EmotionStats, history: EmotionHistoryItem[], text: string): { taskId: string; accepted: boolean; reason: string } {
  const result = submitWorkerTaskWithAdmission({
    kind: 'emotion_render',
    source: 'emotion-command',
    channelKey,
    priority: 55,
    timeoutMs: EMOTION_RENDER_TIMEOUT_MS,
    expiresAt: getEmotionRenderExpiryIso(EMOTION_RENDER_TIMEOUT_MS),
    payload: { analysis, stats, history, text },
    notify: { target: 'qq-group', channelKey, status: 'pending' },
  }, { exclusive: true })
  return {
    taskId: String(result.task?.id || ''),
    accepted: !!result.accepted,
    reason: String(result.admission?.reason || result.admission?.decision || ''),
  }
}

async function handleEmotionCommand(session: EmotionSessionLike, ctx: EmotionContextLike, state: EmotionCommandState): Promise<ReturnType<typeof handled> | ReturnType<typeof notHandled>> {
  const {
    plain,
    inGuild,
    channelKey,
    loadConfig,
    callOpenAI,
    channelTodayCache,
    lastEmotionCache,
  } = state

  if (plain !== '今日情绪') return notHandled()
  if (!inGuild) return handled('这个命令只能在群里用。')
  const today = todayCst()
  const cache = channelTodayCache.get(channelKey)
  if (!cache || cache.date !== today || !cache.messages.length) return handled('今天还没有收录消息。')
  const users = new Set(cache.messages.map(m => m.userId)).size
  const msgs = cache.messages

  const cached = lastEmotionCache.get(channelKey)
  if (cached && Date.now() - cached.ts < 300000) return handled(cached.response || cached.text)
  if (cached) lastEmotionCache.delete(channelKey)

  const openRenderTask = findOpenEmotionRenderTask(channelKey)
  if (openRenderTask) {
    const existingText = String((openRenderTask.payload || {}).text || '').trim()
    const responseText = buildQueuedEmotionResponse(existingText || '图片版还在后台队列里，完成后会自动发回。', String(openRenderTask.id || ''), true)
    lastEmotionCache.set(channelKey, { text: responseText, ts: Date.now() })
    trimEmotionCache(lastEmotionCache)
    return handled(responseText)
  }

  await Promise.resolve(session.send('Thinking......')).catch(() => {
    /* non-critical: thinking indicator failure should not block emotion analysis */
  })

  const emotionSummary = await summarizeEmotionMessages(msgs, callOpenAI)
  const allSummary = emotionSummary.text

  await loadConfig(true)
  const historyFile = path.join(DATA_DIR, 'emotion-history-' + safeChannelKey(channelKey) + '.json')
  const historyData = await readJsonFile<unknown[]>(historyFile, [])
  const todayDate = today
  const recentHistory = (Array.isArray(historyData) ? historyData : [])
    .map(normalizeEmotionHistoryItem)
    .filter((item): item is EmotionHistoryItem => !!item && item.date !== todayDate)
    .slice(-5)

  const emotionPrompt = [
    '你是一个群聊情绪分析师。以下是一天中每段群聊记录的摘要，请分析整体情绪状态。',
    `今日样本：${msgs.length} 条消息，${users} 位活跃成员。`,
    '输出内容将用于图片展示。summary、reasons、keywords 中用于展示的中文正文总量不得超过1500字。summary 控制在80字以内；reasons 最多4条，每条300字以内；keywords 最多6个短词。',
    '只输出 JSON，不要 Markdown，不要解释。格式：',
    '{"score":0到100整数,"confidence":0到100整数,"mood":"偏悲观/中性/偏乐观","summary":"80字以内总结","reasons":["每条300字以内，最多4条"],"keywords":["短关键词，最多6个"]}',
    recentHistory.length ? '近5日对比：\n' + recentHistory.map(item => `${item.date} ${item.score}/100 ${item.summary}`).join('\n') : '近5日对比：暂无对比数据',
    '',
    '摘要如下：',
    allSummary.slice(0, 10000),
  ].join('\n')
  try {
    const result = await callOpenAI([
      { role: 'system', content: emotionPrompt },
      { role: 'user', content: `群 ${channelKey} 今日情绪分析` },
    ], false, { max_tokens: 600, noLazy: true })
    const stats = { messageCount: msgs.length, userCount: users }
    const analysis = parseEmotionAnalysis(result, stats, allSummary)
    const displayAnalysis = limitEmotionAnalysisForImage(analysis, stats, recentHistory)
    const rendered = renderEmotionReport(displayAnalysis, stats, recentHistory)

    try {
      const safeHistory = (Array.isArray(historyData) ? historyData : []).filter((item): item is Record<string, unknown> => isEmotionRecord(item) && item.date !== todayDate)
      safeHistory.push({ date: todayDate, score: displayAnalysis.score, confidence: displayAnalysis.confidence, mood: displayAnalysis.mood, summary: displayAnalysis.summary, reasons: displayAnalysis.reasons })
      const cutoffStr = todayCstMinusDays(5)
      await writeJsonFile(historyFile, safeHistory.filter(item => String(item.date || '') >= cutoffStr))
    } catch (historyErr) {
      ctx.logger('dongxuelian-ai').warn(`emotion history save failed: ${getEmotionCommandErrorMessage(historyErr)}`)
    }

    logDebug(ctx, 'emotion', `analysis done channel=${channelKey} score=${analysis.score} messages=${msgs.length}`)
    try {
      const submit = submitEmotionRenderTask(channelKey, displayAnalysis, stats, recentHistory, rendered)
      const responseText = buildQueuedEmotionResponse(rendered, submit.taskId, submit.accepted)
      lastEmotionCache.set(channelKey, { text: responseText, ts: Date.now() })
      trimEmotionCache(lastEmotionCache)
      return handled(responseText)
    } catch (submitErr) {
      ctx.logger('dongxuelian-ai').warn(`emotion render task submit failed: ${getEmotionCommandErrorMessage(submitErr)}`)
      lastEmotionCache.set(channelKey, { text: rendered, ts: Date.now() })
      trimEmotionCache(lastEmotionCache)
      return handled(rendered)
    }
  } catch (err) {
    ctx.logger('dongxuelian-ai').warn(`emotion analysis failed: ${getEmotionCommandErrorMessage(err)}`)
    return handled('情绪分析失败了，稍后再试。')
  }
}

export = {
  handleEmotionCommand,
}
