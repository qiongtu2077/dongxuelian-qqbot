/**
 * MODULE: 回复安全判断。
 * 职责: thinking leak 检测、禁词判定、重复回复判定、兜底回复选择、旧媒体粘连判定。
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
  return recentFingerprints.some(prev => isReplyTooSimilar(reply, prev.content))
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
  return ''
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

function hasInternalContextLeak(text = '') {
  return /(?:这是你在本群的发言|这是.{0,20}在本群的发言|昵称：|发言：|<user>|<\/user>|\[群聊刷到\]|\[内部参考-用户近期发言风格\]|\[用户上传文件:|---文件内容开始---|---文件内容结束---|【转发消息：\s*(?:\[对话\]|└─|\[内层转发\])|\[对话\]\s*[\s\S]{0,120}：|\s└─\s*[\s\S]{0,120}：)/.test(String(text || ''))
}

function extractContentTokens(text = '') {
  const value = String(text || '')
  const tokens = new Set()
  for (const m of value.matchAll(/[一-龥]{3,8}/g)) tokens.add(m[0])
  for (const m of value.matchAll(/[A-Za-z0-9]{4,16}/g)) tokens.add(m[0].toLowerCase())
  return tokens
}

function hasSceneItemMedia(item = {}) {
  if (!item) return false
  if (Array.isArray(item.anchors) && item.anchors.some(anchor => anchor && /^(image|file|voice|forward)$/.test(String(anchor.type || '')))) return true
  return /\[(?:图片|文件|语音|转发)/.test(String(item.content || ''))
}

function detectOldMediaTopicSticking({ reply, currentTurn = [], oldBackground = [], hotContext = [], hasCurrentMediaCue = false } = {}) {
  const replyText = String(reply || '')
  if (!replyText) return false
  if (hasCurrentMediaCue) return false
  if (currentTurn.some(hasSceneItemMedia)) return false
  const olderMediaItems = [...oldBackground, ...hotContext].filter(hasSceneItemMedia)
  if (!olderMediaItems.length) return false
  const replyTokens = extractContentTokens(replyText)
  if (!replyTokens.size) return false
  const currentTurnTokens = new Set()
  for (const item of currentTurn) {
    for (const token of extractContentTokens(item?.content || '')) currentTurnTokens.add(token)
  }
  const oldMediaTokens = new Set()
  for (const item of olderMediaItems) {
    for (const token of extractContentTokens(item?.content || '')) oldMediaTokens.add(token)
  }
  let stickingHits = 0
  for (const token of replyTokens) {
    if (oldMediaTokens.has(token) && !currentTurnTokens.has(token)) stickingHits += 1
    if (stickingHits >= 1) return true
  }
  return false
}

function buildOldMediaStickingRetryPrompt() {
  return [
    '【系统提示：你刚才的回复把[旧背景媒体]里的角色/物体当成了当前主语，但本轮没有当前焦点媒体，用户也没有指代旧媒体。】',
    '请重写：只回应当前用户这条消息或当前焦点；如果只是想表达情绪/态度，不要把旧图里的对象/广告/角色名拉回来。看不清就老实说看不清，不要凭旧描述续聊。',
  ].join('\n')
}

module.exports = {
  shouldRetryRepeatedReply,
  buildRepeatRetryPrompt,
  pickAbusiveFallbackReply,
  pickRepeatedFallbackReply,
  isConsecutiveUserRepeat,
  isUnsafeThinkingReply,
  stripStickerMarkersForGuard,
  hasInternalContextLeak,
  detectOldMediaTopicSticking,
  buildOldMediaStickingRetryPrompt,
}
