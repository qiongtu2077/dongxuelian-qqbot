/**
 * MODULE: chat-send-flow
 * 职责: 处理普通 chat 回复生成后的诊断、随机语音、敏感通知与最终发送。
 * 边界: 不调用 chat/Agent、不注册 middleware、不拥有队列；安全发送函数由调用方注入。
 * 状态: 无模块级状态。
 */
const {
  logAffectRouterDiagnosticForOutputShadow,
  logStickerShadowSendDiagnostic,
} = require('./diagnostics')
const { resolvePersona } = require('./persona')
const { shouldTriggerRareVoice } = require('./rare-voice')
const { logStaleRandomSkip, safeSendRareVoice } = require('./safe-send')
const { notifySensitiveHandlers } = require('./sensitive')
const { isRandomReplyFresh } = require('./random-state')

function stripVoiceStyleTagText(reply) {
  const text = String(reply || '')
  return text.replace(/【语音风格[：:][^】]+】/g, '').trim() || text
}

async function trySendRandomVoice({
  ctx,
  liveSession,
  channelKey,
  currentUserId,
  reply,
  randomTriggered,
  inGuild,
  chatMeta,
  randomSendOptions,
}) {
  if (!randomTriggered || !inGuild || chatMeta.rareConfirmed) return false
  try {
    const {
      shouldTriggerRandomVoice,
      markChannelCooldown,
      synthesizeSpeech,
      sendVoiceMessage,
      resolvePersonaVoice,
      extractVoiceStyle,
      stripVoiceStyleTag,
      composeTtsStyle,
    } = require('./tts')
    if (!shouldTriggerRandomVoice(channelKey)) return false
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const styleOverride = extractVoiceStyle(reply)
    voiceOpts.style = composeTtsStyle(voiceOpts.style, styleOverride)
    const ttsText = stripVoiceStyleTag(reply)
    const ttsDiagnostics = {
      diagnostics: {},
      logger: ctx.logger('dongxuelian-ai'),
      context: 'random-voice',
    }
    const buf = await synthesizeSpeech(ttsText, { ...voiceOpts, ...ttsDiagnostics })
    if (!buf) return false
    if (!isRandomReplyFresh(randomSendOptions)) {
      logStaleRandomSkip(ctx, 'random-voice', randomSendOptions)
      return true
    }
    const sent = await sendVoiceMessage(liveSession, buf, ttsDiagnostics)
    if (!sent) return false
    markChannelCooldown(channelKey)
    return true
  } catch {
    return false
  }
}

async function sendChatReplyFlow({
  ctx,
  liveSession,
  channelKey,
  currentUserId,
  userText,
  reply,
  randomTriggered,
  inGuild,
  chatMeta = {},
  randomSendOptions = {},
  currentPersonaName = '',
  resolveBot,
  safeSendReplyWithFreshness,
}) {
  const affectDiagnostic = logAffectRouterDiagnosticForOutputShadow(ctx, {
    personaName: currentPersonaName || '',
    userText,
    replyText: reply,
    randomTriggered,
    voiceCandidate: randomTriggered && inGuild && !chatMeta.rareConfirmed,
    channelKey,
  })
  logStickerShadowSendDiagnostic(ctx, {
    session: liveSession,
    channelKey,
    userId: currentUserId,
    messageId: liveSession.messageId || '',
    personaName: currentPersonaName || '',
    replyText: reply,
    isRandom: randomTriggered,
    affectDiagnostic,
  })
  if (await trySendRandomVoice({
    ctx,
    liveSession,
    channelKey,
    currentUserId,
    reply,
    randomTriggered,
    inGuild,
    chatMeta,
    randomSendOptions,
  })) {
    return
  }
  if (inGuild && /别问了，这个我不聊/.test(reply)) {
    notifySensitiveHandlers(liveSession, channelKey, { throttle: true }).catch(() => {})
  }
  const finalReply = stripVoiceStyleTagText(reply)
  if (shouldTriggerRareVoice(chatMeta)) {
    if (randomTriggered && !isRandomReplyFresh(randomSendOptions)) {
      logStaleRandomSkip(ctx, 'rare-voice', randomSendOptions)
      return
    }
    const rareVoiceSent = await safeSendRareVoice(ctx, liveSession)
    if (rareVoiceSent) return
  }
  return safeSendReplyWithFreshness(ctx, liveSession, finalReply, randomTriggered, resolveBot, {
    ...randomSendOptions,
    personaName: currentPersonaName || '',
  })
}

module.exports = {
  sendChatReplyFlow,
}
