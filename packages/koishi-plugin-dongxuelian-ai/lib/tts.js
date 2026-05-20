/**
 * MODULE: 语音合成（TTS）。
 * 职责: 调 MiMo TTS API 合成语音 → 发送 QQ record 消息段。
 * 边界: 不写对话历史、不改 conversation。只负责合成和发送。
 * 状态: 频道冷却 Map（内存，5 分钟过期）。
 */
const { MIMORIUM_KEY_FILE } = require('./constants')
const { readTextFile } = require('./utils')
const { parsePersonaFrontmatter, loadPersonalSkill } = require('./persona')
const { resolveVoiceSampleFile } = require('./voice-assets')
const fs = require('fs')

const TTS_TIMEOUT_MS = 15000
const TTS_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
const TTS_MODEL = 'mimo-v2.5-tts'
const TTS_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const DEFAULT_VOICE = '冰糖'
const DEFAULT_STYLE = '活泼可爱'
const MAX_TTS_TEXT_LENGTH = 300
const CHANNEL_COOLDOWN_MS = 5 * 60 * 1000
const RANDOM_VOICE_RATE = 0.05

const BUILTIN_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default']

const channelCooldowns = new Map()

const VOICE_STYLE_RE = /【语音风格[：:]([^】]+)】/

async function getMimoriumKey() {
  const keyFile = MIMORIUM_KEY_FILE
  const key = await readTextFile(keyFile)
  return key.replace(/[\r\n]+/g, '').trim()
}

async function synthesizeSpeech(text, options = {}) {
  const { voice = DEFAULT_VOICE, style = DEFAULT_STYLE } = options
  const apiKey = await getMimoriumKey()
  if (!apiKey) return null

  const ttsText = String(text).slice(0, MAX_TTS_TEXT_LENGTH)
  if (!ttsText.trim()) return null

  const isCloneVoice = String(voice).startsWith('data:')
  const model = isCloneVoice ? TTS_CLONE_MODEL : TTS_MODEL
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

    if (!response.ok) return null
    const data = await response.json()
    const audioData = data?.choices?.[0]?.message?.audio?.data
    if (!audioData) return null
    return Buffer.from(audioData, 'base64')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
async function sendVoiceMessage(session, audioBuf) {
  if (!audioBuf || !audioBuf.length) return false
  if (audioBuf.length > 2 * 1024 * 1024) return false
  try {
    const { h } = require('koishi')
    const base64 = audioBuf.toString('base64')
    await session.send(h.audio(`data:audio/wav;base64,${base64}`))
    return true
  } catch {
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
  BUILTIN_VOICES,
  MAX_TTS_TEXT_LENGTH,
  RANDOM_VOICE_RATE,
  CHANNEL_COOLDOWN_MS,
}
