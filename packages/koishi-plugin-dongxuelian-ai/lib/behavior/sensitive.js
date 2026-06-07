"use strict";
/**
 * MODULE: 敏感话题检测。
 * 职责: 政治敏感关键词检测、handler 通知、运行时状态管理。
 * 边界: 不调 AI API，不改 conversation 持久层。检测结果通过 notifySensitiveHandlers 分发。
 */
const path = require('path');
const { POLITICAL_DETECT_FILE, POLITICAL_HANDLER_DIR, SENSITIVE_KEYWORDS_RE, } = require('../core/constants');
const { readTextFile, readJsonFile, safeChannelKey, errorMessage, } = require('../core/utils');
const { logDebug } = require('../core/logging-config');
const { channelSharedCache, pendingSensitiveAlert, clearUserConversationHistory, saveSensitiveCache, analyzeChannelSensitive, consumePendingSensitiveAlert, clearPendingSensitiveAlert, } = require('../conversation');
const channelMsgCount = new Map();
const lastSensitiveAlert = new Map();
let politicalDetectCache = null;
let politicalDetectCacheExpiresAt = 0;
const SENSITIVE_RUNTIME_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SENSITIVE_RUNTIME_ENTRIES = 500;
function getSensitiveErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function warnSensitiveBackgroundFailure(action, error) {
    console.warn(`[dongxuelian-ai] sensitive ${action} failed: ${getSensitiveErrorMessage(error)}`);
}
function toSensitiveLogContext(ctx) {
    if (!ctx || typeof ctx !== 'object')
        return null;
    const logger = ctx.logger;
    if (logger !== undefined && typeof logger !== 'function')
        return null;
    return ctx;
}
async function getPoliticalDetectList() {
    if (politicalDetectCache !== null && Date.now() < politicalDetectCacheExpiresAt)
        return politicalDetectCache;
    const raw = await readTextFile(POLITICAL_DETECT_FILE).catch(() => '[]');
    try {
        const parsed = JSON.parse(raw || '[]');
        politicalDetectCache = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    }
    catch (error) {
        console.warn(`[dongxuelian-ai] political detect list parse failed: ${errorMessage(error)}`);
        politicalDetectCache = new Set();
    }
    politicalDetectCacheExpiresAt = Date.now() + 30000;
    return politicalDetectCache;
}
function resetPoliticalDetectCache() {
    politicalDetectCache = null;
    politicalDetectCacheExpiresAt = 0;
}
function clearSensitiveRuntimeState(channelKey) {
    const key = String(channelKey);
    channelMsgCount.delete(key);
    lastSensitiveAlert.delete(key);
    clearPendingSensitiveAlert(key);
}
function pruneRuntimeMap(map, getTs, now = Date.now()) {
    for (const [key, value] of map) {
        const ts = Number(getTs(value)) || 0;
        if (ts && now - ts > SENSITIVE_RUNTIME_TTL_MS)
            map.delete(key);
    }
    if (map.size <= MAX_SENSITIVE_RUNTIME_ENTRIES)
        return;
    const ordered = Array.from(map.entries()).sort((a, b) => (Number(getTs(a[1])) || 0) - (Number(getTs(b[1])) || 0));
    for (const [key] of ordered.slice(0, map.size - MAX_SENSITIVE_RUNTIME_ENTRIES))
        map.delete(key);
}
function trimSensitiveRuntimeMaps(now = Date.now()) {
    pruneRuntimeMap(channelMsgCount, entry => entry && typeof entry === 'object' ? entry.ts : 0, now);
    pruneRuntimeMap(lastSensitiveAlert, ts => ts, now);
    pruneRuntimeMap(pendingSensitiveAlert, entry => entry && typeof entry === 'object' ? entry.ts : 0, now);
}
async function notifySensitiveHandlers(session, channelKey, options = {}) {
    const key = String(channelKey);
    trimSensitiveRuntimeMaps();
    const throttle = options.throttle !== false;
    if (throttle && Date.now() - (lastSensitiveAlert.get(key) || 0) <= 30000)
        return false;
    const safeKey = safeChannelKey(key);
    const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeKey + '.json');
    const handlers = await readJsonFile(handlerFile, []);
    if (!Array.isArray(handlers) || handlers.length === 0)
        return false;
    const atAll = handlers.map(id => `<at id="${id}"/>`).join(' ');
    const message = options.message || `管理员快来，群里有傻福在剑阵。${atAll}`;
    session.send(message).catch((error) => warnSensitiveBackgroundFailure('handler notification', error));
    if (throttle)
        lastSensitiveAlert.set(key, Date.now());
    return true;
}
async function handleSensitiveMessage(session, ctx, params = {}) {
    const { inGuild, channelKey, analyzed = {}, plain = '', userName = '', currentUserId = '', lastEmotionCache, } = params;
    const normalizedChannelKey = String(channelKey || '');
    const logCtx = toSensitiveLogContext(ctx);
    const detectList = await getPoliticalDetectList();
    const isDetectOn = detectList.has(normalizedChannelKey);
    const normalizedPlain = String(plain || '').normalize('NFKC').replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '');
    if (inGuild && isDetectOn && !analyzed.hasVisual && SENSITIVE_KEYWORDS_RE.test(normalizedPlain)) {
        await notifySensitiveHandlers(session, normalizedChannelKey, { throttle: true });
        logDebug(logCtx, 'sensitive', `sensitive topic channel=${normalizedChannelKey} textLen=${String(plain || '').length}`);
        channelSharedCache.delete(normalizedChannelKey);
        clearUserConversationHistory(session);
        channelMsgCount.delete(normalizedChannelKey);
        if (lastEmotionCache && typeof lastEmotionCache.delete === 'function')
            lastEmotionCache.delete(normalizedChannelKey);
    }
    if (inGuild && isDetectOn && !analyzed.hasVisual && plain) {
        saveSensitiveCache(normalizedChannelKey, plain, userName, currentUserId);
    }
    if (isDetectOn && inGuild && !analyzed.hasVisual) {
        const current = channelMsgCount.get(normalizedChannelKey);
        const count = (current?.count || 0) + 1;
        channelMsgCount.set(normalizedChannelKey, { count, ts: Date.now() });
        if (count % 50 === 0)
            analyzeChannelSensitive(normalizedChannelKey).catch((error) => warnSensitiveBackgroundFailure('periodic summary', error));
    }
    if (isDetectOn && consumePendingSensitiveAlert(normalizedChannelKey)) {
        channelSharedCache.delete(normalizedChannelKey);
        channelMsgCount.delete(normalizedChannelKey);
        if (lastEmotionCache && typeof lastEmotionCache.delete === 'function')
            lastEmotionCache.delete(normalizedChannelKey);
        await notifySensitiveHandlers(session, normalizedChannelKey, { throttle: false });
    }
    return { isDetectOn };
}
module.exports = {
    getPoliticalDetectList,
    resetPoliticalDetectCache,
    clearSensitiveRuntimeState,
    trimSensitiveRuntimeMaps,
    notifySensitiveHandlers,
    handleSensitiveMessage,
    channelMsgCount,
    lastSensitiveAlert,
};
