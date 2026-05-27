/**
 * MODULE: random-state
 * 职责: 持有随机回复的频道状态、版本号、pending timer 与发送 freshness 判断。
 * 边界: 不调用 chat/Agent、不发送消息、不读取业务配置；基础概率由调用方注入。
 * 状态: channelMissCount / mute / cooldown / pending / message-version Maps。
 */
const {
  RANDOM_TRIGGER_WARMUP,
  RANDOM_TRIGGER_RAMP,
} = require('../core/constants') as typeof import('../core/constants')

interface PendingRandomEntry {
  timer?: NodeJS.Timeout
  [key: string]: unknown
}

interface RandomSendContext {
  randomTriggered?: boolean
  channelKey?: string
  triggerMessageVersion?: number
  explicitVersion?: number
  triggerAt?: number
  highRisk?: boolean
  triggerMessageId?: string
  delayed?: boolean
  currentMessageVersion?: number
}

interface RandomFreshness {
  channelKey: string
  triggerMessageVersion: number
  explicitVersion: number
  triggerAt: number
}

interface RandomSendOptions {
  randomFreshness?: RandomFreshness
  forceQuote?: boolean
  quoteMessageId?: string
  [key: string]: unknown
}

const channelMissCount: Map<string, number> = new Map()
const channelMutedUntil: Map<string, number> = new Map()
const lastRandomReplyTs: Map<string, number> = new Map()
const channelPendingRandom: Map<string, PendingRandomEntry> = new Map()
const channelMessageVersions: Map<string, number> = new Map()
const channelExplicitVersions: Map<string, number> = new Map()
const MAX_RANDOM_CHANNEL_STATE_ENTRIES = 200

function normalizeChannelKey(channelKey: string): string {
  return String(channelKey || '')
}

function getRandomMissCount(channelKey: string): number {
  return channelMissCount.get(normalizeChannelKey(channelKey)) || 0
}

function setRandomMissCount(channelKey: string, count: number): number {
  const key = normalizeChannelKey(channelKey)
  if (!key) return 0
  const value = Math.max(0, Number(count) || 0)
  channelMissCount.set(key, value)
  return value
}

function incrementRandomMiss(channelKey: string): number {
  return setRandomMissCount(channelKey, getRandomMissCount(channelKey) + 1)
}

function resetRandomMiss(channelKey: string): number {
  return setRandomMissCount(channelKey, 0)
}

function getRandomTriggerRate(channelKey: string, getBaseRate: number | ((channelKey: string) => number)): number {
  const baseRate = typeof getBaseRate === 'function'
    ? Number(getBaseRate(channelKey)) || 0
    : Number(getBaseRate) || 0
  if (!baseRate || baseRate <= 0) return 0
  const miss = getRandomMissCount(channelKey)
  if (miss < RANDOM_TRIGGER_WARMUP) return baseRate
  return baseRate + (miss - RANDOM_TRIGGER_WARMUP) * RANDOM_TRIGGER_RAMP
}

function isRandomCooldownActive(channelKey: string, now: number = Date.now(), cooldownMs: number = 15000): boolean {
  const key = normalizeChannelKey(channelKey)
  return lastRandomReplyTs.has(key) && now - (lastRandomReplyTs.get(key) || 0) < cooldownMs
}

function markRandomReplySent(channelKey: string, now: number = Date.now()): void {
  const key = normalizeChannelKey(channelKey)
  if (!key) return
  lastRandomReplyTs.set(key, now)
}

function getRandomMuteRemaining(channelKey: string, now: number = Date.now()): number {
  return Math.max(0, (channelMutedUntil.get(normalizeChannelKey(channelKey)) || 0) - now)
}

function muteRandomChannel(channelKey: string, durationMs: number = 600000, now: number = Date.now()): boolean {
  const key = normalizeChannelKey(channelKey)
  if (!key) return false
  if (getRandomMuteRemaining(key, now) >= durationMs) return false
  channelMutedUntil.set(key, now + durationMs)
  return true
}

function isRandomMuted(channelKey: string, now: number = Date.now()): boolean {
  return getRandomMuteRemaining(channelKey, now) > 0
}

function getChannelMessageVersion(channelKey: string): number {
  return channelMessageVersions.get(normalizeChannelKey(channelKey)) || 0
}

function bumpChannelMessageVersion(channelKey: string): number {
  const key = normalizeChannelKey(channelKey)
  if (!key) return getChannelMessageVersion(key)
  const next = getChannelMessageVersion(key) + 1
  channelMessageVersions.set(key, next)
  trimRandomChannelState()
  return next
}

