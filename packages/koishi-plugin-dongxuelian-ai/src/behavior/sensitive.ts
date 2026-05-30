/**
 * MODULE: 敏感话题检测。
 * 职责: 政治敏感关键词检测、handler 通知、运行时状态管理。
 * 边界: 不调 AI API，不改 conversation 持久层。检测结果通过 notifySensitiveHandlers 分发。
 */
const path = require('path')
const {
  POLITICAL_DETECT_FILE,
  POLITICAL_HANDLER_DIR,
  SENSITIVE_KEYWORDS_RE,
} = require('../core/constants') as typeof import('../core/constants')
const {
  readTextFile,
  readJsonFile,
  safeChannelKey,
  errorMessage,
} = require('../core/utils') as typeof import('../core/utils')
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')
const {
  channelSharedCache,
  pendingSensitiveAlert,
  clearUserConversationHistory,
  saveSensitiveCache,
  analyzeChannelSensitive,
} = require('../conversation') as typeof import('../conversation')

interface SensitiveSession {
  userId?: string
  author?: { id?: string }
  event?: { user?: { id?: string } }
  send(message: string): Promise<unknown>
}

interface SensitiveAnalyzed {
  hasVisual?: boolean
}

interface SensitiveParams {
  inGuild?: boolean
  channelKey?: string
  analyzed?: SensitiveAnalyzed
  plain?: string
  userName?: string
  currentUserId?: string
  lastEmotionCache?: { delete(key: string): unknown }
}

interface SensitiveCounterEntry {
  count: number
  ts: number
}

const channelMsgCount: Map<string, SensitiveCounterEntry> = new Map()
const lastSensitiveAlert: Map<string, number> = new Map()
let politicalDetectCache: Set<string> | null = null
let politicalDetectCacheExpiresAt = 0
const SENSITIVE_RUNTIME_TTL_MS = 6 * 60 * 60 * 1000
const MAX_SENSITIVE_RUNTIME_ENTRIES = 500

function getSensitiveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnSensitiveBackgroundFailure(action: string, error: unknown): void {
  console.warn(`[dongxuelian-ai] sensitive ${action} failed: ${getSensitiveErrorMessage(error)}`)
}

async function getPoliticalDetectList(): Promise<Set<string>> {
  if (politicalDetectCache !== null && Date.now() < politicalDetectCacheExpiresAt) return politicalDetectCache
  const raw = await readTextFile(POLITICAL_DETECT_FILE).catch(() => '[]')
  try {
    const parsed = JSON.parse(raw || '[]')
    politicalDetectCache = new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch (error) {
    console.warn(`[dongxuelian-ai] political detect list parse failed: ${errorMessage(error)}`)
    politicalDetectCache = new Set()
  }
  politicalDetectCacheExpiresAt = Date.now() + 30000
  return politicalDetectCache
}

function resetPoliticalDetectCache(): void {
  politicalDetectCache = null
  politicalDetectCacheExpiresAt = 0
}

function clearSensitiveRuntimeState(channelKey: string): void {
  const key = String(channelKey)
  channelMsgCount.delete(key)
  lastSensitiveAlert.delete(key)
  pendingSensitiveAlert.delete(key)
}

function pruneRuntimeMap<T>(map: Map<string, T>, getTs: (value: T) => number, now: number = Date.now()): void {
  for (const [key, value] of map) {
    const ts = Number(getTs(value)) || 0
    if (ts && now - ts > SENSITIVE_RUNTIME_TTL_MS) map.delete(key)
  }
  if (map.size <= MAX_SENSITIVE_RUNTIME_ENTRIES) return
  const ordered = Array.from(map.entries()).sort((a, b) => (Number(getTs(a[1])) || 0) - (Number(getTs(b[1])) || 0))
  for (const [key] of ordered.slice(0, map.size - MAX_SENSITIVE_RUNTIME_ENTRIES)) map.delete(key)
}

function trimSensitiveRuntimeMaps(now: number = Date.now()): void {
  pruneRuntimeMap(channelMsgCount, entry => entry && typeof entry === 'object' ? entry.ts : 0, now)
  pruneRuntimeMap(lastSensitiveAlert, ts => ts, now)
  pruneRuntimeMap(pendingSensitiveAlert, entry => entry && typeof entry === 'object' ? entry.ts : 0, now)
}

async function notifySensitiveHandlers(session: SensitiveSession, channelKey: string, options: { throttle?: boolean; message?: string } = {}): Promise<boolean> {
  const key = String(channelKey)
  trimSensitiveRuntimeMaps()
  const throttle = options.throttle !== false
  if (throttle && Date.now() - (lastSensitiveAlert.get(key) || 0) <= 30000) return false

  const safeKey = safeChannelKey(key)
  const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeKey + '.json')
  const handlers = await readJsonFile(handlerFile, [])
  if (!Array.isArray(handlers) || handlers.length === 0) return false

  const atAll = handlers.map(id => `<at id="${id}"/>`).join(' ')
  const message = options.message || `管理员快来，群里有傻福在剑阵。${atAll}`
  session.send(message).catch((error) => warnSensitiveBackgroundFailure('handler notification', error))
  if (throttle) lastSensitiveAlert.set(key, Date.now())
  return true
}

async function handleSensitiveMessage(session: SensitiveSession, ctx: unknown, params: SensitiveParams = {}): Promise<{ isDetectOn: boolean }> {
  const {
    inGuild,
    channelKey,
    analyzed = {},
    plain = '',
    userName = '',
    currentUserId = '',
    lastEmotionCache,
  } = params

  const detectList = await getPoliticalDetectList()
  const isDetectOn = detectList.has(channelKey)
  const normalizedPlain = String(plain || '').normalize('NFKC').replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '')
  if (inGuild && isDetectOn && !analyzed.hasVisual && SENSITIVE_KEYWORDS_RE.test(normalizedPlain)) {
    await notifySensitiveHandlers(session, channelKey, { throttle: true })
    logDebug(ctx, 'sensitive', `sensitive topic channel=${channelKey} textLen=${String(plain || '').length}`)
    channelSharedCache.delete(channelKey)
    clearUserConversationHistory(session)
    channelMsgCount.delete(channelKey)
    if (lastEmotionCache && typeof lastEmotionCache.delete === 'function') lastEmotionCache.delete(channelKey)
  }

  if (inGuild && isDetectOn && !analyzed.hasVisual && plain) {
    saveSensitiveCache(channelKey, plain, userName, currentUserId)
  }

  if (isDetectOn && inGuild && !analyzed.hasVisual) {
    const current = channelMsgCount.get(channelKey)
    const count = (current?.count || 0) + 1
    channelMsgCount.set(channelKey, { count, ts: Date.now() })
    if (count % 50 === 0) analyzeChannelSensitive(channelKey).catch((error) => warnSensitiveBackgroundFailure('periodic summary', error))
  }

  if (isDetectOn && pendingSensitiveAlert.get(channelKey)) {
    pendingSensitiveAlert.delete(channelKey)
    channelSharedCache.delete(channelKey)
    channelMsgCount.delete(channelKey)
    if (lastEmotionCache && typeof lastEmotionCache.delete === 'function') lastEmotionCache.delete(channelKey)
    await notifySensitiveHandlers(session, channelKey, { throttle: false })
  }

  return { isDetectOn }
}

export = {
  getPoliticalDetectList,
  resetPoliticalDetectCache,
  clearSensitiveRuntimeState,
  trimSensitiveRuntimeMaps,
  notifySensitiveHandlers,
  handleSensitiveMessage,
  channelMsgCount,
  lastSensitiveAlert,
}
