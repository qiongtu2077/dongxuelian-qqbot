/**
 * MODULE: 语音合成（TTS）。
 * 职责: 调 MiMo TTS API 合成语音 → 发送 QQ record 消息段。
 * 边界: 不写对话历史、不改 conversation。只负责合成和发送。
 * 状态: 频道冷却 Map（内存，5 分钟过期）。
 */
const { TTS_TEMP_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { resolveCapabilityRuntimeSteps } = require('../../core/ai-capability-config') as typeof import('../../core/ai-capability-config')
const { notifyCapabilityStepFailure } = require('../../core/capability-failure-notifier') as typeof import('../../core/capability-failure-notifier')
const { recordTokenUsage } = require('../../core/api') as typeof import('../../core/api')
const { resolveVoiceSampleFile } = require('./voice-assets') as typeof import('./voice-assets')
const { resolvePersonaRuntimePlan } = require('../../persona/persona-runtime-plan') as typeof import('../../persona/persona-runtime-plan')
const { DEFAULT_RANDOM_VOICE_RATE, getRandomVoiceRate } = require('../../behavior/random-voice-rate') as typeof import('../../behavior/random-voice-rate')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const TTS_TIMEOUT_MS = 15000
const DEFAULT_VOICE = '冰糖'
const NEUTRAL_TTS_STYLE = '自然清晰，语气稳定，情绪适度，贴合文本内容；不要夸张表演，不要强行卖萌，不要改变角色人设。'
const MAX_TTS_TEXT_LENGTH = 300
const MAX_TTS_STYLE_LENGTH = 240
const COMPOSED_STYLE_GUARD = '保持当前人格，不要脱离人设，不要因为临时语气变成另一种人格。'
const CHANNEL_COOLDOWN_MS = 5 * 60 * 1000
const RANDOM_VOICE_RATE: number = DEFAULT_RANDOM_VOICE_RATE
const DEFAULT_TTS_SEND_FILE_TTL_MS = 10 * 60 * 1000
const TTS_SEND_FILE_TTL_MS = (() => {
  const value = Number(process.env.TTS_SEND_FILE_TTL_MS || DEFAULT_TTS_SEND_FILE_TTL_MS)
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_TTS_SEND_FILE_TTL_MS
})()

const BUILTIN_VOICES: string[] = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default']
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'])

const channelCooldowns: Map<string, number> = new Map()

const VOICE_STYLE_RE: RegExp = /【语音风格[：:]([^】]+)】/
const DATA_URI_RE: RegExp = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i
const TTS_SEND_TEMP_PREFIX = 'tts-send-'

interface TtsFailure {
  code: string
  message: string
  status?: number
  model?: string
  declaredMime?: string
  bytes?: number
  [key: string]: unknown
}

interface TtsDiagnostics {
  lastError?: TtsFailure
  lastSend?: Record<string, unknown>
}

interface TtsLogger {
  warn(message: string): void
}

interface TtsOptions {
  voice?: string
  style?: unknown
  diagnostics?: TtsDiagnostics
  onDiagnostic?: (failure: TtsFailure) => void
  logger?: TtsLogger
  context?: string
  tempFileTtlMs?: number
  plan?: PersonaRuntimePlanLike
}

interface PersonaRuntimePlanLike {
  name?: string | null
  voice?: {
    rawId?: string
    assetId?: string
    style?: string
  }
}

interface ResolvedPersonaVoice {
  voice: string
  style: string
}

interface DecodedAudioData {
  buffer?: AudioBufferWithMime
  declaredMime?: string
  error?: string
}

interface AudioBufferWithMime extends Buffer {
  mimeType?: string
}

interface TtsSessionLike {
  send(content: unknown): unknown | Promise<unknown>
}

interface FetchResponseLike {
  ok: boolean
  status: number
  text?: () => Promise<string>
  json(): Promise<unknown>
}

// 从 voice-tts 能力链读取小米 Key，仅保留给既有诊断与测试入口。
async function getMimoriumKey(): Promise<string> {
  const step = resolveCapabilityRuntimeSteps('voice-tts').find(item => item.provider === 'mimorium')
  return String(step?.apiKey || '')
}

function sanitizeDiagnosticText(value: unknown, maxLength: number = 240): string {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|tp)-[A-Za-z0-9._~+/=-]{8,}\b/g, '[redacted-key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function sanitizeTtsStyle(value: unknown, fallback: string = ''): string {
  const text = String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|tp)-[A-Za-z0-9._~+/=-]{8,}\b/g, '[redacted-key]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const style = text || String(fallback || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return style.slice(0, MAX_TTS_STYLE_LENGTH)
}

