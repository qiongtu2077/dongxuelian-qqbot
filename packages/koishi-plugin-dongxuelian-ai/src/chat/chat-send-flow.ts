/**
 * MODULE: chat-send-flow
 * 职责: 处理普通 chat 回复生成后的诊断、随机语音、敏感通知与最终发送。
 * 边界: 不调用 chat/Agent、不注册 middleware、不拥有队列；安全发送函数由调用方注入。
 * 状态: 无模块级状态。
 */
const {
  logAffectRouterDiagnosticForOutputShadow,
  logStickerShadowSendDiagnostic,
} = require('../diagnostics/diagnostics') as typeof import('../diagnostics/diagnostics')
const { resolvePersona } = require('../persona/persona') as typeof import('../persona/persona')
const { shouldTriggerRareVoice } = require('../behavior/rare-voice') as typeof import('../behavior/rare-voice')
const { logStaleRandomSkip, safeSendRareVoice } = require('../reply/safe-send') as typeof import('../reply/safe-send')
const { notifySensitiveHandlers } = require('../behavior/sensitive') as typeof import('../behavior/sensitive')
const { isRandomReplyFresh } = require('../behavior/random-state') as typeof import('../behavior/random-state')

interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface ContextLike {
  logger: (name: string) => LoggerLike
  [key: string]: unknown
}

interface SessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  messageId?: string
  author?: { id?: string; nick?: string; name?: string }
  bot?: unknown
  send?: (message: unknown) => Promise<unknown> | unknown
}

interface ChatMeta {
  rareConfirmed?: boolean
  [key: string]: unknown
}

interface RandomSendOptions {
  [key: string]: unknown
}

type ResolveBotFn = () => unknown

type SafeSendReplyWithFreshness = (
  ctx: ContextLike,
  session: SessionLike,
  reply: string,
  randomTriggered: boolean,
  resolveBot?: ResolveBotFn,
  options?: Record<string, unknown>
) => Promise<unknown>

interface TrySendRandomVoiceOptions {
  ctx: ContextLike
  liveSession: SessionLike
  channelKey: string
  currentUserId: string
  reply: string
  randomTriggered: boolean
  inGuild: boolean
  chatMeta: ChatMeta
  randomSendOptions: RandomSendOptions
}

interface SendChatReplyFlowOptions extends TrySendRandomVoiceOptions {
  userText: string
  currentPersonaName?: string
  resolveBot?: ResolveBotFn
  safeSendReplyWithFreshness: SafeSendReplyWithFreshness
}

function getChatSendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error')
}

function stripVoiceStyleTagText(reply: string): string {
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
}: TrySendRandomVoiceOptions): Promise<boolean> {
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
    } = require('../media/voice/tts') as typeof import('../media/voice/tts')
    const { runVoiceTtsWithResourceGate } = require('../media/voice/tts-resource') as typeof import('../media/voice/tts-resource')
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
    const ttsResult = await runVoiceTtsWithResourceGate({
      source: 'koishi-random-voice',
      owner: 'koishi-random-voice',
      channelKey,
      userId: currentUserId,
      context: 'random-voice',
      logger: ctx.logger('dongxuelian-ai'),
      run: () => synthesizeSpeech(ttsText, { ...voiceOpts, ...ttsDiagnostics }),
    })
    if (!ttsResult.ok) return false
    const buf = ttsResult.value
    if (!buf) return false
    if (!isRandomReplyFresh(randomSendOptions)) {
      logStaleRandomSkip(ctx, 'random-voice', randomSendOptions)
      return true
    }
    const sent = await sendVoiceMessage(liveSession as { send(content: unknown): unknown | Promise<unknown> }, buf, ttsDiagnostics)
    if (!sent) return false
    markChannelCooldown(channelKey)
    return true
  } catch (err) {
    ctx.logger('dongxuelian-ai').warn(`random voice send failed, falling back to text: ${getChatSendErrorMessage(err)}`)
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
}: SendChatReplyFlowOptions): Promise<unknown> {
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
    notifySensitiveHandlers(liveSession as { send(message: string): Promise<unknown> }, channelKey, { throttle: true }).catch(() => {
      /* non-critical: sensitive notification failure must not block the visible reply */
    })
  }
  const finalReply = stripVoiceStyleTagText(reply)
  if (shouldTriggerRareVoice(chatMeta)) {
    if (randomTriggered && !isRandomReplyFresh(randomSendOptions)) {
      logStaleRandomSkip(ctx, 'rare-voice', randomSendOptions)
      return
    }
    const rareVoiceSent = await safeSendRareVoice(ctx, liveSession as { send(message: string): Promise<unknown> | unknown })
    if (rareVoiceSent) return
  }
  return safeSendReplyWithFreshness(ctx, liveSession as SessionLike & { send(message: string): Promise<unknown> | unknown }, finalReply, randomTriggered, resolveBot, {
    ...randomSendOptions,
    personaName: currentPersonaName || '',
  })
}

export = {
  sendChatReplyFlow,
}
