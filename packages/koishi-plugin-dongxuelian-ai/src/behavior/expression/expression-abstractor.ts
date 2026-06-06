/**
 * MODULE: 表达学习抽象 v2.2（每日 harvest）。
 * 职责: 喂"今日 today-cache + daily-stats 6 天"消息列表 → 经 v1 硬过滤 →
 *      调小模型抽 situation/style → 调 v2.1 store 写池。
 *      提供 runExpressionHarvestForChannel / runExpressionHarvestForAllChannels 入口。
 * 边界: 不监听 session、不发消息、不直接被 chat 主链路 require。
 *      小模型失败 / 无 key 全部静默吞错；不阻塞主链路。
 * 状态: lastHarvestAt: Map<safeChannelKey, number> 仅供观测；不持有候选缓存。
 */
const fs = require('fs')
const fsp = require('fs/promises') as typeof import('fs/promises')
const path = require('path')
const { DATA_DIR, TODAY_CACHE_PREFIX, SUMMARY_WHITELIST_FILE,
  PROVIDERS, GLM_KEY_FILE, DASHSCOPE_KEY_FILE } = require('../../core/constants') as typeof import('../../core/constants')
const { readTextFile, readJsonFile, truncateText, errorMessage } = require('../../core/utils') as typeof import('../../core/utils')
const { loadConfig } = require('../../core/runtime-config') as typeof import('../../core/runtime-config')
const { filterExpressionLearningMessages } = require('./expression-learner') as typeof import('./expression-learner')
const { appendExpressionCandidate, expressionPoolSafeChannelKey,
  EXPRESSION_POOL_MAX_TEXT_LEN } = require('./expression-pool-store') as typeof import('./expression-pool-store')
const { withTimeout } = require('../../agent/queue') as typeof import('../../agent/queue')

interface AbstractorModelRef {
  provider: string
  model: string
  keyFile: string | null
}

interface AbstractorMessage {
  role: string
  content: string
}

interface AbstractorCandidate {
  situation: string
  style: string
}

interface HarvestMessage {
  content?: string
  userId?: string
}

interface HarvestOptions {
  now?: number
  selfUserId?: string
  botName?: string
  requestChatCompletions?: RequestChatCompletions
  models?: AbstractorModelRef[]
  filterMessages?: (messages: HarvestMessage[], options: Record<string, unknown>) => { kept?: HarvestMessage[] }
  callModel?: (messages: AbstractorMessage[], options: HarvestOptions) => Promise<string | { content?: string }>
  appendCandidate?: (channelKey: string, candidate: { situation: string; style: string; contributors: string[] }, options: { now?: number }) => Promise<{ mode?: string }>
  channels?: string[]
}

interface HarvestSummary {
  channelKey: string
  totalInput: number
  kept: number
  abstractCalls: number
  abstractOk: number
  abstractFailed: number
  created: number
  merged: number
  rejected: number
  error: string
}

interface HarvestAllSummary {
  channels: number
  totalKept: number
  abstractOk: number
  abstractFailed: number
  created: number
  merged: number
  rejected: number
  perChannel: HarvestSummary[]
}

interface HarvestDiagnostic {
  version: number
  channels: number
  totalKept: number
  abstractOk: number
  abstractFailed: number
  created: number
  merged: number
  rejected: number
}

interface HarvestContext {
  bots?: Array<{ selfId?: string; userId?: string }>
}

type RequestChatCompletions = (messages: AbstractorMessage[], config: Record<string, unknown>, options?: Record<string, unknown>) => Promise<string | { content?: string }>

function getAbstractorResultContent(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'content' in result) {
    return String((result as { content?: unknown }).content || '')
  }
  return ''
}

const EXPRESSION_ABSTRACTOR_VERSION = 1
const EXPRESSION_ABSTRACTOR_MAX_BATCH = 5
const EXPRESSION_ABSTRACTOR_MAX_INPUT_LINES = 20
const EXPRESSION_ABSTRACTOR_MAX_INPUT_CHARS = 1800
const EXPRESSION_ABSTRACTOR_TIMEOUT_MS = 15000
const EXPRESSION_ABSTRACTOR_TODAY_CACHE_FILE_BYTES = 2 * 1024 * 1024
const EXPRESSION_ABSTRACTOR_WHITELIST_BYTES = 256 * 1024