function composeTtsStyle(baseStyle: unknown, temporaryStyle: unknown): string {
  const base = sanitizeTtsStyle(baseStyle)
  const temporary = sanitizeTtsStyle(temporaryStyle)
  if (base && temporary) {
    const basePrefix = '人格基础语音风格：'
    const temporaryPrefix = '本句临时语气：'
    const fixedLength = basePrefix.length + temporaryPrefix.length + COMPOSED_STYLE_GUARD.length + 2
    const budget = Math.max(0, MAX_TTS_STYLE_LENGTH - fixedLength)
    let baseBudget = Math.min(base.length, Math.ceil(budget * 0.65))
    let temporaryBudget = Math.min(temporary.length, budget - baseBudget)
    let spare = budget - baseBudget - temporaryBudget
    if (spare > 0 && baseBudget < base.length) {
      const extra = Math.min(spare, base.length - baseBudget)
      baseBudget += extra
      spare -= extra
    }
    if (spare > 0 && temporaryBudget < temporary.length) {
      temporaryBudget += Math.min(spare, temporary.length - temporaryBudget)
    }
    return [
      `${basePrefix}${base.slice(0, baseBudget)}`,
      `${temporaryPrefix}${temporary.slice(0, temporaryBudget)}`,
      COMPOSED_STYLE_GUARD,
    ].join('\n')
  }
  if (base) return base
  if (temporary) {
    const temporaryPrefix = '本句临时语气：'
    const budget = Math.max(0, MAX_TTS_STYLE_LENGTH - temporaryPrefix.length - COMPOSED_STYLE_GUARD.length - 1)
    return [
      `${temporaryPrefix}${temporary.slice(0, budget)}`,
      COMPOSED_STYLE_GUARD,
    ].join('\n')
  }
  return NEUTRAL_TTS_STYLE
}

function recordTtsFailure(options: TtsOptions | null | undefined, code: string, message: unknown, details: Record<string, unknown> = {}): null {
  const failure: TtsFailure = {
    code,
    message: sanitizeDiagnosticText(message, 180),
    ...details,
  }
  const diagnostics = options && options.diagnostics
  if (diagnostics && typeof diagnostics === 'object') diagnostics.lastError = failure
  if (typeof options?.onDiagnostic === 'function') {
    try { options.onDiagnostic(failure) } catch { /* non-critical: diagnostic callback must not break TTS fallback */
    }
  }
  const logger = options && options.logger
  if (logger && typeof logger.warn === 'function') {
    const voiceKind = String(options.voice || '').startsWith('data:') ? 'clone' : 'builtin'
    const fields = [
      `code=${failure.code}`,
      failure.status ? `status=${failure.status}` : '',
      failure.model ? `model=${failure.model}` : '',
      `voice=${voiceKind}`,
      options.context ? `context=${sanitizeDiagnosticText(options.context, 80)}` : '',
      failure.message ? `message=${failure.message}` : '',
    ].filter(Boolean).join(' ')
    try { logger.warn(`tts failed: ${fields}`) } catch { /* non-critical: logging failure should not break TTS fallback */
    }
  }
  return null
}

function decodeTtsAudioData(audioData: unknown): DecodedAudioData {
  const raw = String(audioData || '').trim()
  if (!raw) return { error: 'empty audio data' }

  let declaredMime = ''
  let base64 = raw
  const uriMatch = raw.match(DATA_URI_RE)
  if (uriMatch) {
    declaredMime = String(uriMatch[1] || '').toLowerCase()
    if (!uriMatch[2]) return { error: 'audio data URI is not base64 encoded', declaredMime }
    base64 = uriMatch[3] || ''
  }

  const normalized = String(base64)
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!normalized) return { error: 'empty base64 audio payload', declaredMime }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return { error: 'invalid base64 audio payload', declaredMime }
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const buffer = Buffer.from(padded, 'base64') as AudioBufferWithMime
  if (!buffer.length) return { error: 'decoded audio payload is empty', declaredMime }
  return { buffer, declaredMime }
}

function hasUsableWavData(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return false
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + chunkSize
    if (chunkId === 'data') return chunkSize > 0 && dataEnd <= buffer.length
    offset = dataEnd + (chunkSize % 2)
  }
  return false
}

