/**
 * MODULE: Reply timing diagnostics.
 * Responsibility: Explain the existing reply/random timing path without changing it.
 * Boundary: Pure diagnostics; no message sending, no probability calculation ownership, no file writes.
 * State: None.
 */
const crypto = require('crypto')

const REPLY_TIMING_DIAGNOSTIC_VERSION = 1

function replyTimingBoolean(value) {
  return value === true
}

function replyTimingNumber(value, fallback = 0, min = 0, max = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function replyTimingText(value = '', maxLength = 80) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function replyTimingHash(value = '') {
  const text = String(value || '').trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function addReplyTimingTag(list, tag) {
  const value = replyTimingText(tag, 80)
  if (value && !list.includes(value)) list.push(value)
}

function buildReplyTimingDiagnostic(input = {}) {
  const phase = replyTimingText(input.phase || 'initial', 40) || 'initial'
  const inGuild = replyTimingBoolean(input.inGuild)
  const isPrivate = replyTimingBoolean(input.isPrivate)
  const directAt = replyTimingBoolean(input.directAt)
  const nameMentioned = replyTimingBoolean(input.nameMentioned)
  const otherMentions = replyTimingBoolean(input.otherMentions)
  const inRandomWhitelist = replyTimingBoolean(input.inRandomWhitelist)
  const isRandomCandidate = replyTimingBoolean(input.isRandomCandidate)
  const randomHit = replyTimingBoolean(input.randomHit)
  const randomTriggered = replyTimingBoolean(input.randomTriggered)
  const delayedRandomScheduled = replyTimingBoolean(input.delayedRandomScheduled)
  const cooldownActive = replyTimingBoolean(input.cooldownActive)
  const mutedActive = replyTimingBoolean(input.mutedActive)
  const highRisk = replyTimingBoolean(input.highRisk)
  const explicitCanceled = replyTimingBoolean(input.explicitCanceled)
  const baseRate = replyTimingNumber(input.baseRate, 0, 0, 1)
  const willFactor = replyTimingNumber(input.willFactor, 1, 0, 5)
  const effectiveRate = replyTimingNumber(
    input.effectiveRate === undefined ? baseRate * willFactor : input.effectiveRate,
    0,
    0,
    1,
  )
  const missCount = Math.max(0, Math.floor(replyTimingNumber(input.missCount, 0, 0, Number.MAX_SAFE_INTEGER)))
  const reasons = []
  const blockers = []

  if (isPrivate) addReplyTimingTag(reasons, 'private_must_reply')
  if (directAt) addReplyTimingTag(reasons, 'direct_at_must_reply')
  if (nameMentioned) addReplyTimingTag(reasons, 'name_mentioned_must_reply')
  if (inGuild && inRandomWhitelist) addReplyTimingTag(reasons, 'random_whitelist_allowed')
  if (isRandomCandidate) addReplyTimingTag(reasons, 'legacy_random_candidate')
  if (randomHit) addReplyTimingTag(reasons, 'legacy_probability_hit')
  if (randomTriggered) addReplyTimingTag(reasons, 'legacy_random_triggered')
  if (delayedRandomScheduled) addReplyTimingTag(reasons, 'delayed_for_consecutive_messages')
  if (highRisk) addReplyTimingTag(reasons, 'persona_switch_quote_risk')
  if (Math.abs(willFactor - 1) > 0.0001) addReplyTimingTag(reasons, 'will_factor_applied')
  if (missCount > 0) addReplyTimingTag(reasons, 'miss_count_accumulated')
  if (phase !== 'initial') addReplyTimingTag(reasons, phase)

  if (inGuild && !directAt && !nameMentioned && !inRandomWhitelist) addReplyTimingTag(blockers, 'random_whitelist_missing')
  if (otherMentions) addReplyTimingTag(blockers, 'other_mentions_present')
  if (replyTimingBoolean(input.skipForRandomReply)) addReplyTimingTag(blockers, 'content_skipped_for_random')
  if (cooldownActive) addReplyTimingTag(blockers, 'random_cooldown_active')
  if (mutedActive) addReplyTimingTag(blockers, 'channel_muted_by_user_command')
  if (explicitCanceled) addReplyTimingTag(blockers, 'explicit_interaction_cancelled')
  if (!replyTimingBoolean(input.hasUsableText) && !replyTimingBoolean(input.hasVisual)) addReplyTimingTag(blockers, 'no_usable_text')
  if (isRandomCandidate && effectiveRate <= 0) addReplyTimingTag(blockers, 'random_rate_zero')
  if (isRandomCandidate && !randomHit && effectiveRate > 0) addReplyTimingTag(blockers, 'legacy_probability_miss')

  let decision = 'silent'
  if (isPrivate || directAt || nameMentioned) decision = 'must_reply'
  else if (delayedRandomScheduled) decision = 'delay'
  else if (randomTriggered) decision = 'may_reply'
  else if (randomHit) decision = 'may_reply'

  const score = decision === 'must_reply'
    ? 1
    : decision === 'delay'
      ? Math.max(0.05, effectiveRate)
      : decision === 'may_reply'
        ? Math.max(0.05, effectiveRate)
        : 0

  return {
    version: REPLY_TIMING_DIAGNOSTIC_VERSION,
    kind: 'reply_timing',
    phase,
    decision,
    score: Number(score.toFixed(4)),
    reasons,
    blockers,
    legacy: {
      candidate: isRandomCandidate,
      randomHit,
      randomTriggered,
      delayedRandomScheduled,
      baseRate,
      effectiveRate,
      willFactor,
      missCount,
    },
    persona: {
      name: replyTimingText(input.personaName || '', 80),
      source: replyTimingText(input.personaSource || '', 40),
      groupName: replyTimingText(input.groupPersonaName || '', 80),
      highRisk,
    },
    message: {
      channelHash: replyTimingHash(input.channelKey),
      inGuild,
      isPrivate,
      directAt,
      otherMentions,
      nameMentioned,
      hasUsableText: replyTimingBoolean(input.hasUsableText),
      hasLink: replyTimingBoolean(input.hasLink),
      hasVisual: replyTimingBoolean(input.hasVisual),
      hasFile: replyTimingBoolean(input.hasFile),
      hasEmbed: replyTimingBoolean(input.hasEmbed),
      skipForRandomReply: replyTimingBoolean(input.skipForRandomReply),
    },
  }
}

function formatReplyTimingDiagnostic(diagnostic = {}) {
  const legacy = diagnostic.legacy || {}
  const persona = diagnostic.persona || {}
  const message = diagnostic.message || {}
  const reasons = Array.isArray(diagnostic.reasons) && diagnostic.reasons.length ? diagnostic.reasons.join(',') : 'none'
  const blockers = Array.isArray(diagnostic.blockers) && diagnostic.blockers.length ? diagnostic.blockers.join(',') : 'none'
  return [
    `phase=${replyTimingText(diagnostic.phase || 'initial', 40)}`,
    `decision=${replyTimingText(diagnostic.decision || 'silent', 40)}`,
    `score=${replyTimingNumber(diagnostic.score, 0, 0, 1).toFixed(3)}`,
    `channel=${replyTimingText(message.channelHash || 'none', 20)}`,
    `persona=${replyTimingText(persona.name || 'default', 80) || 'default'}`,
    `source=${replyTimingText(persona.source || 'default', 40) || 'default'}`,
    `risk=${persona.highRisk === true}`,
    `candidate=${legacy.candidate === true}`,
    `hit=${legacy.randomHit === true}`,
    `triggered=${legacy.randomTriggered === true}`,
    `delayed=${legacy.delayedRandomScheduled === true}`,
    `rate=${replyTimingNumber(legacy.effectiveRate, 0, 0, 1).toFixed(4)}`,
    `will=${replyTimingNumber(legacy.willFactor, 1, 0, 5).toFixed(3)}`,
    `miss=${Math.max(0, Math.floor(replyTimingNumber(legacy.missCount, 0, 0, Number.MAX_SAFE_INTEGER)))}`,
    `reasons=${reasons}`,
    `blockers=${blockers}`,
  ].join(' ')
}

module.exports = {
  REPLY_TIMING_DIAGNOSTIC_VERSION,
  replyTimingHash,
  buildReplyTimingDiagnostic,
  formatReplyTimingDiagnostic,
}
