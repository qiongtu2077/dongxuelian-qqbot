/**
 * MODULE: 对话/记忆/印象持久层。
 * 职责: 对话历史读写、记忆系统（writeMemory/deleteMemory/getMemorySummary）、
 *       用户画像、复读指纹缓存、共享频道上下文。
 * 状态: replyFingerprintCache / sharedChannelCache / 各 Map 按 channelKey 索引。
 * 边界: 不调 AI API。读操作返回数据，写操作落盘。
 */
const path = require('path')
const fsp = require('fs/promises')
const { CONVERSATIONS_DIR, MEMORY_HISTORY_LIMIT, MAX_HISTORY_MESSAGES,
  CONVERSATION_EXPIRE_MS, CONVERSATION_SUMMARY_INTERVAL,
  MAX_REPEAT_CHECK_HISTORY, MAX_CHANNEL_SHARED_MESSAGES,
  MAX_REPLY_FINGERPRINT_HISTORY, MAX_CHANNEL_PROMPT_MESSAGES,
  MAX_THREAD_CONTEXT_MESSAGES, MAX_REPLY_CHAIN_DEPTH,
  GLM_KEY_FILE, DASHSCOPE_KEY_FILE, PROVIDERS,
  SENSITIVE_CACHE_PREFIX,
  USER_PROFILE_DIR, TODAY_CACHE_PREFIX, SUMMARY_WHITELIST_FILE,
  DATA_DIR,
} = require('./core/constants') as typeof import('./core/constants')
const { readTextFile, readJsonFile, writeJsonFile, sanitizeUserName, safeChannelKey, todayCst, todayCstMinusDays, formatShanghaiTime24h, normalizeText } = require('./core/utils') as typeof import('./core/utils')
const { requestChatCompletions } = require('./core/api') as typeof import('./core/api')
const { loadConfig } = require('./core/runtime-config') as typeof import('./core/runtime-config')
const { appendGroupSceneEntry } = require('./routing/group-scene-index') as typeof import('./routing/group-scene-index')
const { redactSensitiveText } = require('./core/redactor') as typeof import('./core/redactor')

interface SessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  messageId?: string
  selfId?: string
  author?: { id?: string }
  bot?: { selfId?: string }
  quote?: QuoteLike
}

interface SegmentLike {
  type?: string
  data?: {
    text?: string
    name?: string
    qq?: string | number
    id?: string | number
    _transcribedText?: string
  }
}

interface QuoteLike {
  userId?: string
  user_id?: string
  user?: { id?: string }
  author?: string | { id?: string; nick?: string; name?: string }
  authorId?: string
  sender?: { userId?: string; id?: string; nickname?: string; card?: string; name?: string }
  nickname?: string
  nick?: string
  id?: string
  messageId?: string
  message_id?: string
  message?: { id?: string }
  content?: string | SegmentLike[]
  raw_message?: string
  text?: string
}

interface ConversationMessage {
  role?: string
  content?: string
  userId?: string
  speakerName?: string
  personaName?: string
  messageId?: string
  replyToId?: string
  mentionUserIds?: string[]
  hasMessageRecordCue?: boolean
  hasAudio?: boolean
  ts?: number
  createdAt?: number
  meta?: { messageId?: string; [key: string]: unknown }
}

interface ConversationDiskData {
  summary?: string
  summaryTotal?: number
  totalCount?: number
  messages: ConversationMessage[]
}

interface ReplyFingerprintEntry {
  content: string
  createdAt: number
}

interface SharedChannelEntry extends ConversationMessage {
  userId: string
  role: string
  speakerName: string
  personaName: string
  content: string
  messageId: string
  replyToId: string
  mentionUserIds: string[]
  hasMessageRecordCue: boolean
  hasAudio: boolean
  ts: number
}

interface TodayCacheMessage {
  time: string
  ts: number
  user: string
  userId: string
  content: string
  messageId: string
  mentionUserIds: string[]
}

interface TodayCache {
  date: string
  messages: TodayCacheMessage[]
  updatedAt?: number
  lastDiskWrite?: number
}

interface SharedTurnMetadata {
  mentionUserIds?: Array<string | number>
  personaName?: string
  messageId?: string | number
  replyToId?: string | number
  hasMessageRecordCue?: boolean
  hasAudio?: boolean
  fromSummary?: boolean
}

interface SharedContextOptions extends SharedTurnMetadata {
  currentText?: string
  directAt?: boolean
  nameMentioned?: boolean
  isDirect?: boolean
  randomTriggered?: boolean
}

interface UserProfileData {
  userId: string
  names: string[]
  messages: Array<{ time: string; content: string }>
  memory?: MemoryEntry[]
}

interface MemoryEntry {
  text: string
  ts?: number
  confirmCount?: number
}

interface SensitiveCacheData {
  messages?: Array<{ speakerName?: string; userId?: string; content?: string; ts?: number }>
}

interface MemoryTimerData {
  intervalHours?: number
  lastClearTs?: number
}

interface ReadJsonSmallOptions {
  unlinkOversize?: boolean
}

interface QuoteInfo {
  content: string
  authorName: string
  authorId: string
  messageId: string
  isSelf: boolean
  matchedMessage: SharedChannelEntry | null
}

let conversationCache: Map<string, ConversationMessage[]> = new Map()
let replyFingerprintCache: Map<string, ReplyFingerprintEntry[]> = new Map()
const conversationLastActiveAt: Map<string, number> = new Map()
const conversationCacheAccessAt: Map<string, number> = new Map()
const channelSharedCache: Map<string, SharedChannelEntry[]> = new Map()
const lastForwardSummaryCache: Map<string, string> = new Map()
const lastForwardSummaryCacheTs: Map<string, number> = new Map()
const pendingSensitiveAlert: Map<string, { flagged?: boolean; ts: number }> = new Map()
const summaryLocks: Map<string, Promise<void>> = new Map()
const channelTodayCache: Map<string, TodayCache> = new Map()

const writeQueues: Map<string, Promise<unknown>> = new Map()
function enqueueWrite<T>(key: string, fn: (value?: unknown) => T | Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  writeQueues.set(key, next)
  next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key) })
  return next
}

