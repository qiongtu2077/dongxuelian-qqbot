/**
 * MODULE: 回复安全判断。
 * 职责: thinking leak 检测、禁词判定、重复回复判定、兜底回复选择。
 * 边界: 纯判断函数，不调 callOpenAI，不改 messages，不存 conversation。
 */
const {
  THINKING_OUTPUT_RE,
  ABUSIVE_FALLBACK_REPLIES,
  REPEATED_FALLBACK_REPLIES,
} = require('./constants')
const {
  getReplyFingerprintHistory,
  getRecentAssistantReplies,
  getRecentUserMessages,
} = require('./conversation')
const {
  normalizeReplyFingerprint,
  isReplyTooSimilar,
  isOverusedReply,
  isThinkingLeak,
} = require('./utils')

function shouldRetryRepeatedReply(session, reply = '') {
  if (!reply) return false
  if (isOverusedReply(reply)) return true
  const recentFingerprints = getReplyFingerprintHistory(session)
  return recentFingerprints.some(prev => isReplyTooSimilar(reply, prev))
}

function buildRepeatRetryPrompt(userText, recentReplies = []) {
  const recentBlock = recentReplies.length
    ? `最近几次你的回复：\n- ${recentReplies.join('\n- ')}`
    : ''

  return [
    '【系统提示：你刚才的回法太像旧回复，或者用了陈词滥调，或者句子结构和之前的回复相同。】',
    '不要再用"你妈的话你信不信我帮你转达""你照镜子说的""先看看自己"这种偷懒套话。',
    '不要动不动就拿"复读""复读机"当唯一攻击点，这太空泛了，换别的角度。',
    '严禁填空题模板：比如"你这种连xxx废物也配骂人，先管好你自己那张只会喷粪的嘴"、"你这种货色也就配在xxx"、"现实里怕是连条野狗都xxx"——换了填空内容但结构一样，仍然算失败。',
    '这次必须从结构上彻底换一个新骂法，切入点完全不同，短一点，狠一点。',
    recentBlock,
    `当前用户原话：${userText}`,
  ].filter(Boolean).join('\n')
}

function pickAbusiveFallbackReply(session) {
  const recentReplies = getRecentAssistantReplies(session, ABUSIVE_FALLBACK_REPLIES.length)
  for (const candidate of ABUSIVE_FALLBACK_REPLIES) {
    if (!recentReplies.some(previousReply => isReplyTooSimilar(candidate, previousReply))) {
      return candidate
    }
  }
  return ABUSIVE_FALLBACK_REPLIES[0]
}

function pickRepeatedFallbackReply(session) {
  const recentReplies = getRecentAssistantReplies(session, REPEATED_FALLBACK_REPLIES.length)
  for (const candidate of REPEATED_FALLBACK_REPLIES) {
    if (!recentReplies.some(previousReply => isReplyTooSimilar(candidate, previousReply))) {
      return candidate
    }
  }
  return REPEATED_FALLBACK_REPLIES[0]
}

function isConsecutiveUserRepeat(session, userText = '') {
  const normalized = normalizeReplyFingerprint(userText)
  if (!normalized) return false
  const recentUserMessages = getRecentUserMessages(session, 2)
    .map(item => normalizeReplyFingerprint(item))
    .filter(Boolean)
  return recentUserMessages.length === 2 && recentUserMessages.every(item => item === normalized)
}

function isUnsafeThinkingReply(reply = '') {
  const value = String(reply || '')
  return isThinkingLeak(value) || THINKING_OUTPUT_RE.test(value)
}

function stripStickerMarkersForGuard(reply = '') {
  return String(reply || '').replace(/\[图:[^\[\]]+\]/g, '').trim()
}

module.exports = {
  shouldRetryRepeatedReply,
  buildRepeatRetryPrompt,
  pickAbusiveFallbackReply,
  pickRepeatedFallbackReply,
  isConsecutiveUserRepeat,
  isUnsafeThinkingReply,
  stripStickerMarkersForGuard,
}