function detectAudioMime(buffer: unknown): string {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return ''
  if (hasUsableWavData(buffer)) return 'audio/wav'
  if (buffer.length > 16 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (buffer.length > 16 && buffer.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  if (buffer.length > 16 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4'
  if (buffer.length > 32 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (buffer.length > 32 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return ''
}

function getAudioExtension(mimeType: string): string {
  switch (mimeType) {
    case 'audio/wav': return '.wav'
    case 'audio/mpeg': return '.mp3'
    case 'audio/ogg': return '.ogg'
    case 'audio/flac': return '.flac'
    case 'audio/mp4': return '.m4a'
    default: return '.audio'
  }
}

function cleanupOldTtsSendFiles(now: number = Date.now()): void {
  try {
    if (!fs.existsSync(TTS_TEMP_DIR)) return
    for (const name of fs.readdirSync(TTS_TEMP_DIR)) {
      if (!name.startsWith(TTS_SEND_TEMP_PREFIX)) continue
      const filePath = path.join(TTS_TEMP_DIR, name)
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs > TTS_SEND_FILE_TTL_MS) fs.unlinkSync(filePath)
    }
  } catch { /* non-critical: old TTS send temp cleanup is best-effort */
  }
}

function writeTtsSendTempFile(audioBuf: Buffer, mimeType: string): string {
  cleanupOldTtsSendFiles()
  fs.mkdirSync(TTS_TEMP_DIR, { recursive: true })
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const filePath = path.join(TTS_TEMP_DIR, `${TTS_SEND_TEMP_PREFIX}${suffix}${getAudioExtension(mimeType)}`)
  fs.writeFileSync(filePath, audioBuf)
  return filePath
}

function scheduleTtsSendFileCleanup(filePath: string, ttlMs: number = TTS_SEND_FILE_TTL_MS): void {
  const timer = setTimeout(() => {
    try { fs.unlinkSync(filePath) } catch { /* non-critical: delayed TTS temp cleanup is best-effort */
    }
  }, Math.max(1000, Number(ttlMs) || TTS_SEND_FILE_TTL_MS))
  if (typeof timer.unref === 'function') timer.unref()
}

interface TtsRuntimeStep {
  provider: string
  model: string
  apiKey: string
  baseURL: string
}

interface TtsAttemptResult {
  buffer: AudioBufferWithMime
  usage?: Record<string, unknown>
  readable: boolean
}

class TtsStepError extends Error {
  code: string
  status: number
  retryable: boolean

  // 创建不含上游响应正文的稳定 TTS 错误。
  constructor(code: string, message: string, retryable = true, status = 0) {
    super(message)
    this.name = 'TtsStepError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

// 校验 TTS HTTP 状态；鉴权、限流和 5xx 可继续下一优先级。
function assertTtsResponseOk(response: Response): void {
  if (response.ok) return
  const retryable = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500
  throw new TtsStepError('http_error', `语音合成上游失败（HTTP ${response.status}）`, retryable, response.status)
}

// 为音频 Buffer 标记检测到的 MIME，无法播放时作为可降级的无效结果。
function finalizeTtsAudio(buffer: Buffer, declaredMime = ''): AudioBufferWithMime {
  const detectedMime = detectAudioMime(buffer)
  if (!detectedMime) throw new TtsStepError('invalid_audio', '语音合成上游返回了不可播放的音频')
  const audio = buffer as AudioBufferWithMime
  Object.defineProperty(audio, 'mimeType', { value: detectedMime || declaredMime, enumerable: false })
  return audio
}

// 调用小米 Chat Completions 音频协议，模型严格使用当前优先级条目。
async function requestMimoriumTts(step: TtsRuntimeStep, text: string, voice: string, style: string, signal: AbortSignal): Promise<TtsAttemptResult> {
  const cloneVoice = voice.startsWith('data:')
  const cloneModel = /voiceclone/i.test(step.model)
  if (cloneVoice !== cloneModel) throw new TtsStepError('voice_model_mismatch', '当前小米模型与所选音色类型不匹配')
  const response = await fetch(`${step.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${step.apiKey}` },
    body: JSON.stringify({
      model: step.model,
      messages: [{ role: 'user', content: style }, { role: 'assistant', content: text }],
      audio: { format: 'wav', voice },
    }),
  })
  assertTtsResponseOk(response)
  let data: Record<string, unknown>
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    data = value as Record<string, unknown>
  } catch {
    throw new TtsStepError('invalid_json', '语音合成上游返回了无法解析的结果')
  }
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {}
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : {}
  const audio = message.audio && typeof message.audio === 'object' ? message.audio as Record<string, unknown> : {}
  const decoded = decodeTtsAudioData(audio.data)
  if (!decoded.buffer) throw new TtsStepError('invalid_audio_data', '语音合成结果缺少有效音频数据')
  const usage = data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage as Record<string, unknown> : undefined
  return { buffer: finalizeTtsAudio(decoded.buffer, decoded.declaredMime), usage, readable: !!usage && Object.keys(usage).some(key => /tokens/i.test(key)) }
}

// 调用 OpenAI 官方 audio/speech 协议；不支持克隆音色时转入下一优先级。
async function requestOpenAiTts(step: TtsRuntimeStep, text: string, voice: string, signal: AbortSignal): Promise<TtsAttemptResult> {
  if (voice.startsWith('data:')) throw new TtsStepError('voice_model_mismatch', 'OpenAI 语音合成不支持当前克隆音色')
  const selectedVoice = OPENAI_VOICES.has(voice) ? voice : 'alloy'
  const response = await fetch(`${step.baseURL.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${step.apiKey}` },
    body: JSON.stringify({ model: step.model, input: text, voice: selectedVoice, response_format: 'wav' }),
  })
  assertTtsResponseOk(response)
  let buffer: Buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch {
    throw new TtsStepError('invalid_audio_data', '语音合成上游音频读取失败')
  }
  return { buffer: finalizeTtsAudio(buffer), readable: false }
}

// 严格按 voice-tts 优先级合成语音，并对每个失败步骤通知管理员。
async function synthesizeSpeech(text: unknown, options: TtsOptions = {}): Promise<AudioBufferWithMime | null> {
  const voice = String(options.voice || DEFAULT_VOICE)
  const style = sanitizeTtsStyle(options.style, NEUTRAL_TTS_STYLE)
  const ttsText = String(text).slice(0, MAX_TTS_TEXT_LENGTH)
  if (!ttsText.trim()) return recordTtsFailure({ ...options, voice }, 'empty_text', 'TTS text is empty')
  const steps = resolveCapabilityRuntimeSteps('voice-tts') as TtsRuntimeStep[]
  if (!steps.length) return recordTtsFailure({ ...options, voice }, 'capability_unconfigured', '该能力未配置模型')

  let lastError: unknown = null
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), voice.startsWith('data:') ? 30000 : TTS_TIMEOUT_MS)
    try {
      const result = step.provider === 'openai'
        ? await requestOpenAiTts(step, ttsText, voice, controller.signal)
        : await requestMimoriumTts(step, ttsText, voice, style, controller.signal)
      const usage = result.usage || {}
      const total = Number(usage.total_tokens || usage.totalTokens || 0)
        || Number(usage.input_tokens || usage.prompt_tokens || 0) + Number(usage.output_tokens || usage.completion_tokens || 0)
      recordTokenUsage(step.provider, Number.isFinite(total) ? total : 0, { capability: 'voice-tts', model: step.model, usage, readable: result.readable })
      return result.buffer
    } catch (error) {
      lastError = error
      console.warn(`[voice-tts] capability_step_failed provider=${step.provider} model=${step.model}`)
      await notifyCapabilityStepFailure(step.provider, step.model).catch(() => false)
      const retryable = !(error instanceof TtsStepError) || error.retryable
      if (!retryable || index >= steps.length - 1) break
    } finally {
      clearTimeout(timer)
    }
  }

  const failure = lastError instanceof TtsStepError ? lastError : null
  const isAbort = lastError && typeof lastError === 'object' && (lastError as { name?: unknown }).name === 'AbortError'
  return recordTtsFailure(
    { ...options, voice },
    isAbort ? 'timeout' : (failure?.code || 'request_failed'),
    failure?.message || (isAbort ? '语音合成请求超时' : '语音合成请求失败'),
    { ...(failure?.status ? { status: failure.status } : {}), model: steps[steps.length - 1]?.model || '' },
  )
}
async function sendVoiceMessage(session: TtsSessionLike, audioBuf: AudioBufferWithMime | Buffer | null | undefined, options: TtsOptions = {}): Promise<boolean> {
  if (!audioBuf || !audioBuf.length) {
    recordTtsFailure(options, 'send_empty_audio', 'audio buffer is empty')
    return false
  }
  if (audioBuf.length > 2 * 1024 * 1024) {
    recordTtsFailure(options, 'send_audio_too_large', 'audio buffer exceeds QQ record limit', { bytes: audioBuf.length })
    return false
  }
  const mimeType = detectAudioMime(audioBuf) || (audioBuf as AudioBufferWithMime).mimeType || ''
  if (!mimeType) {
    recordTtsFailure(options, 'send_invalid_audio', 'audio buffer is not playable', { bytes: audioBuf.length })
    return false
  }
  let tempFile = ''
  try {
    const { h } = require('koishi') as { h: { audio(src: string): unknown } }
    tempFile = writeTtsSendTempFile(audioBuf, mimeType)
    const src = pathToFileURL(tempFile).href
    if (options.diagnostics && typeof options.diagnostics === 'object') {
      options.diagnostics.lastSend = { method: 'file', mimeType, bytes: audioBuf.length, file: path.basename(tempFile) }
    }
    await session.send(h.audio(src))
    scheduleTtsSendFileCleanup(tempFile, options.tempFileTtlMs)
    return true
  } catch (error) {
    recordTtsFailure(options, 'send_failed', error instanceof Error ? error.message : String(error))
    if (tempFile) {
      try { fs.unlinkSync(tempFile) } catch { /* non-critical: best-effort TTS temp cleanup after send failure */
      }
    }
    return false
  }
}