const CHANNEL_RUNTIME_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CHANNEL_RUNTIME_CACHE_ENTRIES = 200
const MAX_CONVERSATION_CACHE_ENTRIES = 400
const MAX_TODAY_CACHE_MESSAGES = parseConversationPositiveInt(process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES, 3000, 500, 20000)
const MAX_TODAY_CACHE_CONTENT_CHARS = parseConversationPositiveInt(process.env.DONGXUELIAN_TODAY_CACHE_MAX_CONTENT_CHARS, 500, 80, 2000)
const MAX_SENSITIVE_CACHE_MESSAGES = parseConversationPositiveInt(process.env.DONGXUELIAN_SENSITIVE_CACHE_MAX_MESSAGES, 60, 10, 500)
const MAX_SENSITIVE_CACHE_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_SENSITIVE_CACHE_MAX_BYTES, 512 * 1024, 64 * 1024, 4 * 1024 * 1024)
const MAX_CONVERSATION_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_CONVERSATION_MAX_BYTES, 1024 * 1024, 64 * 1024, 8 * 1024 * 1024)
const MAX_USER_PROFILE_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_USER_PROFILE_MAX_BYTES, 512 * 1024, 64 * 1024, 4 * 1024 * 1024)
const MAX_SMALL_CONFIG_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_SMALL_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024)
const MAX_DAILY_STATS_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_DAILY_STATS_MAX_BYTES, 8 * 1024 * 1024, 512 * 1024, 64 * 1024 * 1024)
const STATS_FILE_RETENTION_DAYS = 6

function parseConversationPositiveInt(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function getConversationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnConversationFailure(action: string, error: unknown): void {
  console.warn(`[conversation] ${action} failed: ${getConversationErrorMessage(error)}`)
}

function getNodeErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
}

function readJsonFileIfSmallSync<T>(file: string, maxBytes: number, fallback: T, options: ReadJsonSmallOptions = {}): T {
  try {
    const fs = require('fs')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) {
      if (options.unlinkOversize) { try { fs.unlinkSync(file) } catch { /* non-critical: best-effort oversized json cleanup */ } }
      return fallback
    }
    return JSON.parse(fs.readFileSync(file, 'utf8') || 'null') as T
  } catch { /* non-critical: missing or malformed optional json falls back to caller default */
    return fallback
  }
}

function getConversationFileSafeKeys(key: string = ''): string[] {
  const portable = safeChannelKey(key)
  const legacy = String(key || '').replace(/[^a-zA-Z0-9.:_-]/g, '_') || 'unknown'
  return portable === legacy ? [portable] : [portable, legacy]
}

function getLastMessageTs(items: Array<{ ts?: number }> = []): number {
  if (!Array.isArray(items) || !items.length) return 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const ts = Number(items[i]?.ts || 0)
    if (ts > 0) return ts
  }
  return 0
}

function trimTodayCacheMessages(cache: TodayCache | null | undefined): void {
  if (!cache || !Array.isArray(cache.messages)) return
  if (cache.messages.length > MAX_TODAY_CACHE_MESSAGES) {
    cache.messages.splice(0, cache.messages.length - MAX_TODAY_CACHE_MESSAGES)
  }
}

function pruneMapByActivity<T>(map: Map<string, T>, getLastTs: (value: T) => number, now: number = Date.now()): void {
  for (const [key, value] of map.entries()) {
    const ts = Number(getLastTs(value)) || 0
    if (ts > 0 && now - ts > CHANNEL_RUNTIME_CACHE_TTL_MS) map.delete(key)
  }
  if (map.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES) return
  const ordered = [...map.entries()]
    .map(([key, value]): [string, number] => [key, Number(getLastTs(value)) || 0])
    .sort((left, right) => left[1] - right[1])
  while (map.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
    const next = ordered.shift()
    if (next) map.delete(next[0])
  }
}

function pruneMapWithTtl<T>(map: Map<string, T>, getLastTs: (value: T) => number, ttlMs: number, now: number = Date.now()): void {
  for (const [key, value] of map.entries()) {
    const ts = Number(getLastTs(value)) || 0
    if (!ts || now - ts > ttlMs) map.delete(key)
  }
  if (map.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES) return
  const ordered = [...map.entries()]
    .map(([key, value]): [string, number] => [key, Number(getLastTs(value)) || 0])
    .sort((left, right) => left[1] - right[1])
  while (map.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
    const next = ordered.shift()
    if (next) map.delete(next[0])
  }
}

function pruneForwardSummaryCache(ttlMs: number, now: number = Date.now()): void {
  for (const key of lastForwardSummaryCache.keys()) {
    const ts = Number(lastForwardSummaryCacheTs.get(key) || 0)
    if (!ts || now - ts > ttlMs) {
      lastForwardSummaryCache.delete(key)
      lastForwardSummaryCacheTs.delete(key)
    }
  }
  if (lastForwardSummaryCache.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES) return
  const ordered = [...lastForwardSummaryCache.keys()]
    .map((key): [string, number] => [key, Number(lastForwardSummaryCacheTs.get(key) || 0)])
    .sort((left, right) => left[1] - right[1])
  while (lastForwardSummaryCache.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
    const next = ordered.shift()
    if (next) {
      const key = next[0]
      lastForwardSummaryCache.delete(key)
      lastForwardSummaryCacheTs.delete(key)
    }
  }
}

function setLastForwardSummaryCache(channelKey: string, text: string, ts: number = Date.now()): void {
  const key = String(channelKey || '')
  lastForwardSummaryCache.set(key, String(text || ''))
  lastForwardSummaryCacheTs.set(key, Number(ts) || Date.now())
}

function trimChannelRuntimeCaches(now: number = Date.now()): void {
  pruneMapByActivity(channelSharedCache, items => getLastMessageTs(items), now)
  pruneMapByActivity(channelTodayCache, cache => Number(cache?.updatedAt || cache?.lastDiskWrite || getLastMessageTs(cache?.messages)), now)
  pruneForwardSummaryCache(60 * 60 * 1000, now)
  pruneMapWithTtl(pendingSensitiveAlert, entry => Number(entry?.ts || 0), 2 * 60 * 60 * 1000, now)
}

function trimConversationRuntimeCaches(now: number = Date.now()): void {
  for (const [key, ts] of conversationCacheAccessAt.entries()) {
    if (now - ts >= CONVERSATION_EXPIRE_MS) {
      conversationCacheAccessAt.delete(key)
      conversationLastActiveAt.delete(key)
      conversationCache.delete(key)
      replyFingerprintCache.delete(key)
    }
  }
  if (conversationCache.size <= MAX_CONVERSATION_CACHE_ENTRIES && replyFingerprintCache.size <= MAX_CONVERSATION_CACHE_ENTRIES) return
  const ordered = [...conversationCacheAccessAt.entries()].sort((left, right) => left[1] - right[1])
  while ((conversationCache.size > MAX_CONVERSATION_CACHE_ENTRIES || replyFingerprintCache.size > MAX_CONVERSATION_CACHE_ENTRIES) && ordered.length) {
    const next = ordered.shift()
    if (next) {
      const key = next[0]
      conversationCacheAccessAt.delete(key)
      conversationLastActiveAt.delete(key)
      conversationCache.delete(key)
      replyFingerprintCache.delete(key)
    }
  }
}

function getSessionUserId(session: SessionLike): string {
  return String(session?.userId || session?.author?.id || session?.username || 'unknown')
}

function getChannelKey(session: SessionLike): string {
  if (session?.guildId || session?.channelId) return String(session.guildId || session.channelId)
  if (session?.isDirect) return `private:${getSessionUserId(session)}`
  return 'private'
}

