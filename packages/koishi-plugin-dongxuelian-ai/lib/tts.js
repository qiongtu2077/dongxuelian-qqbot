/**
 * MODULE: 语音合成（TTS）。
 * 职责: 调 MiMo TTS API 合成语音 → 发送 QQ record 消息段。
 * 边界: 不写对话历史、不改 conversation。只负责合成和发送。
 * 状态: 频道冷却 Map（内存，5 分钟过期）。
 */
const { MIMORIUM_KEY_FILE, TTS_TEMP_DIR } = require('./constants')
const { readTextFile } = require('./utils')
const { parsePersonaFrontmatter, loadPersonalSkill } = require('./persona')
const { resolveVoiceSampleFile } = require('./voice-assets')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const TTS_TIMEOUT_MS = 15000
const TTS_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
// 普通 TTS 只接受内置音色名；voice clone 的 data URI 必须走专用模型。
const TTS_MODEL = 'mimo-v2.5-tts'
const TTS_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const DEFAULT_VOICE = '冰糖'
const DEFAULT_STYLE = '活泼可爱'
const MAX_TTS_TEXT_LENGTH = 300
const CHANNEL_COOLDOWN_MS = 5 * 60 * 1000
const RANDOM_VOICE_RATE = 0.05
const DEFAULT_TTS_SEND_FILE_TTL_MS = 10 * 60 * 1000
const TTS_SEND_FILE_TTL_MS = (() => {
  const value = Number(process.env.TTS_SEND_FILE_TTL_MS || DEFAULT_TTS_SEND_FILE_TTL_MS)
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_TTS_SEND_FILE_TTL_MS
})()

const BUILTIN_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default']

const channelCooldowns = new Map()

const VOICE_STYLE_RE = /【语音风格[：:]([^】]+)】/
const DATA_URI_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i
const TTS_SEND_TEMP_PREFIX = 'tts-send-'

async function getMimoriumKey() {
  const keyFile = MIMORIUM_KEY_FILE
  const key = await readTextFile(keyFile)
  return key.replace(/[\r\n]+/g, '').trim()
}

function sanitizeDiagnosticText(value, maxLength = 240) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|tp)-[A-Za-z0-9._~+/=-]{8,}\b/g, '[redacted-key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function recordTtsFailure(options, code, message, details = {}) {
  const failure = {
    code,
    message: sanitizeDiagnosticText(message, 180),
    ...details,
  }
  const diagnostics = options && options.diagnostics
  if (diagnostics && typeof diagnostics === 'object') diagnostics.lastError = failure
  if (typeof options?.onDiagnostic === 'function') {
    try { options.onDiagnostic(failure) } catch {}
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
    try { logger.warn(`tts failed: ${fields}`) } catch {}
  }
  return null
}

function decodeTtsAudioData(audioData) {
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
  const buffer = Buffer.from(padded, 'base64')
  if (!buffer.length) return { error: 'decoded audio payload is empty', declaredMime }
  return { buffer, declaredMime }
}

