"use strict";
/**
 * MODULE: 对话/记忆/印象持久层。
 * 职责: 对话历史读写、记忆系统（writeMemory/deleteMemory/getMemorySummary）、
 *       用户画像、复读指纹缓存、共享频道上下文。
 * 状态: replyFingerprintCache / sharedChannelCache / 各 Map 按 channelKey 索引。
 * 边界: 不调 AI API。读操作返回数据，写操作落盘。
 */
const path = require('path');
const fsp = require('fs/promises');
const { CONVERSATIONS_DIR, MEMORY_HISTORY_LIMIT, MAX_HISTORY_MESSAGES, CONVERSATION_EXPIRE_MS, CONVERSATION_SUMMARY_INTERVAL, MAX_REPEAT_CHECK_HISTORY, MAX_CHANNEL_SHARED_MESSAGES, MAX_REPLY_FINGERPRINT_HISTORY, MAX_CHANNEL_PROMPT_MESSAGES, MAX_THREAD_CONTEXT_MESSAGES, MAX_REPLY_CHAIN_DEPTH, SENSITIVE_CACHE_PREFIX, USER_PROFILE_DIR, TODAY_CACHE_PREFIX, SUMMARY_WHITELIST_FILE, DATA_DIR, } = require('./core/constants');
const { readJsonFile, writeJsonFile, sanitizeUserName, safeChannelKey, todayCst, todayCstMinusDays, formatShanghaiTime24h, normalizeText } = require('./core/utils');
const { appendGroupSceneEntry } = require('./routing/group-scene-index');
const { redactSensitiveText } = require('./core/redactor');
const { appendPrecomputeIndex } = require('./daily-precompute/precompute-index');
const { submitConversationSummaryTask, submitSensitiveCacheAnalysisTask, } = require('./resource-workers/background-llm-submission');
let conversationCache = new Map();
let replyFingerprintCache = new Map();
const conversationLastActiveAt = new Map();
const conversationCacheAccessAt = new Map();
const channelSharedCache = new Map();
const lastForwardSummaryCache = new Map();
const lastForwardSummaryCacheTs = new Map();
const pendingSensitiveAlert = new Map();
const summaryLocks = new Map();
const channelTodayCache = new Map();
const SENSITIVE_ALERT_DIR = path.join(DATA_DIR, 'sensitive-alerts');
const SENSITIVE_ALERT_TTL_MS = 2 * 60 * 60 * 1000;
const writeQueues = new Map();
function enqueueWrite(key, fn) {
    const prev = writeQueues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    writeQueues.set(key, next);
    next.finally(() => { if (writeQueues.get(key) === next)
        writeQueues.delete(key); });
    return next;
}
const CHANNEL_RUNTIME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CHANNEL_RUNTIME_CACHE_ENTRIES = 200;
const MAX_CONVERSATION_CACHE_ENTRIES = 400;
const MAX_TODAY_CACHE_MESSAGES = parseConversationPositiveInt(process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES, 5000, 500, 20000);
const MAX_TODAY_CACHE_CONTENT_CHARS = parseConversationPositiveInt(process.env.DONGXUELIAN_TODAY_CACHE_MAX_CONTENT_CHARS, 500, 80, 2000);
const MAX_SENSITIVE_CACHE_MESSAGES = parseConversationPositiveInt(process.env.DONGXUELIAN_SENSITIVE_CACHE_MAX_MESSAGES, 60, 10, 500);
const MAX_SENSITIVE_CACHE_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_SENSITIVE_CACHE_MAX_BYTES, 512 * 1024, 64 * 1024, 4 * 1024 * 1024);
const MAX_CONVERSATION_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_CONVERSATION_MAX_BYTES, 1024 * 1024, 64 * 1024, 8 * 1024 * 1024);
const MAX_USER_PROFILE_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_USER_PROFILE_MAX_BYTES, 512 * 1024, 64 * 1024, 4 * 1024 * 1024);
const MAX_SMALL_CONFIG_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_SMALL_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024);
const MAX_DAILY_STATS_FILE_BYTES = parseConversationPositiveInt(process.env.DONGXUELIAN_DAILY_STATS_MAX_BYTES, 8 * 1024 * 1024, 512 * 1024, 64 * 1024 * 1024);
const STATS_FILE_RETENTION_DAYS = 6;
function parseConversationPositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function getConversationErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function warnConversationFailure(action, error) {
    console.warn(`[conversation] ${action} failed: ${getConversationErrorMessage(error)}`);
}
function getNodeErrorCode(error) {
    return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}