function getConversationKey(session: SessionLike): string { return `${getChannelKey(session)}::${getSessionUserId(session)}` }

function touchConversation(session: SessionLike): void {
  const key = getConversationKey(session)
  const now = Date.now()
  conversationLastActiveAt.set(key, now)
  conversationCacheAccessAt.set(key, now)
}

function touchConversationAccess(session: SessionLike): void { conversationCacheAccessAt.set(getConversationKey(session), Date.now()) }

function readConversationDisk(key: string): ConversationDiskData | null {
  for (const safeKey of getConversationFileSafeKeys(key)) {
    const data = readJsonFileIfSmallSync<ConversationDiskData | null>(path.join(CONVERSATIONS_DIR, safeKey + '.json'), MAX_CONVERSATION_FILE_BYTES, null, { unlinkOversize: true })
    if (data) return data
  }
  return null
}

function writeConversationDisk(key: string, data: ConversationDiskData): void {
  try { const safeKey = getConversationFileSafeKeys(key)[0]; require('fs').mkdirSync(CONVERSATIONS_DIR, { recursive: true }); require('fs').writeFileSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'), JSON.stringify(data), 'utf8') } catch (error) { warnConversationFailure('write conversation disk', error) }
}

function isImagePlaceholderMessage(msg: ConversationMessage | null | undefined, messageId: string): boolean {
  if (!msg || msg.role !== 'user' || !msg.content || !String(msg.content).includes('[图片]')) return false
  if (String(msg.content || '').includes('[图片]:')) return false
  if (String(msg.messageId || '') === String(messageId)) return true
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : null
  return !!(meta && String(meta.messageId || '') === String(messageId))
}

function replaceImagePlaceholderInMessages(messages: ConversationMessage[] = [], messageId: string = '', analysis: string = ''): boolean {
  if (!Array.isArray(messages) || !messageId || !analysis) return false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (isImagePlaceholderMessage(msg, messageId)) {
      msg.content = String(msg.content).replace('[图片]', `[图片]: ${String(analysis).slice(0, 200)}`)
      return true
    }
  }
  return false
}

function replaceImagePlaceholderInConversation(key: string, messageId: string, analysis: string): Promise<boolean> {
  if (!key || !messageId || !analysis) return Promise.resolve(false)
  return enqueueWrite(key, () => {
    let replaced = false
    const diskData = readConversationDisk(key) || { summary: '', summaryTotal: 0, totalCount: 0, messages: [] }
    const mergedMessages = mergeConversationMessages(diskData.messages, conversationCache.get(key))
    if (replaceImagePlaceholderInMessages(mergedMessages, messageId, analysis)) {
      diskData.messages = mergedMessages
      diskData.totalCount = Math.max(Number(diskData.totalCount || 0), mergedMessages.filter(item => item && item.role === 'user').length)
      writeConversationDisk(key, diskData)
      replaced = true
    }
    if (!replaced && replaceImagePlaceholderInMessages(diskData.messages, messageId, analysis)) {
      writeConversationDisk(key, diskData)
      replaced = true
    }
    if (replaced) {
      conversationCache.set(key, (diskData.messages || mergedMessages).slice(-MEMORY_HISTORY_LIMIT))
    }
    return replaced
  })
}

function getConversationHistory(session: SessionLike): ConversationMessage[] {
  const key = getConversationKey(session); const lastAccessAt = conversationCacheAccessAt.get(key) || conversationLastActiveAt.get(key)
  if (typeof lastAccessAt === 'number' && Date.now() - lastAccessAt >= CONVERSATION_EXPIRE_MS) conversationCache.delete(key)
  touchConversationAccess(session)
  trimConversationRuntimeCaches()
  const mem = conversationCache.get(key)
  if (mem) return mem.slice()
  const diskData = readConversationDisk(key)
  if (diskData && Array.isArray(diskData.messages)) { const recent = diskData.messages.slice(-MEMORY_HISTORY_LIMIT); conversationCache.set(key, recent); return recent.slice() }
  return []
}

function isSameConversationMessage(left: ConversationMessage = {}, right: ConversationMessage = {}): boolean {
  return String(left.role || '') === String(right.role || '') && normalizeText(left.content || '') === normalizeText(right.content || '')
}

function mergeConversationMessages(diskMessages: ConversationMessage[] = [], cachedMessages: ConversationMessage[] = []): ConversationMessage[] {
  const disk = (Array.isArray(diskMessages) ? diskMessages : []).filter(Boolean)
  const cached = (Array.isArray(cachedMessages) ? cachedMessages : []).filter(Boolean)
  if (!cached.length) return disk
  if (!disk.length) return cached.slice()
  let overlap = 0
  const maxOverlap = Math.min(disk.length, cached.length)
  for (let count = maxOverlap; count > 0; count -= 1) {
    let matched = true
    for (let i = 0; i < count; i += 1) {
      if (!isSameConversationMessage(disk[disk.length - count + i], cached[i])) {
        matched = false
        break
      }
    }
    if (matched) {
      overlap = count
      break
    }
  }
  return disk.concat(cached.slice(overlap))
}

function saveConversationTurn(session: SessionLike, userText: string, replyText: string): void {
  const key = getConversationKey(session)
  enqueueWrite(key, () => {
    const diskData = readConversationDisk(key) || { summary: '', summaryTotal: 0, totalCount: 0, messages: [] }
    diskData.messages = mergeConversationMessages(diskData.messages, conversationCache.get(key))
    diskData.totalCount = Math.max(Number(diskData.totalCount || 0), diskData.messages.filter(item => item && item.role === 'user').length)
    const assistantText = normalizeText(replyText)
    const now = Date.now()
    diskData.messages.push(
      { role: 'user', content: userText, messageId: String(session.messageId || ''), ts: now },
      ...(assistantText ? [{ role: 'assistant', content: assistantText, ts: now }] : [])
    ); diskData.totalCount++
    if (diskData.messages.length > MAX_HISTORY_MESSAGES) diskData.messages.splice(0, diskData.messages.length - MAX_HISTORY_MESSAGES)
    conversationCache.set(key, diskData.messages.slice(-MEMORY_HISTORY_LIMIT))
    if (diskData.totalCount % 3 === 0) writeConversationDisk(key, diskData)
    touchConversation(session); saveReplyFingerprint(session, replyText)
    trimConversationRuntimeCaches()
    if (diskData.totalCount > 0 && diskData.totalCount % CONVERSATION_SUMMARY_INTERVAL === 0) generateConversationSummary(key).catch((error) => warnConversationFailure('schedule conversation summary', error))
  })
}

async function generateConversationSummary(key: string): Promise<void> {
  const prev = summaryLocks.get(key) || Promise.resolve()
  const task = prev.then(() => _doGenerateConversationSummary(key)).catch((error) => { warnConversationFailure('conversation summary lock', error) })
  summaryLocks.set(key, task)
  task.finally(() => { if (summaryLocks.get(key) === task) summaryLocks.delete(key) })
  return task
}