const lastHarvestAt: Map<string, number> = new Map()

const ABSTRACTOR_FALLBACK_MODELS: readonly AbstractorModelRef[] = Object.freeze([
  { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
  { provider: 'dashscope', model: 'qwen-turbo', keyFile: DASHSCOPE_KEY_FILE },
  { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: null },
])

function abstractorClampText(value: unknown, maxLen: number): string {
  const normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return truncateText(normalized, Math.max(1, maxLen))
}

function abstractorBuildSystemPrompt(): string {
  return [
    '你是一个群聊语料的"句式骨架"提取器。',
    '任务：阅读以下若干群聊原文（已经过粗筛），提取至多 5 条"场合 + 句式骨架"。',
    '硬要求：',
    '1) 每条返回 { "situation": "...≤20字...", "style": "...≤20字..." }，整体输出一个 JSON 数组。',
    '2) situation 描述"什么场合"，必须泛用、不写具体话题词、不写人名、不写时间。',
    '3) style 是句式骨架，把内容词换成占位（X / 某 / 这 / 那），不要照抄原话。',
    '4) 不能出现真名、QQ号、链接、敏感政治词；如果原句无明显规律，就返回空数组 []。',
    '5) 不要输出解释、不要 markdown 代码块、只输出 JSON 数组本体。',
  ].join('\n')
}

function abstractorBuildUserPayload(messages: HarvestMessage[] = []): string {
  const lines: string[] = []
  let charBudget = EXPRESSION_ABSTRACTOR_MAX_INPUT_CHARS
  for (const entry of messages) {
    if (lines.length >= EXPRESSION_ABSTRACTOR_MAX_INPUT_LINES) break
    const text = String(entry && entry.content ? entry.content : '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const piece = `- ${text}`
    if (piece.length > charBudget) break
    lines.push(piece)
    charBudget -= piece.length + 1
  }
  return lines.join('\n')
}

function abstractorParseModelOutput(raw: string | { content?: string } | null | undefined): AbstractorCandidate[] {
  if (raw == null) return []
  let text = typeof raw === 'string' ? raw : (raw && typeof raw.content === 'string' ? raw.content : '')
  text = String(text || '').trim()
  if (!text) return []
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch { /* non-critical: model may wrap JSON in prose, try array slice fallback */
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { /* non-critical: invalid model JSON means no candidates */ return [] }
  }
  if (!Array.isArray(parsed)) return []
  const out: AbstractorCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const situation = abstractorClampText(item.situation, EXPRESSION_POOL_MAX_TEXT_LEN)
    const style = abstractorClampText(item.style, EXPRESSION_POOL_MAX_TEXT_LEN)
    if (!situation || !style) continue
    out.push({ situation, style })
    if (out.length >= EXPRESSION_ABSTRACTOR_MAX_BATCH) break
  }
  return out
}

function abstractorWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return withTimeout(() => promise, ms) as Promise<T>
}

async function abstractorCallModel(messages: AbstractorMessage[], options: HarvestOptions = {}): Promise<string> {
  const cfg = await loadConfig().catch(() => ({} as Record<string, unknown>))
  const requestChatCompletions = options.requestChatCompletions
    || (require('../../core/api') as typeof import('../../core/api')).requestChatCompletions
  const fallback = Array.isArray(options.models) && options.models.length ? options.models : ABSTRACTOR_FALLBACK_MODELS
  for (const am of fallback) {
    const provDef = PROVIDERS[am.provider]
    if (!provDef) continue
    let apiKey = ''
    try {
      const configApiKey = String(cfg.apiKey || '')
      apiKey = am.keyFile ? (await readTextFile(am.keyFile).catch(() => '') || configApiKey) : configApiKey
      apiKey = String(apiKey || '').replace(/[\r\n]+/g, '')
    } catch { /* non-critical: key resolution fallback tries next abstractor model */
    }
    if (!apiKey) continue
    try {
      const result = await requestChatCompletions(messages, {
        model: am.model,
        baseURL: provDef.baseURL.replace(/\/+$/, ''),
        apiKey,
        provider: am.provider,
      }, { max_tokens: 200, _fallbackSet: 'lightweight' })
      const text = getAbstractorResultContent(result)
      if (text) return text
    } catch (error) {
      console.warn(`[dongxuelian-ai] expression abstractor model call failed provider=${am.provider}: ${errorMessage(error)}`)
    }
  }
  return ''
}

