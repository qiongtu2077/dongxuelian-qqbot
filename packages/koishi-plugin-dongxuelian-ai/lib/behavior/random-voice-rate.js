"use strict";
/**
 * MODULE: 群聊随机语音升级概率。
 * 职责: 读取/保存每个群“已触发回复后升级为语音”的概率。
 * 边界: 不发送消息，不合成语音，不参与聊天模型调用。
 */
const fs = require('fs');
const { RANDOM_VOICE_RATE_FILE } = require('../core/constants');
const { readJsonFile, writeJsonFile } = require('../core/utils');
const DEFAULT_RANDOM_VOICE_RATE = 0.1;
let rateCache = null;
let rateCacheMtimeMs = 0;
function normalizeVoiceRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate))
        return null;
    if (rate < 0 || rate > 1)
        return null;
    return rate;
}
function normalizeRateMap(raw) {
    const map = new Map();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return map;
    for (const [channelKey, value] of Object.entries(raw)) {
        const key = String(channelKey || '').trim();
        const rate = normalizeVoiceRate(value);
        if (key && rate !== null)
            map.set(key, rate);
    }
    return map;
}
function readRateFileSync() {
    try {
        const stat = fs.statSync(RANDOM_VOICE_RATE_FILE);
        if (rateCache && stat.mtimeMs === rateCacheMtimeMs)
            return rateCache;
        const raw = JSON.parse(fs.readFileSync(RANDOM_VOICE_RATE_FILE, 'utf8'));
        rateCache = normalizeRateMap(raw);
        rateCacheMtimeMs = stat.mtimeMs;
        return rateCache;
    }
    catch { /* non-critical: missing or invalid random voice config falls back to defaults */
        rateCache = rateCache || new Map();
        rateCacheMtimeMs = 0;
        return rateCache;
    }
}
async function loadRandomVoiceRateCache() {
    rateCache = normalizeRateMap(await readJsonFile(RANDOM_VOICE_RATE_FILE, {}));
    try {
        rateCacheMtimeMs = fs.statSync(RANDOM_VOICE_RATE_FILE).mtimeMs;
    }
    catch { /* non-critical: mtime cache is only an optimization */
        rateCacheMtimeMs = 0;
    }
    return rateCache;
}
function getRandomVoiceRate(channelKey) {
    const cache = readRateFileSync();
    const key = String(channelKey || '');
    const cachedRate = cache.get(key);
    return cachedRate !== undefined ? cachedRate : DEFAULT_RANDOM_VOICE_RATE;
}
async function saveRateCache(cache) {
    await writeJsonFile(RANDOM_VOICE_RATE_FILE, Object.fromEntries(cache));
    try {
        rateCacheMtimeMs = fs.statSync(RANDOM_VOICE_RATE_FILE).mtimeMs;
    }
    catch { /* non-critical: mtime cache is refreshed on next load */
        rateCacheMtimeMs = 0;
    }
}
async function setRandomVoiceRate(channelKey, rate) {
    const key = String(channelKey || '').trim();
    const normalized = normalizeVoiceRate(rate);
    if (!key || normalized === null)
        return false;
    const cache = readRateFileSync();
    cache.set(key, normalized);
    rateCache = cache;
    await saveRateCache(cache);
    return true;
}
async function resetRandomVoiceRate(channelKey) {
    const key = String(channelKey || '').trim();
    if (!key)
        return false;
    const cache = readRateFileSync();
    const existed = cache.delete(key);
    rateCache = cache;
    await saveRateCache(cache);
    return existed;
}
function shouldTriggerRandomVoiceByRate(channelKey, randomFn = Math.random) {
    return randomFn() < getRandomVoiceRate(channelKey);
}
module.exports = {
    DEFAULT_RANDOM_VOICE_RATE,
    normalizeVoiceRate,
    loadRandomVoiceRateCache,
    getRandomVoiceRate,
    setRandomVoiceRate,
    resetRandomVoiceRate,
    shouldTriggerRandomVoiceByRate,
};