function getChatResultContent(resultObj: Awaited<ReturnType<typeof requestChatCompletions>>): string {
  return typeof resultObj === 'string' ? resultObj : (resultObj.type === 'text' ? resultObj.content : '')
}

async function _doGenerateConversationSummary(key: string): Promise<void> {
  const diskData = readConversationDisk(key)
  if (!diskData || !Array.isArray(diskData.messages) || diskData.messages.length < 5 + MEMORY_HISTORY_LIMIT) return
  const targets = diskData.messages.slice(0, Math.max(0, diskData.messages.length - MEMORY_HISTORY_LIMIT))
  const text = targets.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 4000)
  try {
    const cfg = await loadConfig()
    const resultObj = await requestChatCompletions([{ role: 'system', content: '将以下对话压缩成一段200字以内的摘要，保留关键话题变化和重要信息。用中文，用第三人称。' }, { role: 'user', content: text }], cfg, { max_tokens: 300, _fallbackSet: 'lightweight' })
    const result = getChatResultContent(resultObj)
    if (result) {
      const freshData = readConversationDisk(key)
      if (freshData) { freshData.summary = result; freshData.summaryTotal = freshData.totalCount; writeConversationDisk(key, freshData) }
    }
  } catch (error) {
    warnConversationFailure('generate conversation summary', error)
  }
}

function clearConversationHistory(): void { conversationCache = new Map(); replyFingerprintCache = new Map(); conversationLastActiveAt.clear(); conversationCacheAccessAt.clear(); channelSharedCache.clear() }

function clearUserConversationHistory(session: SessionLike): void {
  const key = getConversationKey(session); conversationCache.delete(key); replyFingerprintCache.delete(key); conversationLastActiveAt.delete(key); conversationCacheAccessAt.delete(key)
  for (const safeKey of getConversationFileSafeKeys(key)) {
    try { require('fs').unlinkSync(path.join(CONVERSATIONS_DIR, safeKey + '.json')) } catch { /* non-critical: missing conversation file during clear */
    }
  }
}

function getReplyFingerprintHistory(session: SessionLike): ReplyFingerprintEntry[] { return replyFingerprintCache.get(getConversationKey(session)) || [] }

function saveReplyFingerprint(session: SessionLike, replyText: string): void {
  const key = getConversationKey(session); const history = getReplyFingerprintHistory(session)
  const fp = normalizeText(replyText)
  if (!fp) return
  replyFingerprintCache.set(key, history.concat({ content: fp, createdAt: Date.now() }).slice(-MAX_REPLY_FINGERPRINT_HISTORY))
}

function getRecentAssistantReplies(session: SessionLike, limit: number = MAX_REPEAT_CHECK_HISTORY): string[] { return getReplyFingerprintHistory(session).filter(item => item.content).slice(-limit).map(item => item.content) }

function parseUserMessageEnvelope(content: string = ''): { nickname: string; content: string; wrapped: boolean } {
  const text = String(content || '').trim()
  const wrapped = text.match(/^<user>\r?\n昵称：(.+?)\r?\n发言：([\s\S]*)\r?\n<\/user>$/)
  if (wrapped) return { nickname: wrapped[1].trim(), content: wrapped[2].trim(), wrapped: true }
  const legacy = text.match(/^用户\((.+?)\)[：:]([\s\S]*)$/)
  if (legacy) return { nickname: legacy[1].trim(), content: legacy[2].trim(), wrapped: false }
  return { nickname: '', content: text, wrapped: false }
}

function getUserMessageContent(content: string = ''): string {
  return parseUserMessageEnvelope(content).content
}

function normalizeUserMessageForPrompt(message: ConversationMessage): ConversationMessage {
  if (!message || message.role !== 'user') return message
  const parsed = parseUserMessageEnvelope(message.content)
  if (parsed.wrapped || !parsed.nickname) return message
  return Object.assign({}, message, {
    content: `<user>\n昵称：${parsed.nickname}\n发言：${parsed.content}\n</user>`,
  })
}

function getRecentUserMessages(session: SessionLike, limit: number = 3): string[] { return getConversationHistory(session).filter(m => m.role === 'user').slice(-limit).map(m => getUserMessageContent(m.content)) }

function getRecentUserMessageRecords(session: SessionLike, limit: number = 8): ConversationMessage[] {
  return getConversationHistory(session)
    .filter(m => m && m.role === 'user')
    .slice(-limit)
    .map(m => ({
      role: 'user',
      content: getUserMessageContent(m.content),
      messageId: String(m.messageId || ''),
      ts: Number(m.ts || m.createdAt || 0) || 0,
      meta: m.meta && typeof m.meta === 'object' ? m.meta : undefined,
    }))
}

function looksLikeShortContextFollowUp(text: string = ''): boolean {
  const value = normalizeText(text)
  if (!value) return false
  if (value.length <= 8) return true
  if (value.length <= 18 && /(?:评价一下|怎么看|咋看|真的吗|真的|然后呢|为啥|怎么说|看看|看看你的|讲讲|细说|展开|这个呢|那这个|这图|这张图)/.test(value)) return true
  return false
}

function buildExplicitInteractionFocusNote(currentText: string = '', options: SharedContextOptions = {}): string {
  const explicit = !!(options.directAt || options.nameMentioned || options.isDirect)
  if (!explicit) return ''
  const value = normalizeText(currentText)
  if (!value) return ''
  return [
    '[当前显式交互锚点]',
    `当前用户这条消息是在直接找你说话：${value.slice(0, 160)}`,
    '必须优先回答这条当前消息。旧的群聊背景、你刚才对别人说的话、其他人格回复、转发材料和长期记忆都只能辅助理解，不能覆盖当前用户的主语、问题和情绪。',
    '只有当前消息本身明显在追问上一条公共话题或引用链时，才承接旧话题；否则不要把上一轮对别人的回复续到当前用户身上。',
    '如果当前消息是在质疑或纠正你刚才的回复跑题，先处理这个纠错关系；不要继续展开那条被质疑的旧话题。',
  ].join('\n')
}

function buildRecentPublicTopicNote(items: SharedChannelEntry[] = [], currentUserId: string = '', options: SharedContextOptions = {}): string {
  if (!Array.isArray(items) || !items.length) return ''
  const currentText = normalizeText(options.currentText || '')
  if (!looksLikeShortContextFollowUp(currentText)) return ''
  const currentPersonaName = String(options.personaName || '').trim()
  const recent = items
    .filter(item => item && item.content)
    .slice(-8)
  if (!recent.length) return ''
  const candidates = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const item = recent[i]
    const content = normalizeText(item.content)
    if (!content) continue
    if (item.role === 'assistant') {
      const itemPersona = String(item.personaName || '').trim()
      const samePersona = !currentPersonaName || !itemPersona || itemPersona === currentPersonaName
      candidates.push(samePersona
        ? `你刚才说过：${content.slice(0, 160)}`
        : `其他人格${itemPersona}刚才公开回复：${content.slice(0, 160)}（只作群聊背景，不要继承其口吻）`)
    } else {
      const who = String(item.userId || '') === String(currentUserId || '') ? '当前用户刚才说' : `${item.speakerName || '群友'}刚才说`
      candidates.push(`${who}：${content.slice(0, 160)}`)
    }
    if (candidates.length >= 4) break
  }
  if (!candidates.length) return ''
  return `[短句/指代跟进候选]\n当前用户说"${currentText}"这类短句时，优先承接下面最近公共话题或你刚才说过的话；昵称只用于区分发言者，不是默认评价对象。\n${candidates.reverse().join('\n')}`
}