function getExplicitInteractionVersion(channelKey: string): number {
  return channelExplicitVersions.get(normalizeChannelKey(channelKey)) || 0
}

function bumpExplicitInteractionVersion(channelKey: string): number {
  const key = normalizeChannelKey(channelKey)
  if (!key) return getExplicitInteractionVersion(key)
  const next = getExplicitInteractionVersion(key) + 1
  channelExplicitVersions.set(key, next)
  trimRandomChannelState()
  return next
}

function trimRandomChannelState(): void {
  if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES) return
  for (const key of channelMessageVersions.keys()) {
    if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES) break
    if (channelPendingRandom.has(key)) continue
    channelMessageVersions.delete(key)
    channelExplicitVersions.delete(key)
  }
}

function getPendingRandom(channelKey: string): PendingRandomEntry | null {
  return channelPendingRandom.get(normalizeChannelKey(channelKey)) || null
}

function setPendingRandom(channelKey: string, entry: PendingRandomEntry): boolean {
  const key = normalizeChannelKey(channelKey)
  if (!key) return false
  channelPendingRandom.set(key, entry)
  return true
}

function takePendingRandom(channelKey: string): PendingRandomEntry | null {
  const key = normalizeChannelKey(channelKey)
  const pending = channelPendingRandom.get(key) || null
  channelPendingRandom.delete(key)
  return pending
}

function cancelPendingRandom(channelKey: string, reason: string = ''): boolean {
  const key = normalizeChannelKey(channelKey)
  const pending = channelPendingRandom.get(key)
  if (!pending) return false
  if (pending.timer) clearTimeout(pending.timer)
  channelPendingRandom.delete(key)
  return true
}

function clearRandomPendingState(): void {
  for (const [, entry] of channelPendingRandom) {
    if (entry && entry.timer) clearTimeout(entry.timer)
  }
  channelPendingRandom.clear()
  channelMessageVersions.clear()
  channelExplicitVersions.clear()
}

function buildRandomSendOptions(context: RandomSendContext = {}): RandomSendOptions {
  if (!context.randomTriggered) return {}
  const channelKey = normalizeChannelKey(context.channelKey)
  const triggerVersion = Number(context.triggerMessageVersion || 0)
  const explicitVersion = Number(context.explicitVersion || 0)
  const triggerAt = Number(context.triggerAt || 0)
  return {
    randomFreshness: {
      channelKey,
      triggerMessageVersion: triggerVersion,
      explicitVersion,
      triggerAt,
    },
    ...(context.randomTriggered && context.highRisk && context.triggerMessageId && (context.delayed || Number(context.currentMessageVersion || 0) > triggerVersion)
      ? { forceQuote: true, quoteMessageId: String(context.triggerMessageId) }
      : {}),
  }
}

function isRandomReplyFresh(options: RandomSendOptions = {}, now: number = Date.now()): boolean {
  const info = options.randomFreshness || null
  if (!info || !info.channelKey) return true
  const channelKey = normalizeChannelKey(info.channelKey)
  const triggerVersion = Number(info.triggerMessageVersion || 0)
  const explicitVersion = Number(info.explicitVersion || 0)
  const triggerAt = Number(info.triggerAt || 0)
  if (triggerAt > 0 && now - triggerAt > 60000) return false
  if (getExplicitInteractionVersion(channelKey) !== explicitVersion) return false
  if (getChannelMessageVersion(channelKey) > triggerVersion) return false
  return true
}

function isSafeSendReplyFresh(isRandom: boolean = false, sendOptions: RandomSendOptions = {}): boolean {
  if (!isRandom) return true
  return isRandomReplyFresh(sendOptions)
}

export = {
  channelMissCount,
  getRandomMissCount,
  setRandomMissCount,
  incrementRandomMiss,
  resetRandomMiss,
  getRandomTriggerRate,
  isRandomCooldownActive,
  markRandomReplySent,
  getRandomMuteRemaining,
  muteRandomChannel,
  isRandomMuted,
  getChannelMessageVersion,
  bumpChannelMessageVersion,
  getExplicitInteractionVersion,
  bumpExplicitInteractionVersion,
  trimRandomChannelState,
  getPendingRandom,
  setPendingRandom,
  takePendingRandom,
  cancelPendingRandom,
  clearRandomPendingState,
  buildRandomSendOptions,
  isRandomReplyFresh,
  isSafeSendReplyFresh,
}