async function runExpressionHarvestForChannel(ctx: HarvestContext | null, channelKey: string, options: HarvestOptions = {}): Promise<HarvestSummary> {
  const safeChannelKey = expressionPoolSafeChannelKey(channelKey)
  const summary = {
    channelKey: safeChannelKey,
    totalInput: 0,
    kept: 0,
    abstractCalls: 0,
    abstractOk: 0,
    abstractFailed: 0,
    created: 0,
    merged: 0,
    rejected: 0,
    error: '',
  }
  try {
    const file = TODAY_CACHE_PREFIX + safeChannelKey + '.json'
    const stat = await fsp.stat(file).catch((): null => null)
    if (!stat || !stat.isFile() || stat.size > EXPRESSION_ABSTRACTOR_TODAY_CACHE_FILE_BYTES) {
      summary.error = 'no_today_cache'
      return summary
    }
    const data = await readJsonFile<{ messages?: HarvestMessage[] } | null>(file, null, { maxBytes: EXPRESSION_ABSTRACTOR_TODAY_CACHE_FILE_BYTES }).catch((): null => null)
    const messages: HarvestMessage[] = data && typeof data === 'object' && Array.isArray(data.messages) ? data.messages : []
    summary.totalInput = messages.length
    if (!messages.length) return summary
    const filterFn = options.filterMessages || filterExpressionLearningMessages
    const selfId = String(options.selfUserId || '').trim()
    const selfUserIds = selfId ? [selfId] : []
    const filtered = filterFn(messages, {
      selfUserIds,
      botUserIds: selfUserIds,
      botName: options.botName || '',
    })
    const keptMessages = Array.isArray(filtered.kept) ? filtered.kept : []
    summary.kept = keptMessages.length
    if (summary.kept < 5) return summary
    const callModel = options.callModel || abstractorCallModel
    const promptMessages: AbstractorMessage[] = [
      { role: 'system', content: abstractorBuildSystemPrompt() },
      { role: 'user', content: abstractorBuildUserPayload(keptMessages) },
    ]
    summary.abstractCalls += 1
    let raw = ''
    try {
      const modelResult = await abstractorWithTimeout(Promise.resolve().then(() => callModel(promptMessages, options)), EXPRESSION_ABSTRACTOR_TIMEOUT_MS)
      raw = getAbstractorResultContent(modelResult)
    } catch (error) {
      console.warn(`[dongxuelian-ai] expression abstractor timed out or failed channel=${safeChannelKey}: ${errorMessage(error)}`)
      raw = ''
    }
    const candidates = abstractorParseModelOutput(raw)
    if (!candidates.length) {
      summary.abstractFailed += 1
      return summary
    }
    summary.abstractOk += 1
    const contributorIds = []
    const seenIds = new Set()
    for (const entry of keptMessages) {
      const id = String(entry && entry.userId ? entry.userId : '').trim()
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      contributorIds.push(id)
      if (contributorIds.length >= 50) break
    }
    const appendFn = options.appendCandidate || appendExpressionCandidate
    for (const cand of candidates) {
      try {
        const result = await appendFn(safeChannelKey, { situation: cand.situation, style: cand.style, contributors: contributorIds }, { now: options.now })
        if (result && result.mode === 'created') summary.created += 1
        else if (result && result.mode === 'merged') summary.merged += 1
        else summary.rejected += 1
      } catch (error) {
        console.warn(`[dongxuelian-ai] expression candidate append failed channel=${safeChannelKey}: ${errorMessage(error)}`)
        summary.rejected += 1
      }
    }
    lastHarvestAt.set(safeChannelKey, Number(options.now) || Date.now())
  } catch (error) {
    summary.error = errorMessage(error) ? errorMessage(error).slice(0, 200) : 'unknown'
  }
  return summary
}