function flushTodayCacheToDisk(channelKey: string): void {
  const cache = channelTodayCache.get(channelKey)
  if (!cache || !Array.isArray(cache.messages)) return
  trimTodayCacheMessages(cache)
  const safeKey = safeChannelKey(channelKey)
  const tmp = TODAY_CACHE_PREFIX + safeKey + '.tmp'
  const dst = TODAY_CACHE_PREFIX + safeKey + '.json'
  try {
    require('fs').writeFileSync(tmp, JSON.stringify({ date: cache.date, messages: cache.messages }), 'utf8')
    require('fs').renameSync(tmp, dst)
    cache.lastDiskWrite = Date.now()
  } catch (error) {
    warnConversationFailure('flush today cache', error)
  }
}

function saveSharedChannelTurn(session: SessionLike, speakerName: string, content: string, role: string = 'user', metadata: SharedTurnMetadata = {}): void {
  const channelKey = getChannelKey(session)
  const value = redactSensitiveText(normalizeText(content))
  const hasMentions = Array.isArray(metadata.mentionUserIds) && metadata.mentionUserIds.length > 0
  if (!value && !hasMentions) return
  const userId = String(role === 'assistant' ? (session.selfId || session.bot?.selfId || 'bot') : (session.userId || session.author?.id || session.username || 'unknown'))
  const personaName = role === 'assistant' ? sanitizeUserName(String(metadata.personaName || '')).slice(0, 40) : ''
  const entry = { userId, role, speakerName: sanitizeUserName(speakerName || (role === 'assistant' ? '东雪莲' : '群友')), personaName, content: value, messageId: String(metadata.messageId || ''), replyToId: String(metadata.replyToId || ''), mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [], hasMessageRecordCue: !!metadata.hasMessageRecordCue, hasAudio: !!metadata.hasAudio, ts: Date.now() }
  const current = channelSharedCache.get(channelKey) || []
  channelSharedCache.set(channelKey, current.concat(entry).slice(-MAX_CHANNEL_SHARED_MESSAGES))
  appendGroupSceneEntry(channelKey, entry).catch((error) => warnConversationFailure('append group scene entry', error))
  trimChannelRuntimeCaches()
  if (role === 'user' && metadata.fromSummary !== true) {
    try {
      const sw = readJsonFileIfSmallSync(SUMMARY_WHITELIST_FILE, MAX_SMALL_CONFIG_FILE_BYTES, [])
      if (Array.isArray(sw) && sw.includes(String(channelKey))) {
        const today = todayCst(); let cache = channelTodayCache.get(channelKey)
        if (!cache || cache.date !== today) { cache = { date: today, messages: [], updatedAt: Date.now() }; channelTodayCache.set(channelKey, cache) }
        if (value || hasMentions) {
          const displayName = speakerName || userId
          const ts = Date.now()
          cache.updatedAt = ts
          cache.messages.push({
            time: formatShanghaiTime24h(ts),
            ts,
            user: sanitizeUserName(String(displayName)),
            userId,
            content: (value || '').slice(0, MAX_TODAY_CACHE_CONTENT_CHARS),
            messageId: String(metadata.messageId || ''),
            mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [],
          })
          trimTodayCacheMessages(cache)
          const now = Date.now(); const elapsed = now - (cache.lastDiskWrite || 0)
          if (cache.messages.length % 20 === 0 || elapsed > 300000) {
            flushTodayCacheToDisk(channelKey)
          }
        }
      }
    } catch { /* non-critical: today cache side index is optional shared context material */
    }
  }
  if (role === 'user' && value) { saveUserProfile(userId, sanitizeUserName(String(speakerName || '群友')), value, channelKey).catch((error) => warnConversationFailure('save user profile shadow', error)) }
}

async function cleanupDailyStatsFiles(): Promise<{ removed: number; compacted: number }> {
  const cutoffStr = todayCstMinusDays(STATS_FILE_RETENTION_DAYS)
  let files: string[] = []
  try { files = await fsp.readdir(DATA_DIR) } catch { return { removed: 0, compacted: 0 } }
  let removed = 0
  let compacted = 0
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file)
    if (/^today-cache-.+\.json$/.test(file)) {
      try {
        const stat = await fsp.stat(filePath).catch(() => null)
        if (!stat || !stat.isFile()) continue
        if (stat.size > MAX_DAILY_STATS_FILE_BYTES) {
          await fsp.unlink(filePath).catch((error) => warnConversationFailure('remove oversized today cache', error))
          removed += 1
          continue
        }
        const data = await readJsonFile(filePath, null)
        if (data && typeof data.date === 'string' && data.date < cutoffStr) {
          await fsp.unlink(filePath)
          removed += 1
        }
      } catch { /* non-critical: continue daily stats cleanup when one cache file is unreadable */
      }
      continue
    }
    if (/^emotion-history-.+\.json$/.test(file)) {
      try {
        const stat = await fsp.stat(filePath).catch(() => null)
        if (!stat || !stat.isFile()) continue
        if (stat.size > MAX_DAILY_STATS_FILE_BYTES) {
          await fsp.unlink(filePath).catch((error) => warnConversationFailure('remove oversized emotion history', error))
          removed += 1
          continue
        }
        const data = await readJsonFile(filePath, null)
        if (!Array.isArray(data)) continue
        const filtered = data.filter(item => item && typeof item.date === 'string' && item.date >= cutoffStr)
        if (filtered.length !== data.length) {
          if (filtered.length) await writeJsonFile(filePath, filtered)
          else await fsp.unlink(filePath)
          compacted += 1
        }
      } catch { /* non-critical: continue daily stats cleanup when one emotion history file is unreadable */
      }
    }
  }
  trimChannelRuntimeCaches()
  return { removed, compacted }
}

