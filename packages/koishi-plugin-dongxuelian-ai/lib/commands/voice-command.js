/**
 * MODULE: 语音合成命令。
 * 边界: 只处理命令匹配、文本长度校验和语音发送调用；不写对话历史，不改 conversation，不调聊天模型。
 * 状态: 无自有 Map/Cache；TTS 冷却和临时文件状态由 tts.js 自己管理。
 */

const { resolvePersona } = require('../persona/persona')
const { sanitizeUserInput } = require('../core/utils')
const { handled, notHandled } = require('./command-result')

function getVoiceLogger(runtime = {}) {
  try {
    return runtime.ctx?.logger ? runtime.ctx.logger('dongxuelian-ai') : null
  } catch {
    return null
  }
}

function buildTtsDiagnostics(runtime, context) {
  return {
    diagnostics: {},
    logger: getVoiceLogger(runtime),
    context,
  }
}

async function handleVoiceCommand(session, state, runtime = {}) {
  const { plain, channelKey, currentUserId } = state

  if (plain === '东雪莲说句话') {
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice } = require('../media/voice/tts')
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const phrases = ['我在，先说重点吧。', '嗯，我听着。', '有什么事，慢慢说。', '今天也还算安静。', '别急，我会听完。']
    const text = phrases[Math.floor(Math.random() * phrases.length)]
    const ttsDiagnostics = buildTtsDiagnostics(runtime, 'command:东雪莲说句话')
    const buf = await synthesizeSpeech(text, { ...voiceOpts, ...ttsDiagnostics })
    if (buf) {
      const sent = await sendVoiceMessage(session, buf, ttsDiagnostics)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  const readAloudMatch = plain.match(/^东雪莲朗读\s*(.+)/)
  if (readAloudMatch) {
    const text = readAloudMatch[1].trim()
    if (!text) return handled('请告诉我要朗读什么内容。')
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice, MAX_TTS_TEXT_LENGTH } = require('../media/voice/tts')
    if (text.length > MAX_TTS_TEXT_LENGTH) return handled(`文本太长了，最多支持 ${MAX_TTS_TEXT_LENGTH} 字。`)
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const ttsDiagnostics = buildTtsDiagnostics(runtime, 'command:东雪莲朗读')
    const buf = await synthesizeSpeech(text, { ...voiceOpts, ...ttsDiagnostics })
    if (buf) {
      const sent = await sendVoiceMessage(session, buf, ttsDiagnostics)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  if (/^朗读$/.test(plain) && session.quote?.content) {
    const rawQuote = String(session.quote.content || '')
      .replace(/\[CQ:[^\]]+\]/gi, '')
      .replace(/<[^>]+\/?>/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    const quoteText = sanitizeUserInput(rawQuote).slice(0, 300)
    if (!quoteText) return handled('引用的消息没有可朗读的文本。')
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice } = require('../media/voice/tts')
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const ttsDiagnostics = buildTtsDiagnostics(runtime, 'command:朗读引用')
    const buf = await synthesizeSpeech(quoteText, { ...voiceOpts, ...ttsDiagnostics })
    if (buf) {
      const sent = await sendVoiceMessage(session, buf, ttsDiagnostics)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  if (plain === '东雪莲语音列表') {
    const { getBuiltinVoices } = require('../media/voice/tts')
    return handled(`可用语音：${getBuiltinVoices().join('、')}\n人格 SKILL 文件可通过 voice_id 字段指定默认语音。`)
  }

  return notHandled()
}

module.exports = {
  handleVoiceCommand,
}
