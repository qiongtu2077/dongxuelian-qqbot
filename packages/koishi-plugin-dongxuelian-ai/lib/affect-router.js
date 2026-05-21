/**
 * MODULE: Affect output diagnostics.
 * Responsibility: Judge whether text/voice/emoji output would be safe for the current turn.
 * Boundary: Read-only diagnostics. Does not send, synthesize speech, pick stickers, or change probability.
 * State: None.
 */
const crypto = require('crypto')

const AFFECT_ROUTER_VERSION = 1
const DEFAULT_AFFECT_POLICY = Object.freeze({
  allowVoice: true,
  allowEmoji: false,
  allowVoiceOnly: false,
  maxPlayfulStrength: 0.4,
  seriousMode: 'text_only',
  blockedMoods: ['meme_spam'],
})

const PERSONA_AFFECT_PRESETS = Object.freeze({
  '长离': { allowVoice: true, allowEmoji: false, allowVoiceOnly: false, maxPlayfulStrength: 0.15, seriousMode: 'text_only' },
  '特蕾西娅': { allowVoice: true, allowEmoji: false, allowVoiceOnly: false, maxPlayfulStrength: 0.15, seriousMode: 'text_only' },
  '爱弥斯': { allowVoice: true, allowEmoji: false, allowVoiceOnly: false, maxPlayfulStrength: 0.2, seriousMode: 'text_only' },
})

const SENSITIVE_REFUSAL_RE = /别问了，这个我不聊|这话我接不了|不合适|换一句吧|敏感|隐私|越狱|prompt|系统提示|开发者消息|不能透露/i
const COMFORT_RE = /难受|不想活|想死|崩溃|抑郁|焦虑|好累|撑不住|没人喜欢|活不下去|安慰|陪陪/i
const SERIOUS_RE = /怎么|如何|为什么|配置|部署|报错|失败|修复|风险|隐患|原因|测试|验证|方案/
const PLAYFUL_RE = /哈哈|笑死|乐|草|绷|可爱|卖萌|嘻嘻|嘿嘿|呀|喵|活泼/

function hashAffectValue(value = '', length = 10) {
  const text = String(value || '').trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, Math.max(6, Math.min(32, Number(length) || 10)))
}

function normalizeAffectText(value = '', maxLength = 160) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(20, Math.min(1000, Number(maxLength) || 160)))
}

function normalizeAffectPolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const blockedMoods = Array.isArray(source.blockedMoods)
    ? source.blockedMoods.map(item => normalizeAffectText(item, 40)).filter(Boolean).slice(0, 12)
    : DEFAULT_AFFECT_POLICY.blockedMoods.slice()
  const maxPlayfulStrength = Number(source.maxPlayfulStrength)
  return {
    allowVoice: source.allowVoice === undefined ? DEFAULT_AFFECT_POLICY.allowVoice : !!source.allowVoice,
    allowEmoji: source.allowEmoji === undefined ? DEFAULT_AFFECT_POLICY.allowEmoji : !!source.allowEmoji,
    allowVoiceOnly: source.allowVoiceOnly === undefined ? DEFAULT_AFFECT_POLICY.allowVoiceOnly : !!source.allowVoiceOnly,
    maxPlayfulStrength: Number.isFinite(maxPlayfulStrength) ? Math.max(0, Math.min(1, maxPlayfulStrength)) : DEFAULT_AFFECT_POLICY.maxPlayfulStrength,
    seriousMode: normalizeAffectText(source.seriousMode || DEFAULT_AFFECT_POLICY.seriousMode, 40) || DEFAULT_AFFECT_POLICY.seriousMode,
    blockedMoods,
  }
}

function resolveAffectPolicy(plan = {}, options = {}) {
  const personaName = normalizeAffectText(options.personaName || plan.name || '', 80)
  const preset = PERSONA_AFFECT_PRESETS[personaName] || {}
  return normalizeAffectPolicy({
    ...DEFAULT_AFFECT_POLICY,
    ...preset,
    ...(plan.affect || {}),
    ...(options.policy || {}),
  })
}

function classifyAffectMood(input = {}) {
  const reply = normalizeAffectText(input.replyText || input.reply || '', 500)
  const userText = normalizeAffectText(input.userText || '', 500)
  const risk = String(input.risk || '').toLowerCase()
  if (risk === 'sensitive' || risk === 'refusal' || SENSITIVE_REFUSAL_RE.test(reply) || SENSITIVE_REFUSAL_RE.test(userText)) return 'refuse'
  if (risk === 'comfort' || COMFORT_RE.test(userText)) return 'comfort'
  if (risk === 'serious' || SERIOUS_RE.test(userText)) return 'serious'
  if (PLAYFUL_RE.test(reply) || PLAYFUL_RE.test(userText)) return 'playful'
  return 'neutral'
}