function hasUsableWavData(buffer) {
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

function detectAudioMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return ''
  if (hasUsableWavData(buffer)) return 'audio/wav'
  if (buffer.length > 16 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (buffer.length > 16 && buffer.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  if (buffer.length > 16 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4'
  if (buffer.length > 32 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (buffer.length > 32 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return ''
}

function getAudioExtension(mimeType) {
  switch (mimeType) {
    case 'audio/wav': return '.wav'
    case 'audio/mpeg': return '.mp3'
    case 'audio/ogg': return '.ogg'
    case 'audio/flac': return '.flac'
    case 'audio/mp4': return '.m4a'
    default: return '.audio'
  }
}

function cleanupOldTtsSendFiles(now = Date.now()) {
  try {
    if (!fs.existsSync(TTS_TEMP_DIR)) return
    for (const name of fs.readdirSync(TTS_TEMP_DIR)) {
      if (!name.startsWith(TTS_SEND_TEMP_PREFIX)) continue
      const filePath = path.join(TTS_TEMP_DIR, name)
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs > TTS_SEND_FILE_TTL_MS) fs.unlinkSync(filePath)
    }
  } catch {}
}

function writeTtsSendTempFile(audioBuf, mimeType) {
  cleanupOldTtsSendFiles()
  fs.mkdirSync(TTS_TEMP_DIR, { recursive: true })
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const filePath = path.join(TTS_TEMP_DIR, `${TTS_SEND_TEMP_PREFIX}${suffix}${getAudioExtension(mimeType)}`)
  fs.writeFileSync(filePath, audioBuf)
  return filePath
}

function scheduleTtsSendFileCleanup(filePath, ttlMs = TTS_SEND_FILE_TTL_MS) {
  const timer = setTimeout(() => {
    try { fs.unlinkSync(filePath) } catch {}
  }, Math.max(1000, Number(ttlMs) || TTS_SEND_FILE_TTL_MS))
  if (typeof timer.unref === 'function') timer.unref()
}

async function synthesizeSpeech(text, options = {}) {
  const { voice = DEFAULT_VOICE, style = DEFAULT_STYLE } = options
  const apiKey = await getMimoriumKey()
  const isCloneVoice = String(voice).startsWith('data:')
  const model = isCloneVoice ? TTS_CLONE_MODEL : TTS_MODEL
  if (!apiKey) return recordTtsFailure({ ...options, voice }, 'missing_key', `MiMo API key is empty: ${MIMORIUM_KEY_FILE}`, { model })

  const ttsText = String(text).slice(0, MAX_TTS_TEXT_LENGTH)
  if (!ttsText.trim()) return recordTtsFailure({ ...options, voice }, 'empty_text', 'TTS text is empty', { model })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), isCloneVoice ? 30000 : TTS_TIMEOUT_MS)

  try {
    const response = await fetch(`${TTS_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: style },
          { role: 'assistant', content: ttsText },
        ],
        audio: { format: 'wav', voice },
      }),
    })

    if (!response.ok) {
      const responseText = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
      const body = sanitizeDiagnosticText(responseText, 300)
      return recordTtsFailure({ ...options, voice }, 'http_error', body || `HTTP ${response.status}`, { status: response.status, model })
    }
    let data = null
    try {
      data = await response.json()
    } catch (error) {
      return recordTtsFailure({ ...options, voice }, 'invalid_json', error.message || 'invalid json response', { model })
    }
    const audioData = data?.choices?.[0]?.message?.audio?.data
    if (!audioData) return recordTtsFailure({ ...options, voice }, 'missing_audio_data', 'response has no choices[0].message.audio.data', { model })
    const decoded = decodeTtsAudioData(audioData)
    if (!decoded.buffer) return recordTtsFailure({ ...options, voice }, 'invalid_audio_data', decoded.error || 'invalid audio data', { model, declaredMime: decoded.declaredMime || '' })
    const detectedMime = detectAudioMime(decoded.buffer)
    if (!detectedMime) {
      return recordTtsFailure({ ...options, voice }, 'invalid_audio', 'decoded audio is not a playable WAV/MP3/OGG/FLAC/MP4 payload', {
        model,
        declaredMime: decoded.declaredMime || '',
        bytes: decoded.buffer.length,
      })
    }
    Object.defineProperty(decoded.buffer, 'mimeType', { value: detectedMime, enumerable: false })
    return decoded.buffer
  } catch (error) {
    const isAbort = error && error.name === 'AbortError'
    return recordTtsFailure({ ...options, voice }, isAbort ? 'timeout' : 'request_failed', error?.message || String(error), { model })
  } finally {
    clearTimeout(timer)
  }
}
async function sendVoiceMessage(session, audioBuf, options = {}) {
  if (!audioBuf || !audioBuf.length) {
    recordTtsFailure(options, 'send_empty_audio', 'audio buffer is empty')
    return false
  }
  if (audioBuf.length > 2 * 1024 * 1024) {
    recordTtsFailure(options, 'send_audio_too_large', 'audio buffer exceeds QQ record limit', { bytes: audioBuf.length })
    return false
  }
  const mimeType = detectAudioMime(audioBuf) || audioBuf.mimeType || ''
  if (!mimeType) {
    recordTtsFailure(options, 'send_invalid_audio', 'audio buffer is not playable', { bytes: audioBuf.length })
    return false
  }
  let tempFile = ''
  try {
    const { h } = require('koishi')
    tempFile = writeTtsSendTempFile(audioBuf, mimeType)
    const src = pathToFileURL(tempFile).href
    if (options.diagnostics && typeof options.diagnostics === 'object') {
      options.diagnostics.lastSend = { method: 'file', mimeType, bytes: audioBuf.length, file: path.basename(tempFile) }
    }
    await session.send(h.audio(src))
    scheduleTtsSendFileCleanup(tempFile, options.tempFileTtlMs)
    return true
  } catch (error) {
    recordTtsFailure(options, 'send_failed', error?.message || String(error))
    if (tempFile) {
      try { fs.unlinkSync(tempFile) } catch {}
    }
    return false
  }
}

function resolvePersonaVoice(personaName) {
  if (!personaName) return { voice: DEFAULT_VOICE, style: DEFAULT_STYLE }
  const content = loadPersonalSkill(personaName)
  if (!content) return { voice: DEFAULT_VOICE, style: DEFAULT_STYLE }
  const meta = parsePersonaFrontmatter(content)
  const voiceId = meta.voice_id || meta.voice || ''
  const voiceAssetId = meta.voice_asset_id || ''
  const style = meta.voice_style || DEFAULT_STYLE

  if (voiceId === '__cloned__' || voiceId === '') {
    const clonedUri = loadClonedVoiceUri(personaName, voiceAssetId)
    if (clonedUri) return { voice: clonedUri, style }
  }
  return { voice: voiceId || DEFAULT_VOICE, style }
}

const clonedVoiceCache = new Map()

function loadClonedVoiceUri(personaName, voiceAssetId = '') {
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
  } catch {
    return null
  }
}

function extractVoiceStyle(replyText) {
  const match = String(replyText || '').match(VOICE_STYLE_RE)
  if (!match) return null
  return match[1].trim()
}

function stripVoiceStyleTag(text) {
  return String(text || '').replace(/【语音风格[：:][^】]+】/g, '').trim()
}

function getBuiltinVoices() {
  return [...BUILTIN_VOICES]
}

function isChannelOnCooldown(channelKey) {
  const last = channelCooldowns.get(channelKey)
  if (!last) return false
  return (Date.now() - last) < CHANNEL_COOLDOWN_MS
}

function markChannelCooldown(channelKey) {
  channelCooldowns.set(channelKey, Date.now())
  if (channelCooldowns.size > 200) {
    const now = Date.now()
    for (const [k, v] of channelCooldowns) {
      if (now - v > CHANNEL_COOLDOWN_MS) channelCooldowns.delete(k)
    }
  }
}

function shouldTriggerRandomVoice(channelKey) {
  if (isChannelOnCooldown(channelKey)) return false
  return Math.random() < RANDOM_VOICE_RATE
}

module.exports = {
  synthesizeSpeech,
  sendVoiceMessage,
  resolvePersonaVoice,
  extractVoiceStyle,
  stripVoiceStyleTag,
  getBuiltinVoices,
  isChannelOnCooldown,
  markChannelCooldown,
  shouldTriggerRandomVoice,
  getMimoriumKey,
  detectAudioMime,
  BUILTIN_VOICES,
  MAX_TTS_TEXT_LENGTH,
  RANDOM_VOICE_RATE,
  CHANNEL_COOLDOWN_MS,
}