async function saveUserProfile(userId: string, name: string, content: string, channelKey: string): Promise<void> {
  if (!userId || userId === 'unknown') return
  const safeKey = safeChannelKey(channelKey); const dir = path.join(USER_PROFILE_DIR, safeKey)
  try { require('fs').mkdirSync(dir, { recursive: true }) } catch (error) { warnConversationFailure('create user profile dir', error) }
  const file = path.join(dir, String(userId) + '.json')
  let data = readJsonFileIfSmallSync<UserProfileData>(file, MAX_USER_PROFILE_FILE_BYTES, { userId, names: [], messages: [] }, { unlinkOversize: true })
  data.userId = String(userId)
  if (name && !data.names.includes(name)) data.names.push(name)
  data.messages.push({ time: new Date().toLocaleString(), content })
  if (data.messages.length > 30) data.messages.splice(0, data.messages.length - 30)
  if (!Array.isArray(data.memory)) data.memory = []
  await writeJsonFile(file, data)
}

async function writeMemory(userId: string, name: string, channelKey: string, text: string): Promise<void> {
  const safeKey = safeChannelKey(channelKey)
  const dir = path.join(USER_PROFILE_DIR, safeKey)
  try { require('fs').mkdirSync(dir, { recursive: true }) } catch (error) { warnConversationFailure('create memory dir', error) }
  const file = path.join(dir, String(userId) + '.json')
  let data = readJsonFileIfSmallSync<UserProfileData>(file, MAX_USER_PROFILE_FILE_BYTES, { userId, names: [], messages: [], memory: [] }, { unlinkOversize: true })
  data.userId = String(userId)
  if (!Array.isArray(data.memory)) data.memory = []
  const existing = data.memory.findIndex(function(m) { return m.text === text })
  if (existing >= 0) { data.memory[existing].ts = Date.now(); data.memory[existing].confirmCount = (data.memory[existing].confirmCount || 0) + 1 }
  else { data.memory.push({ text: text, ts: Date.now(), confirmCount: 1 }) }
  if (data.memory.length > 10) data.memory.splice(0, data.memory.length - 10)
  await writeJsonFile(file, data)
}

async function deleteMemory(userId: string, channelKey: string, text: string): Promise<void> {
  const safeKey = safeChannelKey(channelKey)
  const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json')
  const data = readJsonFileIfSmallSync<UserProfileData | null>(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true })
  if (!data || !Array.isArray(data.memory)) return
  data.memory = data.memory.filter(function(m) { return m.text !== text })
  await writeJsonFile(file, data)
}

async function clearUserMemory(userId: string, channelKey: string): Promise<void> {
  const safeKey = safeChannelKey(channelKey)
  const file = path.join(USER_PROFILE_DIR, safeKey, userId + '.json')
  try {
    const data = readJsonFileIfSmallSync<UserProfileData | null>(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true })
    if (data && Array.isArray(data.memory)) {
      data.memory = []
      await writeJsonFile(file, data)
    }
  } catch { /* non-critical: clear user memory is best-effort admin cleanup */
  }
}

async function clearGroupMemory(channelKey: string): Promise<void> {
  const safeKey = safeChannelKey(channelKey)
  const dir = path.join(USER_PROFILE_DIR, safeKey)
  try {
    const files = await fsp.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(dir, file)
      try {
        const data = readJsonFileIfSmallSync<UserProfileData | null>(filePath, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true })
        if (data && Array.isArray(data.memory)) {
          data.memory = []
          await writeJsonFile(filePath, data)
        }
      } catch { /* non-critical: continue clearing remaining user memory files */
      }
    }
  } catch { /* non-critical: missing group memory directory means nothing to clear */
  }
}

async function getMemorySummary(userId: string, channelKey: string): Promise<string> {
  const safeKey = safeChannelKey(channelKey)
  const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json')
  const data = readJsonFileIfSmallSync<UserProfileData | null>(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true })
  if (!data || !Array.isArray(data.memory) || !data.memory.length) return ''
  const confirmed = data.memory.filter(function(m) { return (m.confirmCount || 0) > 0 }).slice(-3)
  if (!confirmed.length) return ''
  return '记住的：' + confirmed.map(function(m) { return m.text }).join('、')
}

function findChannelMessageById(channelKey: string, messageId: string = ''): SharedChannelEntry | null {
  if (!messageId) return null; const items = channelSharedCache.get(channelKey) || []; return items.find(i => String(i.messageId || '') === String(messageId)) || null
}

function collectReplyChain(channelKey: string, replyToId: string = ''): SharedChannelEntry[] {
  if (!replyToId) return []; const result: SharedChannelEntry[] = []; let currentId = replyToId; const maxDepth = MAX_REPLY_CHAIN_DEPTH; const visited = new Set<string>()
  for (let i = 0; i < maxDepth; i++) { if (visited.has(String(currentId))) break; visited.add(String(currentId)); const msg = findChannelMessageById(channelKey, currentId); if (!msg) break; result.push(msg); currentId = msg.replyToId }
  return result
}

function extractQuoteAuthorId(session: SessionLike): string {
  const q = session && session.quote || {}
  const author = q.author
  return String(q.userId || q.user_id || q.user?.id || (typeof author === 'object' ? author?.id : '') || q.authorId || q.sender?.userId || q.sender?.id || '')
}

function extractQuoteAuthorName(session: SessionLike): string {
  const q = session && session.quote || {}
  const author = q.author
  if (typeof author === 'string') return author
  return String(q.nickname || q.nick || q.sender?.nickname || q.sender?.card || q.sender?.name || author?.nick || author?.name || q.userId || '')
}

function getQuoteMessageId(session: SessionLike, options: SharedContextOptions = {}): string {
  const q = session && session.quote || {}
  return String(options.replyToId || q.id || q.messageId || q.message_id || q.message?.id || '')
}

function getQuoteContentText(session: SessionLike): string {
  const q = session && session.quote || {}
  if (!q) return ''
  if (typeof q.content === 'string') return q.content
  if (Array.isArray(q.content)) {
    return q.content.map(function(s) {
      if (s.type === 'text') return s.data && s.data.text || ''
      if (s.type === 'image') return '[图片]'
      if (s.type === 'face') return '[表情]'
      if (s.type === 'at') return '@' + (s.data && (s.data.name || s.data.qq || s.data.id || ''))
      if (s.type === 'forward') return '[转发消息]'
      if (s.type === 'video') return '[视频]'
      if (s.type === 'record') return (s.data && s.data._transcribedText) ? `[语音转文字：${s.data._transcribedText}]` : '[语音]'
      if (s.type === 'file') return '[文件]'
      return '[消息]'
    }).filter(Boolean).join('')
  }
  return q.raw_message || q.text || ''
}

function getQuoteInfo(session: SessionLike, options: SharedContextOptions = {}): QuoteInfo {
  const content = getQuoteContentText(session)
  if (!content) return { content: '', authorName: '', authorId: '', messageId: '', isSelf: false, matchedMessage: null }
  const channelKey = getChannelKey(session)
  const messageId = getQuoteMessageId(session, options)
  const matchedMessage = messageId ? findChannelMessageById(channelKey, messageId) : null
  const selfId = String(session?.selfId || session?.bot?.selfId || '')
  const authorId = extractQuoteAuthorId(session)
  const isSelf = !!(matchedMessage?.role === 'assistant' || (selfId && authorId && authorId === selfId))
  return {
    content,
    authorName: extractQuoteAuthorName(session) || (isSelf ? '东雪莲' : ''),
    authorId,
    messageId,
    isSelf,
    matchedMessage,
  }
}

