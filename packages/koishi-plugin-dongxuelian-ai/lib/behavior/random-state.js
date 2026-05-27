"use strict";
/**
 * MODULE: random-state
 * 职责: 持有随机回复的频道状态、版本号、pending timer 与发送 freshness 判断。
 * 边界: 不调用 chat/Agent、不发送消息、不读取业务配置；基础概率由调用方注入。
 * 状态: channelMissCount / mute / cooldown / pending / message-version Maps。
 */
const { RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP, } = require('../core/constants');
const channelMissCount = new Map();
const channelMutedUntil = new Map();
const lastRandomReplyTs = new Map();
const channelPendingRandom = new Map();
const channelMessageVersions = new Map();
const channelExplicitVersions = new Map();
const MAX_RANDOM_CHANNEL_STATE_ENTRIES = 200;
function normalizeChannelKey(channelKey) {
    return String(channelKey || '');
}
function getRandomMissCount(channelKey) {
    return channelMissCount.get(normalizeChannelKey(channelKey)) || 0;
}
function setRandomMissCount(channelKey, count) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return 0;
    const value = Math.max(0, Number(count) || 0);
    channelMissCount.set(key, value);
    return value;
}
function incrementRandomMiss(channelKey) {
    return setRandomMissCount(channelKey, getRandomMissCount(channelKey) + 1);
}
function resetRandomMiss(channelKey) {
    return setRandomMissCount(channelKey, 0);
}
function getRandomTriggerRate(channelKey, getBaseRate) {
    const baseRate = typeof getBaseRate === 'function'
        ? Number(getBaseRate(channelKey)) || 0
        : Number(getBaseRate) || 0;
    if (!baseRate || baseRate <= 0)
        return 0;
    const miss = getRandomMissCount(channelKey);
    if (miss < RANDOM_TRIGGER_WARMUP)
        return baseRate;
    return baseRate + (miss - RANDOM_TRIGGER_WARMUP) * RANDOM_TRIGGER_RAMP;
}
function isRandomCooldownActive(channelKey, now = Date.now(), cooldownMs = 15000) {
    const key = normalizeChannelKey(channelKey);
    return lastRandomReplyTs.has(key) && now - (lastRandomReplyTs.get(key) || 0) < cooldownMs;
}
function markRandomReplySent(channelKey, now = Date.now()) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return;
    lastRandomReplyTs.set(key, now);
}
function getRandomMuteRemaining(channelKey, now = Date.now()) {
    return Math.max(0, (channelMutedUntil.get(normalizeChannelKey(channelKey)) || 0) - now);
}
function muteRandomChannel(channelKey, durationMs = 600000, now = Date.now()) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return false;
    if (getRandomMuteRemaining(key, now) >= durationMs)
        return false;
    channelMutedUntil.set(key, now + durationMs);
    return true;
}
function isRandomMuted(channelKey, now = Date.now()) {
    return getRandomMuteRemaining(channelKey, now) > 0;
}
function getChannelMessageVersion(channelKey) {
    return channelMessageVersions.get(normalizeChannelKey(channelKey)) || 0;
}
function bumpChannelMessageVersion(channelKey) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return getChannelMessageVersion(key);
    const next = getChannelMessageVersion(key) + 1;
    channelMessageVersions.set(key, next);
    trimRandomChannelState();
    return next;
}
function getExplicitInteractionVersion(channelKey) {
    return channelExplicitVersions.get(normalizeChannelKey(channelKey)) || 0;
}
function bumpExplicitInteractionVersion(channelKey) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return getExplicitInteractionVersion(key);
    const next = getExplicitInteractionVersion(key) + 1;
    channelExplicitVersions.set(key, next);
    trimRandomChannelState();
    return next;
}
function trimRandomChannelState() {
    if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES)
        return;
    for (const key of channelMessageVersions.keys()) {
        if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES)
            break;
        if (channelPendingRandom.has(key))
            continue;
        channelMessageVersions.delete(key);
        channelExplicitVersions.delete(key);
    }
}
function getPendingRandom(channelKey) {
    return channelPendingRandom.get(normalizeChannelKey(channelKey)) || null;
}
function setPendingRandom(channelKey, entry) {
    const key = normalizeChannelKey(channelKey);
    if (!key)
        return false;
    channelPendingRandom.set(key, entry);
    return true;
}
function takePendingRandom(channelKey) {
    const key = normalizeChannelKey(channelKey);
    const pending = channelPendingRandom.get(key) || null;
    channelPendingRandom.delete(key);
    return pending;
}
function cancelPendingRandom(channelKey, reason = '') {
    const key = normalizeChannelKey(channelKey);
    const pending = channelPendingRandom.get(key);
    if (!pending)
        return false;
    if (pending.timer)
        clearTimeout(pending.timer);
    channelPendingRandom.delete(key);
    return true;
}
function clearRandomPendingState() {
    for (const [, entry] of channelPendingRandom) {
        if (entry && entry.timer)
            clearTimeout(entry.timer);
    }
    channelPendingRandom.clear();
    channelMessageVersions.clear();
    channelExplicitVersions.clear();
}
function buildRandomSendOptions(context = {}) {
    if (!context.randomTriggered)
        return {};
    const channelKey = normalizeChannelKey(context.channelKey);
    const triggerVersion = Number(context.triggerMessageVersion || 0);
    const explicitVersion = Number(context.explicitVersion || 0);
    const triggerAt = Number(context.triggerAt || 0);
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
    };
}
function isRandomReplyFresh(options = {}, now = Date.now()) {
    const info = options.randomFreshness || null;
    if (!info || !info.channelKey)
        return true;
    const channelKey = normalizeChannelKey(info.channelKey);
    const triggerVersion = Number(info.triggerMessageVersion || 0);
    const explicitVersion = Number(info.explicitVersion || 0);
    const triggerAt = Number(info.triggerAt || 0);
    if (triggerAt > 0 && now - triggerAt > 60000)
        return false;
    if (getExplicitInteractionVersion(channelKey) !== explicitVersion)
        return false;
    if (getChannelMessageVersion(channelKey) > triggerVersion)
        return false;
    return true;
}
function isSafeSendReplyFresh(isRandom = false, sendOptions = {}) {
    if (!isRandom)
        return true;
    return isRandomReplyFresh(sendOptions);
}
module.exports = {
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
};