function readJsonFileIfSmallSync(file, maxBytes, fallback, options = {}) {
    try {
        const fs = require('fs');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > maxBytes) {
            if (options.unlinkOversize) {
                try {
                    fs.unlinkSync(file);
                }
                catch { /* non-critical: best-effort oversized json cleanup */ }
            }
            return fallback;
        }
        return JSON.parse(fs.readFileSync(file, 'utf8') || 'null');
    }
    catch { /* non-critical: missing or malformed optional json falls back to caller default */
        return fallback;
    }
}
function getConversationFileSafeKeys(key = '') {
    const portable = safeChannelKey(key);
    const legacy = String(key || '').replace(/[^a-zA-Z0-9.:_-]/g, '_') || 'unknown';
    return portable === legacy ? [portable] : [portable, legacy];
}
function getLastMessageTs(items = []) {
    if (!Array.isArray(items) || !items.length)
        return 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const ts = Number(items[i]?.ts || 0);
        if (ts > 0)
            return ts;
    }
    return 0;
}
const TODAY_CACHE_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
function trimTodayCacheMessages(cache) {
    if (!cache || !Array.isArray(cache.messages))
        return;
    const cutoff = Date.now() - TODAY_CACHE_RETENTION_MS;
    const firstKeep = cache.messages.findIndex(m => m.ts >= cutoff);
    if (firstKeep > 0)
        cache.messages.splice(0, firstKeep);
    else if (firstKeep === -1 && cache.messages.length > 0)
        cache.messages.length = 0;
    if (cache.messages.length > MAX_TODAY_CACHE_MESSAGES) {
        cache.messages.splice(0, cache.messages.length - MAX_TODAY_CACHE_MESSAGES);
    }
}
function pruneMapByActivity(map, getLastTs, now = Date.now()) {
    for (const [key, value] of map.entries()) {
        const ts = Number(getLastTs(value)) || 0;
        if (ts > 0 && now - ts > CHANNEL_RUNTIME_CACHE_TTL_MS)
            map.delete(key);
    }
    if (map.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES)
        return;
    const ordered = [...map.entries()]
        .map(([key, value]) => [key, Number(getLastTs(value)) || 0])
        .sort((left, right) => left[1] - right[1]);
    while (map.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
        const next = ordered.shift();
        if (next)
            map.delete(next[0]);
    }
}
function pruneMapWithTtl(map, getLastTs, ttlMs, now = Date.now()) {
    for (const [key, value] of map.entries()) {
        const ts = Number(getLastTs(value)) || 0;
        if (!ts || now - ts > ttlMs)
            map.delete(key);
    }
    if (map.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES)
        return;
    const ordered = [...map.entries()]
        .map(([key, value]) => [key, Number(getLastTs(value)) || 0])
        .sort((left, right) => left[1] - right[1]);
    while (map.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
        const next = ordered.shift();
        if (next)
            map.delete(next[0]);
    }
}
function pruneForwardSummaryCache(ttlMs, now = Date.now()) {
    for (const key of lastForwardSummaryCache.keys()) {
        const ts = Number(lastForwardSummaryCacheTs.get(key) || 0);
        if (!ts || now - ts > ttlMs) {
            lastForwardSummaryCache.delete(key);
            lastForwardSummaryCacheTs.delete(key);
        }
    }
    if (lastForwardSummaryCache.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES)
        return;
    const ordered = [...lastForwardSummaryCache.keys()]
        .map((key) => [key, Number(lastForwardSummaryCacheTs.get(key) || 0)])
        .sort((left, right) => left[1] - right[1]);
    while (lastForwardSummaryCache.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
        const next = ordered.shift();
        if (next) {
            const key = next[0];
            lastForwardSummaryCache.delete(key);
            lastForwardSummaryCacheTs.delete(key);
        }
    }
}
function setLastForwardSummaryCache(channelKey, text, ts = Date.now()) {
    const key = String(channelKey || '');
    lastForwardSummaryCache.set(key, String(text || ''));
    lastForwardSummaryCacheTs.set(key, Number(ts) || Date.now());
}
function trimChannelRuntimeCaches(now = Date.now()) {
    pruneMapByActivity(channelSharedCache, items => getLastMessageTs(items), now);
    pruneMapByActivity(channelTodayCache, cache => Number(cache?.updatedAt || cache?.lastDiskWrite || getLastMessageTs(cache?.messages)), now);
    pruneForwardSummaryCache(60 * 60 * 1000, now);
    pruneMapWithTtl(pendingSensitiveAlert, entry => Number(entry?.ts || 0), 2 * 60 * 60 * 1000, now);
}
function trimConversationRuntimeCaches(now = Date.now()) {
    for (const [key, ts] of conversationCacheAccessAt.entries()) {
        if (now - ts >= CONVERSATION_EXPIRE_MS) {
            conversationCacheAccessAt.delete(key);
            conversationLastActiveAt.delete(key);
            conversationCache.delete(key);
            replyFingerprintCache.delete(key);
        }
    }
    if (conversationCache.size <= MAX_CONVERSATION_CACHE_ENTRIES && replyFingerprintCache.size <= MAX_CONVERSATION_CACHE_ENTRIES)
        return;
    const ordered = [...conversationCacheAccessAt.entries()].sort((left, right) => left[1] - right[1]);
    while ((conversationCache.size > MAX_CONVERSATION_CACHE_ENTRIES || replyFingerprintCache.size > MAX_CONVERSATION_CACHE_ENTRIES) && ordered.length) {
        const next = ordered.shift();
        if (next) {
            const key = next[0];
            conversationCacheAccessAt.delete(key);
            conversationLastActiveAt.delete(key);
            conversationCache.delete(key);
            replyFingerprintCache.delete(key);
        }
    }
}
function getSessionUserId(session) {
    return String(session?.userId || session?.author?.id || session?.username || 'unknown');
}
function getChannelKey(session) {
    if (session?.guildId || session?.channelId)
        return String(session.guildId || session.channelId);
    if (session?.isDirect)
        return `private:${getSessionUserId(session)}`;
    return 'private';
}
function getConversationKey(session) { return `${getChannelKey(session)}::${getSessionUserId(session)}`; }
function touchConversation(session) {
    const key = getConversationKey(session);
    const now = Date.now();
    conversationLastActiveAt.set(key, now);
    conversationCacheAccessAt.set(key, now);
}
function touchConversationAccess(session) { conversationCacheAccessAt.set(getConversationKey(session), Date.now()); }
function readConversationDisk(key) {
    for (const safeKey of getConversationFileSafeKeys(key)) {
        const data = readJsonFileIfSmallSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'), MAX_CONVERSATION_FILE_BYTES, null, { unlinkOversize: true });
        if (data)
            return data;
    }
    return null;
}
function writeConversationDisk(key, data) {
    try {
        const safeKey = getConversationFileSafeKeys(key)[0];
        require('fs').mkdirSync(CONVERSATIONS_DIR, { recursive: true });
        require('fs').writeFileSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'), JSON.stringify(data), 'utf8');
    }
    catch (error) {
        warnConversationFailure('write conversation disk', error);
    }
}
function isImagePlaceholderMessage(msg, messageId) {
    if (!msg || msg.role !== 'user' || !msg.content || !String(msg.content).includes('[图片]'))
        return false;
    if (String(msg.content || '').includes('[图片]:'))
        return false;
    if (String(msg.messageId || '') === String(messageId))
        return true;
    const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : null;
    return !!(meta && String(meta.messageId || '') === String(messageId));
}
function replaceImagePlaceholderInMessages(messages = [], messageId = '', analysis = '') {
    if (!Array.isArray(messages) || !messageId || !analysis)
        return false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (isImagePlaceholderMessage(msg, messageId)) {
            msg.content = String(msg.content).replace('[图片]', `[图片]: ${String(analysis).slice(0, 200)}`);
            return true;
        }
    }
    return false;
}
function replaceImagePlaceholderInConversation(key, messageId, analysis) {
    if (!key || !messageId || !analysis)
        return Promise.resolve(false);
    return enqueueWrite(key, () => {
        let replaced = false;
        const diskData = readConversationDisk(key) || { summary: '', summaryTotal: 0, totalCount: 0, messages: [] };
        const mergedMessages = mergeConversationMessages(diskData.messages, conversationCache.get(key));
        if (replaceImagePlaceholderInMessages(mergedMessages, messageId, analysis)) {
            diskData.messages = mergedMessages;
            diskData.totalCount = Math.max(Number(diskData.totalCount || 0), mergedMessages.filter(item => item && item.role === 'user').length);
            writeConversationDisk(key, diskData);
            replaced = true;
        }
        if (!replaced && replaceImagePlaceholderInMessages(diskData.messages, messageId, analysis)) {
            writeConversationDisk(key, diskData);
            replaced = true;
        }
        if (replaced) {
            conversationCache.set(key, (diskData.messages || mergedMessages).slice(-MEMORY_HISTORY_LIMIT));
        }
        return replaced;
    });
}
function getConversationHistory(session) {
    const key = getConversationKey(session);
    const lastAccessAt = conversationCacheAccessAt.get(key) || conversationLastActiveAt.get(key);
    if (typeof lastAccessAt === 'number' && Date.now() - lastAccessAt >= CONVERSATION_EXPIRE_MS)
        conversationCache.delete(key);
    touchConversationAccess(session);
    trimConversationRuntimeCaches();
    const mem = conversationCache.get(key);
    if (mem)
        return mem.slice();
    const diskData = readConversationDisk(key);
    if (diskData && Array.isArray(diskData.messages)) {
        const recent = diskData.messages.slice(-MEMORY_HISTORY_LIMIT);
        conversationCache.set(key, recent);
        return recent.slice();
    }
    return [];
}
function isSameConversationMessage(left = {}, right = {}) {
    return String(left.role || '') === String(right.role || '') && normalizeText(left.content || '') === normalizeText(right.content || '');
}
function mergeConversationMessages(diskMessages = [], cachedMessages = []) {
    const disk = (Array.isArray(diskMessages) ? diskMessages : []).filter(Boolean);
    const cached = (Array.isArray(cachedMessages) ? cachedMessages : []).filter(Boolean);
    if (!cached.length)
        return disk;
    if (!disk.length)
        return cached.slice();
    let overlap = 0;
    const maxOverlap = Math.min(disk.length, cached.length);
    for (let count = maxOverlap; count > 0; count -= 1) {
        let matched = true;
        for (let i = 0; i < count; i += 1) {
            if (!isSameConversationMessage(disk[disk.length - count + i], cached[i])) {
                matched = false;
                break;
            }
        }
        if (matched) {
            overlap = count;
            break;
        }
    }
    return disk.concat(cached.slice(overlap));
}
function saveConversationTurn(session, userText, replyText) {
    const key = getConversationKey(session);
    enqueueWrite(key, () => {
        const diskData = readConversationDisk(key) || { summary: '', summaryTotal: 0, totalCount: 0, messages: [] };
        diskData.messages = mergeConversationMessages(diskData.messages, conversationCache.get(key));
        diskData.totalCount = Math.max(Number(diskData.totalCount || 0), diskData.messages.filter(item => item && item.role === 'user').length);
        const assistantText = normalizeText(replyText);
        const now = Date.now();
        diskData.messages.push({ role: 'user', content: userText, messageId: String(session.messageId || ''), ts: now }, ...(assistantText ? [{ role: 'assistant', content: assistantText, ts: now }] : []));
        diskData.totalCount++;
        if (diskData.messages.length > MAX_HISTORY_MESSAGES)
            diskData.messages.splice(0, diskData.messages.length - MAX_HISTORY_MESSAGES);
        conversationCache.set(key, diskData.messages.slice(-MEMORY_HISTORY_LIMIT));
        if (diskData.totalCount % 3 === 0)
            writeConversationDisk(key, diskData);
        touchConversation(session);
        saveReplyFingerprint(session, replyText);
        trimConversationRuntimeCaches();
        if (diskData.totalCount > 0 && diskData.totalCount % CONVERSATION_SUMMARY_INTERVAL === 0)
            generateConversationSummary(key).catch((error) => warnConversationFailure('schedule conversation summary', error));
    });
}
async function generateConversationSummary(key) {
    const prev = summaryLocks.get(key) || Promise.resolve();
    const task = prev.then(() => {
        submitConversationSummaryTask({ key, source: 'conversation-summary-trigger' });
    }).catch((error) => { warnConversationFailure('conversation summary submit', error); });
    summaryLocks.set(key, task);
    task.finally(() => { if (summaryLocks.get(key) === task)
        summaryLocks.delete(key); });
    return task;
}
function clearConversationHistory() { conversationCache = new Map(); replyFingerprintCache = new Map(); conversationLastActiveAt.clear(); conversationCacheAccessAt.clear(); channelSharedCache.clear(); }
function clearUserConversationHistory(session) {
    const key = getConversationKey(session);
    conversationCache.delete(key);
    replyFingerprintCache.delete(key);
    conversationLastActiveAt.delete(key);
    conversationCacheAccessAt.delete(key);
    for (const safeKey of getConversationFileSafeKeys(key)) {
        try {
            require('fs').unlinkSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'));
        }
        catch { /* non-critical: missing conversation file during clear */
        }
    }
}
function getReplyFingerprintHistory(session) { return replyFingerprintCache.get(getConversationKey(session)) || []; }
function saveReplyFingerprint(session, replyText) {
    const key = getConversationKey(session);
    const history = getReplyFingerprintHistory(session);
    const fp = normalizeText(replyText);
    if (!fp)
        return;
    replyFingerprintCache.set(key, history.concat({ content: fp, createdAt: Date.now() }).slice(-MAX_REPLY_FINGERPRINT_HISTORY));
}
function getRecentAssistantReplies(session, limit = MAX_REPEAT_CHECK_HISTORY) { return getReplyFingerprintHistory(session).filter(item => item.content).slice(-limit).map(item => item.content); }
function parseUserMessageEnvelope(content = '') {
    const text = String(content || '').trim();
    const wrapped = text.match(/^<user>\r?\n昵称：(.+?)\r?\n发言：([\s\S]*)\r?\n<\/user>$/);
    if (wrapped)
        return { nickname: wrapped[1].trim(), content: wrapped[2].trim(), wrapped: true };
    const legacy = text.match(/^用户\((.+?)\)[：:]([\s\S]*)$/);
    if (legacy)
        return { nickname: legacy[1].trim(), content: legacy[2].trim(), wrapped: false };
    return { nickname: '', content: text, wrapped: false };
}
function getUserMessageContent(content = '') {
    return parseUserMessageEnvelope(content).content;
}
function normalizeUserMessageForPrompt(message) {
    if (!message || message.role !== 'user')
        return message;
    const parsed = parseUserMessageEnvelope(message.content);
    if (parsed.wrapped || !parsed.nickname)
        return message;
    return Object.assign({}, message, {
        content: `<user>\n昵称：${parsed.nickname}\n发言：${parsed.content}\n</user>`,
    });
}
function getRecentUserMessages(session, limit = 3) { return getConversationHistory(session).filter(m => m.role === 'user').slice(-limit).map(m => getUserMessageContent(m.content)); }
function getRecentUserMessageRecords(session, limit = 8) {
    return getConversationHistory(session)
        .filter(m => m && m.role === 'user')
        .slice(-limit)
        .map(m => ({
        role: 'user',
        content: getUserMessageContent(m.content),
        messageId: String(m.messageId || ''),
        ts: Number(m.ts || m.createdAt || 0) || 0,
        meta: m.meta && typeof m.meta === 'object' ? m.meta : undefined,
    }));
}
function looksLikeShortContextFollowUp(text = '') {
    const value = normalizeText(text);
    if (!value)
        return false;
    if (value.length <= 8)
        return true;
    if (value.length <= 18 && /(?:评价一下|怎么看|咋看|真的吗|真的|然后呢|为啥|怎么说|看看|看看你的|讲讲|细说|展开|这个呢|那这个|这图|这张图)/.test(value))
        return true;
    return false;
}
function buildExplicitInteractionFocusNote(currentText = '', options = {}) {
    const explicit = !!(options.directAt || options.nameMentioned || options.isDirect);
    if (!explicit)
        return '';
    const value = normalizeText(currentText);
    if (!value)
        return '';
    return [
        '[当前显式交互锚点]',
        `当前用户这条消息是在直接找你说话：${value.slice(0, 160)}`,
        '必须优先回答这条当前消息。旧的群聊背景、你刚才对别人说的话、其他人格回复、转发材料和长期记忆都只能辅助理解，不能覆盖当前用户的主语、问题和情绪。',
        '只有当前消息本身明显在追问上一条公共话题或引用链时，才承接旧话题；否则不要把上一轮对别人的回复续到当前用户身上。',
        '如果当前消息是在质疑或纠正你刚才的回复跑题，先处理这个纠错关系；不要继续展开那条被质疑的旧话题。',
    ].join('\n');
}
function buildRecentPublicTopicNote(items = [], currentUserId = '', options = {}) {
    if (!Array.isArray(items) || !items.length)
        return '';
    const currentText = normalizeText(options.currentText || '');
    if (!looksLikeShortContextFollowUp(currentText))
        return '';
    const currentPersonaName = String(options.personaName || '').trim();
    const recent = items
        .filter(item => item && item.content)
        .slice(-8);
    if (!recent.length)
        return '';
    const candidates = [];
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const item = recent[i];
        const content = normalizeText(item.content);
        if (!content)
            continue;
        if (item.role === 'assistant') {
            const itemPersona = String(item.personaName || '').trim();
            const samePersona = !currentPersonaName || !itemPersona || itemPersona === currentPersonaName;
            candidates.push(samePersona
                ? `你刚才说过：${content.slice(0, 160)}`
                : `其他人格${itemPersona}刚才公开回复：${content.slice(0, 160)}（只作群聊背景，不要继承其口吻）`);
        }
        else {
            const who = String(item.userId || '') === String(currentUserId || '') ? '当前用户刚才说' : `${item.speakerName || '群友'}刚才说`;
            candidates.push(`${who}：${content.slice(0, 160)}`);
        }
        if (candidates.length >= 4)
            break;
    }
    if (!candidates.length)
        return '';
    return `[短句/指代跟进候选]\n当前用户说"${currentText}"这类短句时，优先承接下面最近公共话题或你刚才说过的话；昵称只用于区分发言者，不是默认评价对象。\n${candidates.reverse().join('\n')}`;
}
function flushTodayCacheToDisk(channelKey) {
    const cache = channelTodayCache.get(channelKey);
    if (!cache || !Array.isArray(cache.messages))
        return;
    trimTodayCacheMessages(cache);
    const safeKey = safeChannelKey(channelKey);
    const tmp = TODAY_CACHE_PREFIX + safeKey + '.tmp';
    const dst = TODAY_CACHE_PREFIX + safeKey + '.json';
    try {
        require('fs').writeFileSync(tmp, JSON.stringify({ date: cache.date, messages: cache.messages }), 'utf8');
        require('fs').renameSync(tmp, dst);
        cache.lastDiskWrite = Date.now();
    }
    catch (error) {
        warnConversationFailure('flush today cache', error);
    }
}
function saveSharedChannelTurn(session, speakerName, content, role = 'user', metadata = {}) {
    const channelKey = getChannelKey(session);
    const value = redactSensitiveText(normalizeText(content));
    const hasMentions = Array.isArray(metadata.mentionUserIds) && metadata.mentionUserIds.length > 0;
    if (!value && !hasMentions)
        return;
    const userId = String(role === 'assistant' ? (session.selfId || session.bot?.selfId || 'bot') : (session.userId || session.author?.id || session.username || 'unknown'));
    const personaName = role === 'assistant' ? sanitizeUserName(String(metadata.personaName || '')).slice(0, 40) : '';
    const entry = { userId, role, speakerName: sanitizeUserName(speakerName || (role === 'assistant' ? '东雪莲' : '群友')), personaName, content: value, messageId: String(metadata.messageId || ''), replyToId: String(metadata.replyToId || ''), mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [], hasMessageRecordCue: !!metadata.hasMessageRecordCue, hasAudio: !!metadata.hasAudio, ts: Date.now() };
    const current = channelSharedCache.get(channelKey) || [];
    channelSharedCache.set(channelKey, current.concat(entry).slice(-MAX_CHANNEL_SHARED_MESSAGES));
    appendGroupSceneEntry(channelKey, entry).catch((error) => warnConversationFailure('append group scene entry', error));
    trimChannelRuntimeCaches();
    if (role === 'user' && metadata.fromSummary !== true) {
        try {
            const sw = readJsonFileIfSmallSync(SUMMARY_WHITELIST_FILE, MAX_SMALL_CONFIG_FILE_BYTES, []);
            if (Array.isArray(sw) && sw.includes(String(channelKey))) {
                const today = todayCst();
                let cache = channelTodayCache.get(channelKey);
                if (!cache) {
                    cache = { date: today, messages: [], updatedAt: Date.now() };
                    channelTodayCache.set(channelKey, cache);
                }
                else {
                    cache.date = today;
                }
                if (value || hasMentions) {
                    const displayName = speakerName || userId;
                    const ts = Date.now();
                    const messageId = String(metadata.messageId || '');
                    cache.updatedAt = ts;
                    cache.messages.push({
                        time: formatShanghaiTime24h(ts),
                        ts,
                        user: sanitizeUserName(String(displayName)),
                        userId,
                        content: (value || '').slice(0, MAX_TODAY_CACHE_CONTENT_CHARS),
                        messageId,
                        mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [],
                    });
                    appendPrecomputeIndex({
                        channelKey,
                        messageId,
                        timestamp: ts,
                        userId,
                        userName: sanitizeUserName(String(displayName)),
                        text: value,
                        media: [
                            ...(metadata.hasMessageRecordCue ? [{ type: 'message_record', cacheKey: messageId }] : []),
                            ...(metadata.hasAudio ? [{ type: 'voice', cacheKey: messageId }] : []),
                        ],
                    });
                    trimTodayCacheMessages(cache);
                    const now = Date.now();
                    const elapsed = now - (cache.lastDiskWrite || 0);
                    if (cache.messages.length % 20 === 0 || elapsed > 300000) {
                        flushTodayCacheToDisk(channelKey);
                    }
                }
            }
        }
        catch { /* non-critical: today cache side index is optional shared context material */
        }
    }
    if (role === 'user' && value) {
        saveUserProfile(userId, sanitizeUserName(String(speakerName || '群友')), value, channelKey).catch((error) => warnConversationFailure('save user profile shadow', error));
    }
}
async function cleanupDailyStatsFiles() {
    const cutoffStr = todayCstMinusDays(STATS_FILE_RETENTION_DAYS);
    let files = [];
    try {
        files = await fsp.readdir(DATA_DIR);
    }
    catch {
        return { removed: 0, compacted: 0 };
    }
    let removed = 0;
    let compacted = 0;
    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        if (/^today-cache-.+\.json$/.test(file)) {
            try {
                const stat = await fsp.stat(filePath).catch(() => null);
                if (!stat || !stat.isFile())
                    continue;
                if (stat.size > MAX_DAILY_STATS_FILE_BYTES) {
                    await fsp.unlink(filePath).catch((error) => warnConversationFailure('remove oversized today cache', error));
                    removed += 1;
                    continue;
                }
                const data = await readJsonFile(filePath, null);
                if (data && typeof data.date === 'string' && data.date < cutoffStr) {
                    await fsp.unlink(filePath);
                    removed += 1;
                }
            }
            catch { /* non-critical: continue daily stats cleanup when one cache file is unreadable */
            }
            continue;
        }
        if (/^emotion-history-.+\.json$/.test(file)) {
            try {
                const stat = await fsp.stat(filePath).catch(() => null);
                if (!stat || !stat.isFile())
                    continue;
                if (stat.size > MAX_DAILY_STATS_FILE_BYTES) {
                    await fsp.unlink(filePath).catch((error) => warnConversationFailure('remove oversized emotion history', error));
                    removed += 1;
                    continue;
                }
                const data = await readJsonFile(filePath, null);
                if (!Array.isArray(data))
                    continue;
                const filtered = data.filter((item) => item && typeof item.date === 'string' && item.date >= cutoffStr);
                if (filtered.length !== data.length) {
                    if (filtered.length)
                        await writeJsonFile(filePath, filtered);
                    else
                        await fsp.unlink(filePath);
                    compacted += 1;
                }
            }
            catch { /* non-critical: continue daily stats cleanup when one emotion history file is unreadable */
            }
        }
    }
    trimChannelRuntimeCaches();
    return { removed, compacted };
}
async function saveUserProfile(userId, name, content, channelKey) {
    if (!userId || userId === 'unknown')
        return;
    const safeKey = safeChannelKey(channelKey);
    const dir = path.join(USER_PROFILE_DIR, safeKey);
    try {
        require('fs').mkdirSync(dir, { recursive: true });
    }
    catch (error) {
        warnConversationFailure('create user profile dir', error);
    }
    const file = path.join(dir, String(userId) + '.json');
    let data = readJsonFileIfSmallSync(file, MAX_USER_PROFILE_FILE_BYTES, { userId, names: [], messages: [] }, { unlinkOversize: true });
    data.userId = String(userId);
    if (name && !data.names.includes(name))
        data.names.push(name);
    data.messages.push({ time: new Date().toLocaleString(), content });
    if (data.messages.length > 30)
        data.messages.splice(0, data.messages.length - 30);
    if (!Array.isArray(data.memory))
        data.memory = [];
    await writeJsonFile(file, data);
}
async function writeMemory(userId, name, channelKey, text) {
    const safeKey = safeChannelKey(channelKey);
    const dir = path.join(USER_PROFILE_DIR, safeKey);
    try {
        require('fs').mkdirSync(dir, { recursive: true });
    }
    catch (error) {
        warnConversationFailure('create memory dir', error);
    }
    const file = path.join(dir, String(userId) + '.json');
    let data = readJsonFileIfSmallSync(file, MAX_USER_PROFILE_FILE_BYTES, { userId, names: [], messages: [], memory: [] }, { unlinkOversize: true });
    data.userId = String(userId);
    if (!Array.isArray(data.memory))
        data.memory = [];
    const existing = data.memory.findIndex(function (m) { return m.text === text; });
    if (existing >= 0) {
        data.memory[existing].ts = Date.now();
        data.memory[existing].confirmCount = (data.memory[existing].confirmCount || 0) + 1;
    }
    else {
        data.memory.push({ text: text, ts: Date.now(), confirmCount: 1 });
    }
    if (data.memory.length > 10)
        data.memory.splice(0, data.memory.length - 10);
    await writeJsonFile(file, data);
}
async function deleteMemory(userId, channelKey, text) {
    const safeKey = safeChannelKey(channelKey);
    const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json');
    const data = readJsonFileIfSmallSync(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true });
    if (!data || !Array.isArray(data.memory))
        return;
    data.memory = data.memory.filter(function (m) { return m.text !== text; });
    await writeJsonFile(file, data);
}
async function clearUserMemory(userId, channelKey) {
    const safeKey = safeChannelKey(channelKey);
    const file = path.join(USER_PROFILE_DIR, safeKey, userId + '.json');
    try {
        const data = readJsonFileIfSmallSync(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true });
        if (data && Array.isArray(data.memory)) {
            data.memory = [];
            await writeJsonFile(file, data);
        }
    }
    catch { /* non-critical: clear user memory is best-effort admin cleanup */
    }
}
async function clearGroupMemory(channelKey) {
    const safeKey = safeChannelKey(channelKey);
    const dir = path.join(USER_PROFILE_DIR, safeKey);
    try {
        const files = await fsp.readdir(dir);
        for (const file of files) {
            if (!file.endsWith('.json'))
                continue;
            const filePath = path.join(dir, file);
            try {
                const data = readJsonFileIfSmallSync(filePath, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true });
                if (data && Array.isArray(data.memory)) {
                    data.memory = [];
                    await writeJsonFile(filePath, data);
                }
            }
            catch { /* non-critical: continue clearing remaining user memory files */
            }
        }
    }
    catch { /* non-critical: missing group memory directory means nothing to clear */
    }
}
async function getMemorySummary(userId, channelKey) {
    const safeKey = safeChannelKey(channelKey);
    const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json');
    const data = readJsonFileIfSmallSync(file, MAX_USER_PROFILE_FILE_BYTES, null, { unlinkOversize: true });
    if (!data || !Array.isArray(data.memory) || !data.memory.length)
        return '';
    const confirmed = data.memory.filter(function (m) { return (m.confirmCount || 0) > 0; }).slice(-3);
    if (!confirmed.length)
        return '';
    return '记住的：' + confirmed.map(function (m) { return m.text; }).join('、');
}
function findChannelMessageById(channelKey, messageId = '') {
    if (!messageId)
        return null;
    const items = channelSharedCache.get(channelKey) || [];
    return items.find(i => String(i.messageId || '') === String(messageId)) || null;
}
function collectReplyChain(channelKey, replyToId = '') {
    if (!replyToId)
        return [];
    const result = [];
    let currentId = replyToId;
    const maxDepth = MAX_REPLY_CHAIN_DEPTH;
    const visited = new Set();
    for (let i = 0; i < maxDepth; i++) {
        if (visited.has(String(currentId)))
            break;
        visited.add(String(currentId));
        const msg = findChannelMessageById(channelKey, currentId);
        if (!msg)
            break;
        result.push(msg);
        currentId = msg.replyToId;
    }
    return result;
}
function extractQuoteAuthorId(session) {
    const q = session && session.quote || {};
    const author = q.author;
    return String(q.userId || q.user_id || q.user?.id || (typeof author === 'object' ? author?.id : '') || q.authorId || q.sender?.userId || q.sender?.id || '');
}
function extractQuoteAuthorName(session) {
    const q = session && session.quote || {};
    const author = q.author;
    if (typeof author === 'string')
        return author;
    return String(q.nickname || q.nick || q.sender?.nickname || q.sender?.card || q.sender?.name || author?.nick || author?.name || q.userId || '');
}
function getQuoteMessageId(session, options = {}) {
    const q = session && session.quote || {};
    return String(options.replyToId || q.id || q.messageId || q.message_id || q.message?.id || '');
}
function getQuoteContentText(session) {
    const q = session && session.quote || {};
    if (!q)
        return '';
    if (typeof q.content === 'string')
        return q.content;
    if (Array.isArray(q.content)) {
        return q.content.map(function (s) {
            if (s.type === 'text')
                return s.data && s.data.text || '';
            if (s.type === 'image')
                return '[图片]';
            if (s.type === 'face')
                return '[表情]';
            if (s.type === 'at')
                return '@' + (s.data && (s.data.name || s.data.qq || s.data.id || ''));
            if (s.type === 'forward')
                return '[转发消息]';
            if (s.type === 'video')
                return '[视频]';
            if (s.type === 'record')
                return (s.data && s.data._transcribedText) ? `[语音转文字：${s.data._transcribedText}]` : '[语音]';
            if (s.type === 'file')
                return '[文件]';
            return '[消息]';
        }).filter(Boolean).join('');
    }
    return q.raw_message || q.text || '';
}
function getQuoteInfo(session, options = {}) {
    const content = getQuoteContentText(session);
    if (!content)
        return { content: '', authorName: '', authorId: '', messageId: '', isSelf: false, matchedMessage: null };
    const channelKey = getChannelKey(session);
    const messageId = getQuoteMessageId(session, options);
    const matchedMessage = messageId ? findChannelMessageById(channelKey, messageId) : null;
    const selfId = String(session?.selfId || session?.bot?.selfId || '');
    const authorId = extractQuoteAuthorId(session);
    const isSelf = !!(matchedMessage?.role === 'assistant' || (selfId && authorId && authorId === selfId));
    return {
        content,
        authorName: extractQuoteAuthorName(session) || (isSelf ? '东雪莲' : ''),
        authorId,
        messageId,
        isSelf,
        matchedMessage,
    };
}
function escapePromptBoundaryText(text = '') {
    return redactSensitiveText(String(text || ''))
        .replace(/[<>]/g, ch => (ch === '<' ? '＜' : '＞'));
}
function getQuotedMessageNote(session, options = {}) {
    const quoteInfo = getQuoteInfo(session, options);
    if (!quoteInfo.content)
        return '';
    const qtext = escapePromptBoundaryText(quoteInfo.content);
    const recent = getConversationHistory(session).slice(-MAX_CHANNEL_PROMPT_MESSAGES);
    const match = recent.find(m => m.content && (qtext.includes(m.content.slice(0, 30)) || m.content.includes(qtext.slice(0, 30))));
    if (match)
        return ''; // already in history
    if (quoteInfo.isSelf) {
        return `[引用你自己的历史回复]\n${qtext.slice(0, 160)}\n以上内容是你自己之前说过的话，不是当前用户说的；不要把它当成群友观点，也不要攻击自己。`;
    }
    return `[引用消息]\n${qtext.slice(0, 100)}`;
}
function getSharedContextNote(session, currentUserId = '', options = {}) {
    const channelKey = getChannelKey(session);
    const items = (channelSharedCache.get(channelKey) || []).filter(item => item.content);
    const explicitFocusNote = buildExplicitInteractionFocusNote(options.currentText || '', options);
    if (!items.length)
        return explicitFocusNote;
    const replyChain = collectReplyChain(channelKey, String(options.replyToId || ''));
    const focusUserIds = new Set([String(currentUserId || '')].filter(Boolean));
    const focusMessageIds = new Set();
    const mentionUserIds = Array.isArray(options.mentionUserIds) ? options.mentionUserIds.map(String).filter(Boolean) : [];
    const shortTopicNote = buildRecentPublicTopicNote(items, currentUserId, options);
    mentionUserIds.forEach(u => focusUserIds.add(u));
    replyChain.forEach(item => { if (item.userId)
        focusUserIds.add(String(item.userId)); if (item.messageId)
        focusMessageIds.add(String(item.messageId)); });
    if (!replyChain.length && currentUserId) {
        items.slice(-MAX_THREAD_CONTEXT_MESSAGES).filter(item => item.userId !== currentUserId && item.mentionUserIds.includes(currentUserId)).forEach(item => { if (item.userId)
            focusUserIds.add(String(item.userId)); item.mentionUserIds.forEach(u => focusUserIds.add(String(u))); });
    }
    let scoped = items.filter(item => { if (item.role === 'assistant' && !focusMessageIds.has(String(item.messageId || '')))
        return false; if (focusMessageIds.has(String(item.messageId || '')))
        return true; if (focusUserIds.has(String(item.userId || '')))
        return true; return item.mentionUserIds.some(u => focusUserIds.has(String(u))); });
    if (!scoped.length && options.randomTriggered && currentUserId)
        scoped = items.filter(item => item.role !== 'assistant' && item.userId === currentUserId);
    if (!scoped.length)
        scoped = items.filter(item => item.role !== 'assistant').slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES));
    if (shortTopicNote) {
        const recentForShort = items.slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES));
        const seen = new Set(scoped.map(item => String(item.messageId || '') + ':' + item.role + ':' + item.content));
        for (const item of recentForShort) {
            const key = String(item.messageId || '') + ':' + item.role + ':' + item.content;
            if (!seen.has(key))
                scoped.push(item);
        }
    }
    const IDLE_GAP_MS = 10 * 60 * 1000;
    const itemsToMap = scoped.slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES));
    const lines = [];
    for (let i = 0; i < itemsToMap.length; i++) {
        if (i > 0 && itemsToMap[i].ts && itemsToMap[i - 1].ts && itemsToMap[i].ts - itemsToMap[i - 1].ts > IDLE_GAP_MS) {
            lines.push('[--- 以下是与当前无关的旧消息 ---]');
        }
        const personaLabel = itemsToMap[i].role === 'assistant' && itemsToMap[i].personaName
            ? `bot人格:${itemsToMap[i].personaName}`
            : (itemsToMap[i].role === 'assistant' ? 'bot' : '群友');
        lines.push(`${itemsToMap[i].speakerName}(${personaLabel})：${itemsToMap[i].content}`);
    }
    if (!lines.length)
        return explicitFocusNote;
    return `${explicitFocusNote ? `${explicitFocusNote}\n` : ''}[群聊当前话题背景]\n下面只保留当前回复链、当前参与者或短句跟进可能需要的纯文本消息。优先理解最近公共话题和明确回复链，不要把昵称当成默认评价对象。\n${shortTopicNote ? `${shortTopicNote}\n` : ''}${lines.join('\n')}`;
}
function saveSensitiveCache(channelKey, value, speakerName, userId) {
    const safeKey = safeChannelKey(channelKey);
    const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json';
    const entry = { speakerName, userId, content: String(value || '').slice(0, 500), ts: Date.now() };
    try {
        const fs = require('fs');
        let data = {};
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= MAX_SENSITIVE_CACHE_FILE_BYTES)
            data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
        if (!Array.isArray(data.messages))
            data.messages = [];
        data.messages.push(entry);
        data.messages = data.messages.slice(-MAX_SENSITIVE_CACHE_MESSAGES);
        fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    }
    catch (error) {
        if (getNodeErrorCode(error) !== 'ENOENT')
            warnConversationFailure('save sensitive cache', error);
        try {
            require('fs').writeFileSync(file, JSON.stringify({ messages: [entry] }), 'utf8');
        }
        catch (fallbackError) {
            warnConversationFailure('save sensitive cache fallback', fallbackError);
        }
    }
}
function getSensitiveAlertFile(channelKey) {
    return path.join(SENSITIVE_ALERT_DIR, safeChannelKey(channelKey) + '.json');
}
function writePendingSensitiveAlert(channelKey, patch = {}) {
    const key = String(channelKey || '');
    if (!key)
        return;
    const now = Date.now();
    const payload = {
        flagged: true,
        ts: now,
        channelKey: key,
        ...patch,
    };
    pendingSensitiveAlert.set(key, { flagged: true, ts: now });
    try {
        require('fs').mkdirSync(SENSITIVE_ALERT_DIR, { recursive: true });
        require('fs').writeFileSync(getSensitiveAlertFile(key), JSON.stringify(payload), 'utf8');
    }
    catch (error) {
        warnConversationFailure('write pending sensitive alert', error);
    }
}
function consumePendingSensitiveAlert(channelKey) {
    const key = String(channelKey || '');
    if (!key)
        return null;
    const cached = pendingSensitiveAlert.get(key);
    if (cached)
        pendingSensitiveAlert.delete(key);
    const file = getSensitiveAlertFile(key);
    let fileAlert = null;
    try {
        const data = readJsonFileIfSmallSync(file, MAX_SMALL_CONFIG_FILE_BYTES, null, { unlinkOversize: true });
        const ts = Number(data?.ts || 0);
        if (data && data.flagged && ts && Date.now() - ts <= SENSITIVE_ALERT_TTL_MS)
            fileAlert = data;
    }
    catch { /* non-critical: missing or malformed alert file is treated as no alert */
    }
    try {
        require('fs').unlinkSync(file);
    }
    catch { /* non-critical: alert file may already be absent */
    }
    if (!cached && !fileAlert)
        return null;
    return fileAlert || { flagged: true, ts: cached?.ts || Date.now(), channelKey: key };
}
function clearPendingSensitiveAlert(channelKey) {
    const key = String(channelKey || '');
    if (!key)
        return;
    pendingSensitiveAlert.delete(key);
    try {
        require('fs').unlinkSync(getSensitiveAlertFile(key));
    }
    catch { /* non-critical: no persisted alert to clear */
    }
}
async function analyzeChannelSensitive(channelKey) {
    const safeKey = safeChannelKey(channelKey);
    const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json';
    try {
        const fs = require('fs');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_SENSITIVE_CACHE_FILE_BYTES) {
            try {
                fs.unlinkSync(file);
            }
            catch { /* non-critical: best-effort oversized sensitive cache cleanup */ }
            ;
            return;
        }
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.messages) || data.messages.length < 5)
            return;
        submitSensitiveCacheAnalysisTask({ channelKey, source: 'sensitive-cache-trigger' });
    }
    catch (error) {
        warnConversationFailure('submit sensitive cache analysis', error);
    }
}
const MEMORY_TIMER_DIR = path.join(DATA_DIR, 'memory-timers');
function getMemoryTimerKey(channelKey) {
    return safeChannelKey(channelKey);
}
function readMemoryTimer(channelKey) {
    const file = path.join(MEMORY_TIMER_DIR, getMemoryTimerKey(channelKey) + '.json');
    try {
        const data = readJsonFileIfSmallSync(file, MAX_SMALL_CONFIG_FILE_BYTES, null, { unlinkOversize: true });
        const intervalHours = Number(data?.intervalHours || 0);
        if (data && intervalHours > 0 && intervalHours <= 168)
            return { ...data, intervalHours };
    }
    catch { /* non-critical: missing or malformed memory timer disables timer */
    }
    return null;
}
function checkMemoryTimerExpired(channelKey) {
    const timer = readMemoryTimer(channelKey);
    if (!timer)
        return false;
    const elapsed = Date.now() - (timer.lastClearTs || 0);
    const intervalHours = Number(timer.intervalHours || 0);
    return elapsed >= intervalHours * 3600 * 1000;
}
module.exports = {
    conversationCache, replyFingerprintCache,
    conversationLastActiveAt, conversationCacheAccessAt, channelSharedCache, lastForwardSummaryCache,
    setLastForwardSummaryCache,
    pendingSensitiveAlert, channelTodayCache,
    writePendingSensitiveAlert, consumePendingSensitiveAlert, clearPendingSensitiveAlert,
    getConversationKey, getChannelKey, touchConversation, touchConversationAccess,
    readConversationDisk, writeConversationDisk, replaceImagePlaceholderInConversation,
    getConversationHistory, saveConversationTurn, mergeConversationMessages, generateConversationSummary,
    clearConversationHistory, clearUserConversationHistory,
    getReplyFingerprintHistory, saveReplyFingerprint,
    getRecentAssistantReplies, getRecentUserMessages, getRecentUserMessageRecords,
    parseUserMessageEnvelope, getUserMessageContent, normalizeUserMessageForPrompt,
    saveSharedChannelTurn,
    findChannelMessageById, collectReplyChain,
    getQuoteContentText, getQuoteInfo, getQuotedMessageNote, getSharedContextNote,
    saveUserProfile, saveSensitiveCache, analyzeChannelSensitive,
    writeMemory, deleteMemory, clearUserMemory, clearGroupMemory, getMemorySummary,
    readMemoryTimer, checkMemoryTimerExpired,
    flushTodayCacheToDisk,
    trimChannelRuntimeCaches, trimConversationRuntimeCaches, cleanupDailyStatsFiles,
};