function resolvePersonaVoice(personaName: unknown, options: TtsOptions = {}): ResolvedPersonaVoice {
  const plan = options.plan || resolvePersonaRuntimePlan({ personaName: String(personaName || '') }) as PersonaRuntimePlanLike
  if (!plan || !plan.name) return { voice: DEFAULT_VOICE, style: NEUTRAL_TTS_STYLE }
  const voiceId = plan.voice?.rawId || ''
  const voiceAssetId = plan.voice?.assetId || ''
  const style = sanitizeTtsStyle(plan.voice?.style, NEUTRAL_TTS_STYLE)

  if (voiceId === '__cloned__' || voiceId === '') {
    const clonedUri = loadClonedVoiceUri(plan.name || personaName, voiceAssetId)
    if (clonedUri) return { voice: clonedUri, style }
  }
  return { voice: voiceId || DEFAULT_VOICE, style }
}

const clonedVoiceCache: Map<string, { mtime: number; uri: string }> = new Map()

function loadClonedVoiceUri(personaName: unknown, voiceAssetId: unknown = ''): string | null {
  try {
    const sample = resolveVoiceSampleFile(personaName, voiceAssetId)
    if (!sample) return null
    const cacheKey = `${sample.id}:${sample.filename}`
    const cached = clonedVoiceCache.get(cacheKey)
    if (cached && cached.mtime === sample.mtime) return cached.uri
    const buf = fs.readFileSync(sample.filePath)
    const mime = sample.mimeType || 'audio/mpeg'
    const uri = `data:${mime};base64,${buf.toString('base64')}`
    clonedVoiceCache.set(cacheKey, { mtime: sample.mtime, uri })
    return uri
  } catch { /* non-critical: cloned voice load falls back to default voice */
    return null
  }
}

