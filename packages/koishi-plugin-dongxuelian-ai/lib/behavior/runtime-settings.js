"use strict";
/**
 * MODULE: 运行时随机配置缓存。
 * 职责: 读取和缓存群聊主动回复白名单与基础概率。
 * 边界: 不发送消息，不调用 AI API，不处理黑名单或命令路由。
 * 状态: randomWhitelistCache / randomRateCache 为进程内缓存，重启后重建。
 */
const { RANDOM_WHITELIST_FILE, RANDOM_RATE_FILE, DEFAULT_GROUP_RANDOM_WHITELIST, RANDOM_TRIGGER_RATE_BASE, NUMERIC_GROUP_ID_RE, } = require('../core/constants');
const { readJsonFile, getFileFingerprint } = require('../core/utils');
const randomWhitelistCache = new Set(DEFAULT_GROUP_RANDOM_WHITELIST);
const randomRateCache = new Map();
let runtimeSettingsLoaded = false;
let runtimeSettingsFingerprint = '';
async function getRuntimeSettingsFingerprint() {
    const [whitelistStamp, rateStamp] = await Promise.all([
        getFileFingerprint(RANDOM_WHITELIST_FILE),
        getFileFingerprint(RANDOM_RATE_FILE),
    ]);
    return `${whitelistStamp}|${rateStamp}`;
}
function refreshRandomWhitelistCache(whitelist) {
    randomWhitelistCache.clear();
    if (Array.isArray(whitelist)) {
        for (const item of whitelist) {
            const normalized = String(item || '').trim();
            if (NUMERIC_GROUP_ID_RE.test(normalized))
                randomWhitelistCache.add(normalized);
        }
    }
    else {
        for (const item of DEFAULT_GROUP_RANDOM_WHITELIST)
            randomWhitelistCache.add(item);
    }
}
function refreshRandomRateCache(rateMap) {
    randomRateCache.clear();
    if (!rateMap || typeof rateMap !== 'object')
        return;
    for (const [channelId, rawRate] of Object.entries(rateMap)) {
        const normalizedId = String(channelId || '').trim();
        const numericRate = Number(rawRate);
        if (!NUMERIC_GROUP_ID_RE.test(normalizedId))
            continue;
        if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate > 1)
            continue;
        randomRateCache.set(normalizedId, numericRate);
    }
}
async function loadRuntimeSettings(force = false) {
    const fingerprint = await getRuntimeSettingsFingerprint();
    if (!force && runtimeSettingsLoaded && fingerprint === runtimeSettingsFingerprint)
        return;
    const [whitelist, rateMap] = await Promise.all([
        readJsonFile(RANDOM_WHITELIST_FILE, [...DEFAULT_GROUP_RANDOM_WHITELIST]),
        readJsonFile(RANDOM_RATE_FILE, {}),
    ]);
    refreshRandomWhitelistCache(whitelist);
    refreshRandomRateCache(rateMap);
    runtimeSettingsLoaded = true;
    runtimeSettingsFingerprint = fingerprint;
}
function getRandomTriggerBaseRate(channelKey) {
    const key = String(channelKey || '');
    return randomRateCache.has(key) ? randomRateCache.get(key) : RANDOM_TRIGGER_RATE_BASE;
}
function getRandomWhitelistStatus(channelKey) {
    return randomWhitelistCache.has(String(channelKey || ''));
}
module.exports = {
    randomWhitelistCache,
    randomRateCache,
    loadRuntimeSettings,
    getRandomTriggerBaseRate,
    getRandomWhitelistStatus,
    getFileFingerprint,
};