function buildAffectRouterDiagnostic(input = {}) {
  const plan = input.plan || {}
  const personaName = normalizeAffectText(input.personaName || plan.name || '', 80)
  const policy = resolveAffectPolicy(plan, { personaName, policy: input.policy })
  const mood = classifyAffectMood(input)
  const reasons = []
  const blockers = []
  const outputs = {
    text: { allowed: true, reasons: ['text_baseline'] },
    voice: { allowed: true, reasons: [] },
    emoji: { allowed: false, reasons: [] },
    voiceOnly: { allowed: false, reasons: [] },
  }

  if (mood === 'refuse') {
    blockers.push('safety_refusal_text_only')
    outputs.voice.allowed = false
    outputs.voice.reasons.push('blocked_by_safety_refusal')
    outputs.emoji.allowed = false
    outputs.emoji.reasons.push('blocked_by_safety_refusal')
    outputs.voiceOnly.allowed = false
    outputs.voiceOnly.reasons.push('blocked_by_safety_refusal')
  } else if (mood === 'comfort') {
    blockers.push('comfort_no_joke_emoji')
    outputs.emoji.allowed = false
    outputs.emoji.reasons.push('blocked_by_comfort_context')
    outputs.voiceOnly.allowed = false
    outputs.voiceOnly.reasons.push('blocked_by_comfort_context')
  } else if (mood === 'serious' && policy.seriousMode === 'text_only') {
    blockers.push('serious_text_only')
    outputs.emoji.allowed = false
    outputs.emoji.reasons.push('blocked_by_serious_context')
    outputs.voiceOnly.allowed = false
    outputs.voiceOnly.reasons.push('blocked_by_serious_context')
  }

  if (!policy.allowVoice) {
    outputs.voice.allowed = false
    outputs.voice.reasons.push('blocked_by_policy')
  }
  if (!policy.allowEmoji) {
    outputs.emoji.allowed = false
    outputs.emoji.reasons.push('blocked_by_policy')
  } else if (!blockers.includes('safety_refusal_text_only') && mood !== 'comfort' && mood !== 'serious') {
    outputs.emoji.allowed = true
    outputs.emoji.reasons.push('policy_allows_emoji')
  }
  if (!policy.allowVoiceOnly) {
    outputs.voiceOnly.allowed = false
    outputs.voiceOnly.reasons.push('blocked_by_policy')
  }
  if (input.voiceCandidate && Number(input.randomVoiceRate || 0) <= 0) {
    outputs.voice.allowed = false
    outputs.voice.reasons.push('random_voice_probability_zero')
  }
  if (input.voiceCandidate && input.voiceCooldownActive) {
    outputs.voice.allowed = false
    outputs.voice.reasons.push('voice_cooldown_active')
  }
  if (input.voiceCandidate && input.voiceAssetMissing) {
    outputs.voice.allowed = false
    outputs.voice.reasons.push('voice_asset_missing')
  }
  if (mood === 'playful' && policy.maxPlayfulStrength <= 0.2) {
    reasons.push('playful_limited_by_persona')
  }
  if (personaName) reasons.push('persona_policy_resolved')
  if (input.randomTriggered) reasons.push('random_reply_context')
  if (input.agentRetell) reasons.push('agent_retell_context')

  const recommendedMode = outputs.voice.allowed && input.voiceCandidate ? 'text_voice' : 'text'
  return {
    version: AFFECT_ROUTER_VERSION,
    mood,
    recommendedMode,
    persona: {
      name: personaName,
      hash: hashAffectValue(personaName),
    },
    policy,
    outputs,
    blockers,
    reasons,
    context: {
      replyHash: hashAffectValue(input.replyText || input.reply || ''),
      userHash: hashAffectValue(input.userText || ''),
      randomTriggered: !!input.randomTriggered,
      voiceCandidate: !!input.voiceCandidate,
      agentRetell: !!input.agentRetell,
    },
  }
}

function formatAffectRouterDiagnostic(diagnostic = {}) {
  const outputs = diagnostic.outputs || {}
  const outputText = Object.entries(outputs)
    .map(([key, value]) => `${key}:${value && value.allowed ? 'allow' : 'block'}`)
    .join(',')
  return [
    `mood=${diagnostic.mood || 'neutral'}`,
    `mode=${diagnostic.recommendedMode || 'text'}`,
    `persona=${diagnostic.persona?.hash || 'none'}`,
    `outputs=${outputText || 'none'}`,
    `blockers=${(diagnostic.blockers || []).join('|') || 'none'}`,
    `reasons=${(diagnostic.reasons || []).join('|') || 'none'}`,
  ].join(' ')
}

module.exports = {
  AFFECT_ROUTER_VERSION,
  DEFAULT_AFFECT_POLICY,
  PERSONA_AFFECT_PRESETS,
  hashAffectValue,
  normalizeAffectText,
  normalizeAffectPolicy,
  resolveAffectPolicy,
  classifyAffectMood,
  buildAffectRouterDiagnostic,
  formatAffectRouterDiagnostic,
}