async function abstractorListEligibleChannels(): Promise<string[]> {
  const whitelist = await readJsonFile<unknown[]>(SUMMARY_WHITELIST_FILE, [], { maxBytes: EXPRESSION_ABSTRACTOR_WHITELIST_BYTES }).catch((): unknown[] => [])
  const allowed: Set<string> = new Set()
  if (Array.isArray(whitelist)) {
    for (const key of whitelist) {
      const safe = expressionPoolSafeChannelKey(String(key || ''))
      if (safe && safe !== 'unknown') allowed.add(safe)
    }
  }
  let files: string[] = []
  try { files = await fsp.readdir(DATA_DIR) } catch { /* non-critical: no data dir means no eligible channels */ files = [] }
  const out: string[] = []
  const seen: Set<string> = new Set()
  for (const file of files) {
    const m = /^today-cache-(.+)\.json$/.exec(file)
    if (!m) continue
    const key = m[1]
    if (!key || seen.has(key)) continue
    if (!allowed.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

async function runExpressionHarvestForAllChannels(ctx: HarvestContext | null, options: HarvestOptions = {}): Promise<HarvestAllSummary> {
  const channels = options.channels && Array.isArray(options.channels)
    ? options.channels.map(expressionPoolSafeChannelKey)
    : await abstractorListEligibleChannels()
  const result: HarvestAllSummary = {
    channels: 0,
    totalKept: 0,
    abstractOk: 0,
    abstractFailed: 0,
    created: 0,
    merged: 0,
    rejected: 0,
    perChannel: [],
  }
  const selfId = options.selfUserId
    || (ctx && Array.isArray(ctx.bots) && ctx.bots[0] && (ctx.bots[0].selfId || ctx.bots[0].userId))
    || ''
  const botName = options.botName || ''
  for (const key of channels) {
    const summary = await runExpressionHarvestForChannel(ctx, key, {
      ...options,
      selfUserId: selfId,
      botName,
    })
    result.channels += 1
    result.totalKept += summary.kept
    result.abstractOk += summary.abstractOk
    result.abstractFailed += summary.abstractFailed
    result.created += summary.created
    result.merged += summary.merged
    result.rejected += summary.rejected
    result.perChannel.push(summary)
  }
  return result
}

function buildExpressionHarvestDiagnostic(summary: Partial<HarvestAllSummary> = {}): HarvestDiagnostic {
  return {
    version: EXPRESSION_ABSTRACTOR_VERSION,
    channels: Math.max(0, Math.floor(Number(summary.channels) || 0)),
    totalKept: Math.max(0, Math.floor(Number(summary.totalKept) || 0)),
    abstractOk: Math.max(0, Math.floor(Number(summary.abstractOk) || 0)),
    abstractFailed: Math.max(0, Math.floor(Number(summary.abstractFailed) || 0)),
    created: Math.max(0, Math.floor(Number(summary.created) || 0)),
    merged: Math.max(0, Math.floor(Number(summary.merged) || 0)),
    rejected: Math.max(0, Math.floor(Number(summary.rejected) || 0)),
  }
}

function formatExpressionHarvestDiagnostic(diagnostic: Partial<HarvestAllSummary> = {}): string {
  const d = buildExpressionHarvestDiagnostic(diagnostic)
  return [
    `harvest channels=${d.channels}`,
    `totalKept=${d.totalKept}`,
    `abstract_ok=${d.abstractOk}`,
    `abstract_failed=${d.abstractFailed}`,
    `created=${d.created}`,
    `merged=${d.merged}`,
    `rejected=${d.rejected}`,
  ].join(' ')
}

export = {
  EXPRESSION_ABSTRACTOR_VERSION,
  EXPRESSION_ABSTRACTOR_MAX_BATCH,
  EXPRESSION_ABSTRACTOR_TIMEOUT_MS,
  EXPRESSION_ABSTRACTOR_FALLBACK_MODELS: ABSTRACTOR_FALLBACK_MODELS,
  abstractorBuildSystemPrompt,
  abstractorBuildUserPayload,
  abstractorParseModelOutput,
  runExpressionHarvestForChannel,
  runExpressionHarvestForAllChannels,
  buildExpressionHarvestDiagnostic,
  formatExpressionHarvestDiagnostic,
  expressionAbstractorLastHarvestAt: lastHarvestAt,
}
