/**
 * MODULE: 语音转写历史存储。
 * 职责: 存储入站语音元数据、转写状态和转写文本。
 * 边界: 不下载语音、不转码、不调用 ASR 模型、不发送消息。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { getSafeMediaStorageKey: getSafeKey, getMediaHistoryFilePath } = require('../storage-key') as typeof import('../storage-key')

const VOICE_HISTORY_DIR: string = path.join(DATA_DIR, 'voice-history')
const VOICE_EXPIRE_MS = 4 * 60 * 60 * 1000
const VOICE_TRANSCRIBED_EXPIRE_MS = 24 * 60 * 60 * 1000
const MAX_VOICES_PER_CHANNEL = 40
const MAX_VOICE_HISTORY_BYTES = 256 * 1024

interface VoiceEntry {
  url: string
  file: string | null
  conversationKey: string
  userId: string
  ts: number
  transcribed: boolean
  transcript: string | null
  transcriptionStatus: string
}

interface VoiceHistoryData {
  voices: Record<string, VoiceEntry>
}

interface StoreVoiceMeta {
  url?: unknown
  file?: unknown
  conversationKey?: unknown
  userId?: unknown
}

interface VoiceStoreError {
  code?: string
}

const voiceHistoryCache: Map<string, VoiceHistoryData> = new Map()
const voiceStoreQueues: Map<string, Promise<unknown>> = new Map()

// 返回队列 key，保证同一频道写入串行。
function getVoiceQueueKey(channelKey: unknown): string {
  return getSafeKey(channelKey) || 'unknown'
}

// 忽略前序写入失败，避免队列永久卡死。
function ignoreVoiceStoreQueueFailure(): void {
  // non-critical: keep per-channel voice store queue alive after previous failure
}

// 串行执行同一频道的 voice-store 操作。
function enqueueVoiceStoreTask<T>(channelKey: unknown, task: () => Promise<T>): Promise<T> {
  const key = getVoiceQueueKey(channelKey)
  const previous = voiceStoreQueues.get(key) || Promise.resolve()
  const current = previous.catch(ignoreVoiceStoreQueueFailure).then(task)
  const cleanup = current.finally(() => {
    if (voiceStoreQueues.get(key) === cleanup) voiceStoreQueues.delete(key)
  }).catch(ignoreVoiceStoreQueueFailure)
  voiceStoreQueues.set(key, cleanup)
  return current
}

// 将任意 JSON 项归一为 VoiceEntry。
function normalizeVoiceEntry(entry: unknown): VoiceEntry | null {
  if (!entry || typeof entry !== 'object') return null
  const data = entry as Record<string, unknown>
  return {
    url: String(data.url || ''),
    file: data.file ? String(data.file) : null,
    conversationKey: data.conversationKey ? String(data.conversationKey) : '',
    userId: data.userId ? String(data.userId) : '',
    ts: Number(data.ts) || 0,
    transcribed: !!data.transcribed,
    transcript: data.transcript == null ? null : String(data.transcript),
    transcriptionStatus: String(data.transcriptionStatus || (data.transcribed ? 'transcribed' : 'pending')).slice(0, 40),
  }
}

// 归一语音历史 JSON 结构。
function normalizeVoiceHistoryData(data: unknown): VoiceHistoryData {
  const voices: Record<string, VoiceEntry> = {}
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const source = record.voices && typeof record.voices === 'object'
    ? record.voices as Record<string, unknown>
    : {}
  for (const [id, entry] of Object.entries(source)) {
    const normalized = normalizeVoiceEntry(entry)
    if (normalized) voices[String(id)] = normalized
  }
  return { voices }
}

// 清理过期语音记录并限制单频道数量。
function cleanExpiredVoices(data: VoiceHistoryData): VoiceHistoryData {
  const now = Date.now()
  const voices = data.voices || {}
  for (const id of Object.keys(voices)) {
    const expiry = voices[id].transcribed ? VOICE_TRANSCRIBED_EXPIRE_MS : VOICE_EXPIRE_MS
    if (now - (voices[id].ts || 0) > expiry) delete voices[id]
  }
  const keys = Object.keys(voices)
  if (keys.length > MAX_VOICES_PER_CHANNEL) {
    keys.sort((a, b) => (voices[a].ts || 0) - (voices[b].ts || 0))
    for (let i = 0; i < keys.length - MAX_VOICES_PER_CHANNEL; i++) delete voices[keys[i]]
  }
  data.voices = voices
  return data
}

// 读取频道语音历史；异常时回退到内存缓存或空结构。
async function readVoiceHistory(channelKey: unknown): Promise<VoiceHistoryData> {
  const cacheKey = getVoiceQueueKey(channelKey)
  try {
    await fs.mkdir(VOICE_HISTORY_DIR, { recursive: true })
    const file = getMediaHistoryFilePath(VOICE_HISTORY_DIR, channelKey)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_VOICE_HISTORY_BYTES) return { voices: {} }
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    const data = normalizeVoiceHistoryData(parsed)
    voiceHistoryCache.set(cacheKey, data)
    return data
  } catch (error) {
    if (error && (error as VoiceStoreError).code === 'ENOENT') {
      voiceHistoryCache.delete(cacheKey)
      return { voices: {} }
    }
    const cached = voiceHistoryCache.get(cacheKey)
    return cached ? normalizeVoiceHistoryData(cached) : { voices: {} }
  }
}

// 写入频道语音历史。
async function writeVoiceHistory(channelKey: unknown, data: VoiceHistoryData): Promise<boolean> {
  try {
    await fs.mkdir(VOICE_HISTORY_DIR, { recursive: true })
    const normalized = normalizeVoiceHistoryData(data)
    await fs.writeFile(getMediaHistoryFilePath(VOICE_HISTORY_DIR, channelKey), JSON.stringify(normalized), 'utf8')
    voiceHistoryCache.set(getVoiceQueueKey(channelKey), normalized)
    return true
  } catch (error) {
    console.warn(`[voice-store] write history failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// 保存入站语音元信息；不执行 ASR。
async function storeVoice(channelKey: string, messageId: string, meta: StoreVoiceMeta = {}): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueVoiceStoreTask(channelKey, async () => {
    const data = cleanExpiredVoices(await readVoiceHistory(channelKey))
    const id = String(messageId)
    if (data.voices[id]) {
      let changed = false
      if (meta.url && !data.voices[id].url) {
        data.voices[id].url = String(meta.url)
        changed = true
      }
      if (meta.file && !data.voices[id].file) {
        data.voices[id].file = String(meta.file)
        changed = true
      }
      return changed ? writeVoiceHistory(channelKey, data) : false
    }
    data.voices[id] = {
      url: String(meta.url || ''),
      file: meta.file ? String(meta.file) : null,
      conversationKey: meta.conversationKey ? String(meta.conversationKey) : '',
      userId: meta.userId ? String(meta.userId) : '',
      ts: Date.now(),
      transcribed: false,
      transcript: null,
      transcriptionStatus: 'pending',
    }
    return writeVoiceHistory(channelKey, data)
  })
}

// 读取单条语音记录。
async function getVoiceEntry(channelKey: string, messageId: string): Promise<VoiceEntry | null> {
  if (!channelKey || !messageId) return null
  return enqueueVoiceStoreTask(channelKey, async () => {
    const data = cleanExpiredVoices(await readVoiceHistory(channelKey))
    const entry = data.voices[String(messageId)] || null
    return entry ? { ...entry } : null
  })
}

// 读取已缓存的转写文本。
async function getCachedTranscript(channelKey: string, messageId: string): Promise<string | null> {
  const entry = await getVoiceEntry(channelKey, messageId)
  return entry && entry.transcribed && entry.transcript ? entry.transcript : null
}

// 标记语音已转写。
async function markVoiceTranscribed(channelKey: string, messageId: string, transcript: unknown): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueVoiceStoreTask(channelKey, async () => {
    const data = await readVoiceHistory(channelKey)
    const id = String(messageId)
    if (!data.voices[id]) return false
    const text = String(transcript || '').trim().slice(0, 1000)
    data.voices[id].transcribed = !!text
    data.voices[id].transcript = text || null
    data.voices[id].transcriptionStatus = text ? 'transcribed' : 'empty'
    return writeVoiceHistory(channelKey, data)
  })
}

// 标记语音转写不可用或失败。
async function markVoiceTranscriptionUnavailable(channelKey: string, messageId: string, status: unknown = 'unavailable'): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueVoiceStoreTask(channelKey, async () => {
    const data = await readVoiceHistory(channelKey)
    const id = String(messageId)
    if (!data.voices[id]) return false
    data.voices[id].transcribed = false
    data.voices[id].transcript = null
    data.voices[id].transcriptionStatus = String(status || 'unavailable').slice(0, 40)
    return writeVoiceHistory(channelKey, data)
  })
}

export = {
  VOICE_HISTORY_DIR,
  storeVoice,
  getVoiceEntry,
  getCachedTranscript,
  markVoiceTranscribed,
  markVoiceTranscriptionUnavailable,
}