function extractVoiceStyle(replyText: unknown): string | null {
  const match = String(replyText || '').match(VOICE_STYLE_RE)
  if (!match) return null
  return sanitizeTtsStyle(match[1]) || null
}

function stripVoiceStyleTag(text: unknown): string {
  return String(text || '').replace(/【语音风格[：:][^】]+】/g, '').trim()
}

function getBuiltinVoices(): string[] {
  return [...BUILTIN_VOICES]
}

function isChannelOnCooldown(channelKey: string): boolean {
  const last = channelCooldowns.get(channelKey)
  if (!last) return false
  return (Date.now() - last) < CHANNEL_COOLDOWN_MS
}

function markChannelCooldown(channelKey: string): void {
  channelCooldowns.set(channelKey, Date.now())
  if (channelCooldowns.size > 200) {
    const now = Date.now()
    for (const [k, v] of channelCooldowns) {
      if (now - v > CHANNEL_COOLDOWN_MS) channelCooldowns.delete(k)
    }
  }
}

function shouldTriggerRandomVoice(channelKey: string, randomFn: () => number = Math.random): boolean {
  if (isChannelOnCooldown(channelKey)) return false
  return randomFn() < getRandomVoiceRate(channelKey)
}

export = {
  synthesizeSpeech,
  sendVoiceMessage,
  resolvePersonaVoice,
  sanitizeTtsStyle,
  composeTtsStyle,
  extractVoiceStyle,
  stripVoiceStyleTag,
  getBuiltinVoices,
  isChannelOnCooldown,
  markChannelCooldown,
  shouldTriggerRandomVoice,
  getMimoriumKey,
  detectAudioMime,
  getRandomVoiceRate,
  BUILTIN_VOICES,
  DEFAULT_VOICE,
  NEUTRAL_TTS_STYLE,
  MAX_TTS_TEXT_LENGTH,
  MAX_TTS_STYLE_LENGTH,
  RANDOM_VOICE_RATE,
  CHANNEL_COOLDOWN_MS,
}
