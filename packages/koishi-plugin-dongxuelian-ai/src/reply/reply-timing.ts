/**
 * MODULE: Reply timing diagnostics.
 * Responsibility: Explain the existing reply/random timing path without changing it.
 * Boundary: Pure diagnostics; no message sending, no probability calculation ownership, no file writes.
 * State: None.
 */
const crypto = require('crypto')

const REPLY_TIMING_DIAGNOSTIC_VERSION = 1

interface ReplyTimingInput {
  phase?: unknown
  inGuild?: unknown
  isPrivate?: unknown
  directAt?: unknown
  nameMentioned?: unknown
  otherMentions?: unknown
  inRandomWhitelist?: unknown
  isRandomCandidate?: unknown
  randomHit?: unknown
  randomTriggered?: unknown
  delayedRandomScheduled?: unknown
  cooldownActive?: unknown
  mutedActive?: unknown
  highRisk?: unknown
  explicitCanceled?: unknown
  skipForRandomReply?: unknown
  hasUsableText?: unknown
  hasVisual?: unknown
  hasLink?: unknown
  hasFile?: unknown
  hasEmbed?: unknown
  baseRate?: unknown
  willFactor?: unknown
  effectiveRate?: unknown
  missCount?: unknown
  personaName?: unknown
  personaSource?: unknown
  groupPersonaName?: unknown
  channelKey?: unknown
}

interface ReplyTimingDiagnostic {
  version: number
  kind: string
  phase: string
  decision: string
  score: number
  reasons: string[]
  blockers: string[]
  legacy: {
    candidate: boolean
    randomHit: boolean
    randomTriggered: boolean
    delayedRandomScheduled: boolean
    baseRate: number
    effectiveRate: number
    willFactor: number
    missCount: number
  }
  persona: {
    name: string
    source: string
    groupName: string
    highRisk: boolean
  }
  message: {
    channelHash: string
    inGuild: boolean
    isPrivate: boolean
    directAt: boolean
    otherMentions: boolean
    nameMentioned: boolean
    hasUsableText: boolean
    hasLink: boolean
    hasVisual: boolean
    hasFile: boolean
    hasEmbed: boolean
    skipForRandomReply: boolean
  }
}

type PartialReplyTimingLegacy = Partial<ReplyTimingDiagnostic['legacy']>
type PartialReplyTimingPersona = Partial<ReplyTimingDiagnostic['persona']>
type PartialReplyTimingMessage = Partial<ReplyTimingDiagnostic['message']>

function replyTimingBoolean(value: unknown): boolean {
  return value === true
}

function replyTimingNumber(value: unknown, fallback: number = 0, min: number = 0, max: number = 1): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function replyTimingText(value: unknown = '', maxLength: number = 80): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function replyTimingHash(value: unknown = ''): string {
  const text = String(value || '').trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function addReplyTimingTag(list: string[], tag: unknown): void {
  const value = replyTimingText(tag, 80)
  if (value && !list.includes(value)) list.push(value)
}

function buildReplyTimingDiagnostic(input: ReplyTimingInput = {}): ReplyTimingDiagnostic {
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
  const reasons: string[] = []
  const blockers: string[] = []

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

function formatReplyTimingDiagnostic(diagnostic: Partial<ReplyTimingDiagnostic> = {}): string {
  const legacy: PartialReplyTimingLegacy = diagnostic.legacy || {}
  const persona: PartialReplyTimingPersona = diagnostic.persona || {}
  const message: PartialReplyTimingMessage = diagnostic.message || {}
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

export = {
  REPLY_TIMING_DIAGNOSTIC_VERSION,
  replyTimingHash,
  buildReplyTimingDiagnostic,
  formatReplyTimingDiagnostic,
}