function escapePromptBoundaryText(text: string = ''): string {
  return redactSensitiveText(String(text || ''))
    .replace(/[<>]/g, ch => (ch === '<' ? '＜' : '＞'))
}

function getQuotedMessageNote(session: SessionLike, options: SharedContextOptions = {}): string {
  const quoteInfo = getQuoteInfo(session, options)
  if (!quoteInfo.content) return ''
  const qtext = escapePromptBoundaryText(quoteInfo.content)
  const recent = getConversationHistory(session).slice(-MAX_CHANNEL_PROMPT_MESSAGES)
  const match = recent.find(m => m.content && (qtext.includes(m.content.slice(0, 30)) || m.content.includes(qtext.slice(0, 30))))
  if (match) return '' // already in history
  if (quoteInfo.isSelf) {
    return `[引用你自己的历史回复]\n${qtext.slice(0, 160)}\n以上内容是你自己之前说过的话，不是当前用户说的；不要把它当成群友观点，也不要攻击自己。`
  }
  return `[引用消息]\n${qtext.slice(0, 100)}`
}

function getSharedContextNote(session: SessionLike, currentUserId: string = '', options: SharedContextOptions = {}): string {
  const channelKey = getChannelKey(session); const items = (channelSharedCache.get(channelKey) || []).filter(item => item.content)
  const explicitFocusNote = buildExplicitInteractionFocusNote(options.currentText || '', options)
  if (!items.length) return explicitFocusNote
  const replyChain = collectReplyChain(channelKey, String(options.replyToId || ''))
  const focusUserIds = new Set([String(currentUserId || '')].filter(Boolean)); const focusMessageIds = new Set()
  const mentionUserIds = Array.isArray(options.mentionUserIds) ? options.mentionUserIds.map(String).filter(Boolean) : []
  const shortTopicNote = buildRecentPublicTopicNote(items, currentUserId, options)
  mentionUserIds.forEach(u => focusUserIds.add(u)); replyChain.forEach(item => { if (item.userId) focusUserIds.add(String(item.userId)); if (item.messageId) focusMessageIds.add(String(item.messageId)) })
  if (!replyChain.length && currentUserId) { items.slice(-MAX_THREAD_CONTEXT_MESSAGES).filter(item => item.userId !== currentUserId && item.mentionUserIds.includes(currentUserId)).forEach(item => { if (item.userId) focusUserIds.add(String(item.userId)); item.mentionUserIds.forEach(u => focusUserIds.add(String(u))) }) }
  let scoped = items.filter(item => { if (item.role === 'assistant' && !focusMessageIds.has(String(item.messageId || ''))) return false; if (focusMessageIds.has(String(item.messageId || ''))) return true; if (focusUserIds.has(String(item.userId || ''))) return true; return item.mentionUserIds.some(u => focusUserIds.has(String(u))) })
  if (!scoped.length && options.randomTriggered && currentUserId) scoped = items.filter(item => item.role !== 'assistant' && item.userId === currentUserId)
  if (!scoped.length) scoped = items.filter(item => item.role !== 'assistant').slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES))
  if (shortTopicNote) {
    const recentForShort = items.slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES))
    const seen = new Set(scoped.map(item => String(item.messageId || '') + ':' + item.role + ':' + item.content))
    for (const item of recentForShort) {
      const key = String(item.messageId || '') + ':' + item.role + ':' + item.content
      if (!seen.has(key)) scoped.push(item)
    }
  }
  const IDLE_GAP_MS = 10 * 60 * 1000
  const itemsToMap = scoped.slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES))
  const lines = []
  for (let i = 0; i < itemsToMap.length; i++) {
    if (i > 0 && itemsToMap[i].ts && itemsToMap[i - 1].ts && itemsToMap[i].ts - itemsToMap[i - 1].ts > IDLE_GAP_MS) {
      lines.push('[--- 以下是与当前无关的旧消息 ---]')
    }
    const personaLabel = itemsToMap[i].role === 'assistant' && itemsToMap[i].personaName
      ? `bot人格:${itemsToMap[i].personaName}`
      : (itemsToMap[i].role === 'assistant' ? 'bot' : '群友')
    lines.push(`${itemsToMap[i].speakerName}(${personaLabel})：${itemsToMap[i].content}`)
  }
  if (!lines.length) return explicitFocusNote
  return `${explicitFocusNote ? `${explicitFocusNote}\n` : ''}[群聊当前话题背景]\n下面只保留当前回复链、当前参与者或短句跟进可能需要的纯文本消息。优先理解最近公共话题和明确回复链，不要把昵称当成默认评价对象。\n${shortTopicNote ? `${shortTopicNote}\n` : ''}${lines.join('\n')}`
}

function saveSensitiveCache(channelKey: string, value: string, speakerName: string, userId: string): void {
  const safeKey = safeChannelKey(channelKey); const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json'
  const entry = { speakerName, userId, content: String(value || '').slice(0, 500), ts: Date.now() }
  try {
    const fs = require('fs')
    let data: SensitiveCacheData = {}
    const stat = fs.statSync(file)
    if (stat.isFile() && stat.size <= MAX_SENSITIVE_CACHE_FILE_BYTES) data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}')
    if (!Array.isArray(data.messages)) data.messages = []
    data.messages.push(entry)
    data.messages = data.messages.slice(-MAX_SENSITIVE_CACHE_MESSAGES)
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') warnConversationFailure('save sensitive cache', error)
    try { require('fs').writeFileSync(file, JSON.stringify({ messages: [entry] }), 'utf8') } catch (fallbackError) { warnConversationFailure('save sensitive cache fallback', fallbackError) }
  }
}

async function analyzeChannelSensitive(channelKey: string): Promise<void> {
  const safeKey = safeChannelKey(channelKey); const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json'
  try {
    const fs = require('fs')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SENSITIVE_CACHE_FILE_BYTES) { try { fs.unlinkSync(file) } catch { /* non-critical: best-effort oversized sensitive cache cleanup */ }; return }
    const raw = fs.readFileSync(file, 'utf8'); const data = JSON.parse(raw) as SensitiveCacheData
    if (!data || !Array.isArray(data.messages) || data.messages.length < 5) return
    const text = data.messages.slice(-30).map(m => `${m.userId ? m.speakerName + '：' : ''}${m.content}`).join('\n').slice(0, 3000)
    const prompt = ['你是一个群聊内容审查员。你的任务是判断一条消息是否包含"明显违规的政治攻击性内容"。', '请严格按照下面规则执行。', '', '一、任务目标', '你只需要做一件事：判断消息里是否存在明显的、带恶意的、指向政治制度、执政党、政治体系、敏感政治事件、政治人物或政治权威机构的攻击、讽刺、影射、谣言传播或煽动性表达。', '如果有，回复：SENSITIVE；如果没有，回复：CLEAN', '除了这一个词，不要输出任何别的内容。', '', '二、什么算违规政治内容', '以下内容，原则上判为 SENSITIVE：', '1. 用隐喻、反讽、谐音、缩写、代称、梗图话术等方式，明显攻击政治制度、执政党或政治体系。', '2. 阴阳怪气地讨论敏感政治事件、政治决策、政治路线，并且带有明显恶意导向。', '3. 传播针对政治体系、政治权威、执政组织或国家治理的恶意谣言、编造信息、煽动性说法。', '4. 对政治人物、领导人、政权机构进行明显侮辱、辱骂、嘲讽或恶意丑化。', '5. 借社会议题、公共事件、历史事件进行明显政治影射，并且攻击指向清晰。', '6. 表面像玩笑、段子或梗，实质是在影射、贬损、讽刺政治体制或敏感政治对象。', '7. 使用"大家都懂""不能明说""你品你细品"之类表达，配合上下文明显指向政治攻击。', '8. 借转述、引用、截图描述等形式，继续传播带恶意的政治讽刺、政治攻击或政治谣言。', '', '三、什么不算违规政治内容', '以下内容，原则上判为 CLEAN：', '1. 日常吐槽工作压力、生活压力、学习压力、工资低、加班多、就业难、房租高、物价高等社会生活问题。', '2. 正常讨论劳动法、社保、公积金、教育、医疗、经济、就业、税收等公共政策，只要语气中性，没有明显政治攻击。', '3. 单纯提到国家、政府、领导人、部门、政策、新闻事件，但语气客观、中立、正面，或只是事实陈述。', '4. 对具体办事流程、行政服务、城市管理、企业经营、学校制度的普通抱怨，如果没有明显上升到政治恶意攻击。', '5. 网络段子、玩梗、夸张吐槽、情绪发泄，只要没有明确政治指向，或政治指向不清晰。', '6. 对现实环境表达失望、无奈、疲惫、抱怨，只要主要是在说个人处境，而不是借机攻击政治体系。', '7. 讨论历史、国际关系、法律法规、时事新闻，只要表达方式正常，不带明显侮辱、煽动、恶意讽刺。', '8. 批评某个具体社会现象、公司、平台、行业、学校、单位、地方执行问题，但没有清楚指向政治制度攻击。', '', '四、重点判定原则', '1. 只抓"明显恶意"。2. 不确定就放过。3. 宁可漏过，不要误报。4. 核心不是看内容负面不负面，而是看这种负面是否明确指向政治制度、执政组织、政治人物或敏感政治议题，并且带明显恶意。5. 不要过度联想。', '五、容易误判的情况：以下通常应判 CLEAN：普通骂生活苦；对某个具体规定有意见；使用夸张、反话、玩梗语气但不足以证明在攻击政治。', '六、输出要求：只能输出以下两种结果之一：SENSITIVE 或 CLEAN。不要输出解释。', ''].join('\n')
    const messages = [{ role: 'system', content: prompt }, { role: 'user', content: text }]
    let result = ''
    const models = [
      { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
      { provider: 'dashscope', model: 'qwen-turbo', keyFile: DASHSCOPE_KEY_FILE },
      { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: DASHSCOPE_KEY_FILE },
      { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: null },
    ]
    for (const am of models) {
      const provDef = PROVIDERS[am.provider]; if (!provDef) continue
      try {
        const cfg = await loadConfig()
        const apiKey = am.keyFile ? (await readTextFile(am.keyFile).catch(() => '') || cfg.apiKey).replace(/[\r\n]+/g, '') : cfg.apiKey
        if (!apiKey) continue
        result = getChatResultContent(await requestChatCompletions(messages, { model: am.model, baseURL: provDef.baseURL.replace(/\/+$/, ''), apiKey, provider: am.provider }, { max_tokens: 20, _fallbackSet: 'lightweight' }))
        if (result) break
      } catch (error) {
        warnConversationFailure('analyze sensitive cache model call', error)
      }
    }
    if (/SENSITIVE/i.test(result)) { pendingSensitiveAlert.set(channelKey, { flagged: true, ts: Date.now() }) }
    try { require('fs').unlinkSync(file) } catch { /* non-critical: best-effort sensitive cache cleanup after analysis */
    }
  } catch (error) {
    warnConversationFailure('analyze sensitive cache', error)
  }
}

const MEMORY_TIMER_DIR = path.join(DATA_DIR, 'memory-timers')

function getMemoryTimerKey(channelKey: string): string {
  return safeChannelKey(channelKey)
}

function readMemoryTimer(channelKey: string): MemoryTimerData | null {
  const file = path.join(MEMORY_TIMER_DIR, getMemoryTimerKey(channelKey) + '.json')
  try {
    const data = readJsonFileIfSmallSync<MemoryTimerData | null>(file, MAX_SMALL_CONFIG_FILE_BYTES, null, { unlinkOversize: true })
    if (data && data.intervalHours > 0 && data.intervalHours <= 168) return data
  } catch { /* non-critical: missing or malformed memory timer disables timer */
  }
  return null
}

function checkMemoryTimerExpired(channelKey: string): boolean {
  const timer = readMemoryTimer(channelKey)
  if (!timer) return false
  const elapsed = Date.now() - (timer.lastClearTs || 0)
  return elapsed >= timer.intervalHours * 3600 * 1000
}

export = {
  conversationCache, replyFingerprintCache,
  conversationLastActiveAt, conversationCacheAccessAt, channelSharedCache, lastForwardSummaryCache,
  setLastForwardSummaryCache,
  pendingSensitiveAlert, channelTodayCache,
  getConversationKey, getChannelKey, touchConversation, touchConversationAccess,
  readConversationDisk, writeConversationDisk, replaceImagePlaceholderInConversation,
  getConversationHistory, saveConversationTurn, mergeConversationMessages, generateConversationSummary,
  clearConversationHistory, clearUserConversationHistory,
  getReplyFingerprintHistory, saveReplyFingerprint,
  getRecentAssistantReplies, getRecentUserMessages, getRecentUserMessageRecords,
  parseUserMessageEnvelope, getUserMessageContent, normalizeUserMessageForPrompt,
  saveSharedChannelTurn,
  findChannelMessageById, collectReplyChain,
  getQuoteContentText, getQuoteInfo, getQuotedMessageNote, getSharedContextNote,
  saveUserProfile, saveSensitiveCache, analyzeChannelSensitive,
  writeMemory, deleteMemory, clearUserMemory, clearGroupMemory, getMemorySummary,
  readMemoryTimer, checkMemoryTimerExpired,
  flushTodayCacheToDisk,
  trimChannelRuntimeCaches, trimConversationRuntimeCaches, cleanupDailyStatsFiles,
}
