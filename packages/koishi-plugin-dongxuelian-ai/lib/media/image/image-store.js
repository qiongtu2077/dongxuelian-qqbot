"use strict";
/**
 * MODULE: 图片历史存储。
 * 职责: 存储群聊图片 URL + 本地二进制缓存、去重、占位符替换、过期清理。
 * 边界: 不调用 AI API、不发送消息。
 * 状态: 磁盘 JSON 文件 (data/image-history/{channelKey}.json) + 本地图片文件。
 */
const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../../core/constants');
const { safeChannelKey } = require('../../core/utils');
const IMAGE_HISTORY_DIR = path.join(DATA_DIR, 'image-history');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const IMAGE_EXPIRE_MS = 2 * 60 * 60 * 1000;
const MAX_IMAGES_PER_CHANNEL = 10;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_CACHED_IMAGE_BYTES = 10 * 1024 * 1024;
const imageHistoryCache = new Map();
const imageStoreQueues = new Map();
function ignoreImageStoreQueueFailure() {
    // non-critical: keep per-channel image store queue alive after previous failure
}
function ignoreImageStoreCleanupFailure() {
    // non-critical: queue cleanup promise only guards map cleanup
}
function getSafeKey(channelKey) {
    const key = String(channelKey || '');
    return key ? safeChannelKey(key) : '';
}
function getLegacyUnsafeKey(channelKey) {
    return String(channelKey || '').replace(/[^a-zA-Z0-9.:_-]/g, '_');
}
function getLegacyUnsafeFilePath(channelKey) {
    const legacyKey = getLegacyUnsafeKey(channelKey);
    const safeKey = getSafeKey(channelKey);
    return legacyKey && legacyKey !== safeKey ? path.join(IMAGE_HISTORY_DIR, legacyKey + '.json') : '';
}
function getFilePath(channelKey) {
    return path.join(IMAGE_HISTORY_DIR, getSafeKey(channelKey) + '.json');
}
function getImageStoreQueueKey(channelKey) {
    return getSafeKey(channelKey) || 'unknown';
}
function normalizeImageEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    const data = entry;
    return {
        url: String(data.url || ''),
        file: data.file ? String(data.file) : null,
        conversationKey: data.conversationKey ? String(data.conversationKey) : '',
        userId: data.userId ? String(data.userId) : '',
        ts: Number(data.ts) || 0,
        analyzed: !!data.analyzed,
        analysis: data.analysis == null ? null : String(data.analysis),
        sourceRole: data.sourceRole === 'assistant' ? 'assistant' : 'user',
        sentByBot: !!data.sentByBot,
        analysisStatus: String(data.analysisStatus || (data.analyzed ? 'analyzed' : 'pending')).slice(0, 40),
        analysisKind: String(data.analysisKind || (data.analyzed ? 'objective' : '')).slice(0, 40),
    };
}
function cloneImageHistoryData(data) {
    const images = {};
    const record = data && typeof data === 'object' ? data : {};
    const source = record.images && typeof record.images === 'object'
        ? record.images
        : {};
    for (const [id, entry] of Object.entries(source)) {
        const normalized = normalizeImageEntry(entry);
        if (!normalized)
            continue;
        images[String(id)] = { ...normalized };
    }
    return { images };
}
function normalizeImageHistoryData(data) {
    const images = {};
    const record = data && typeof data === 'object' ? data : {};
    const source = record.images && typeof record.images === 'object'
        ? record.images
        : {};
    for (const [id, entry] of Object.entries(source)) {
        const normalized = normalizeImageEntry(entry);
        if (normalized)
            images[String(id)] = normalized;
    }
    return { images };
}
function enqueueImageStoreTask(channelKey, task) {
    const key = getImageStoreQueueKey(channelKey);
    const previous = imageStoreQueues.get(key) || Promise.resolve();
    const current = previous.catch(ignoreImageStoreQueueFailure).then(task);
    const cleanup = current.finally(() => {
        if (imageStoreQueues.get(key) === cleanup)
            imageStoreQueues.delete(key);
    }).catch(ignoreImageStoreCleanupFailure);
    imageStoreQueues.set(key, cleanup);
    return current;
}
async function readImageHistory(channelKey) {
    const cacheKey = getImageStoreQueueKey(channelKey);
    try {
        await fs.mkdir(IMAGE_HISTORY_DIR, { recursive: true });
        let file = getFilePath(channelKey);
        let stat;
        try {
            stat = await fs.stat(file);
        }
        catch (error) {
            const legacyPath = getLegacyUnsafeFilePath(channelKey);
            if (!legacyPath || error?.code !== 'ENOENT')
                throw error;
            file = legacyPath;
            stat = await fs.stat(file);
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            return { images: {} };
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        const data = normalizeImageHistoryData(parsed);
        if (file !== getFilePath(channelKey)) {
            await writeImageHistory(channelKey, data);
        }
        imageHistoryCache.set(cacheKey, cloneImageHistoryData(data));
        return data;
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            imageHistoryCache.delete(cacheKey);
            return { images: {} };
        }
        const cached = imageHistoryCache.get(cacheKey);
        return cached ? cloneImageHistoryData(cached) : { images: {} };
    }
}
async function writeImageHistory(channelKey, data) {
    try {
        await fs.mkdir(IMAGE_HISTORY_DIR, { recursive: true });
        const normalized = normalizeImageHistoryData(data);
        await fs.writeFile(getFilePath(channelKey), JSON.stringify(normalized), 'utf8');
        imageHistoryCache.set(getImageStoreQueueKey(channelKey), cloneImageHistoryData(normalized));
        return true;
    }
    catch (error) {
        console.warn(`[image-store] write history failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
function cleanExpired(data) {
    const now = Date.now();
    const images = data.images || {};
    for (const id of Object.keys(images)) {
        if (now - (images[id].ts || 0) > IMAGE_EXPIRE_MS)
            delete images[id];
    }
    const keys = Object.keys(images);
    if (keys.length > MAX_IMAGES_PER_CHANNEL) {
        keys.sort((a, b) => (images[a].ts || 0) - (images[b].ts || 0));
        for (let i = 0; i < keys.length - MAX_IMAGES_PER_CHANNEL; i++)
            delete images[keys[i]];
    }
    data.images = images;
    return data;
}
function getRecentImagesFromData(data, limit = 5) {
    return Object.entries(data.images || {})
        .map(([id, entry]) => ({ messageId: id, ...entry }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit);
}
async function storeImageUrl(channelKey, messageId, url, file, meta = {}) {
    const normalizedUrl = String(url || '').trim();
    const normalizedFile = file ? String(file) : null;
    if (!channelKey || !messageId || (!normalizedUrl && !normalizedFile))
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = cleanExpired(await readImageHistory(channelKey));
        const id = String(messageId);
        if (data.images[id]) {
            let changed = false;
            if (normalizedUrl && !data.images[id].url) {
                data.images[id].url = normalizedUrl;
                changed = true;
            }
            if (normalizedFile && !data.images[id].file) {
                data.images[id].file = normalizedFile;
                changed = true;
            }
            if (meta.conversationKey && !data.images[id].conversationKey) {
                data.images[id].conversationKey = String(meta.conversationKey);
                changed = true;
            }
            if (meta.userId && !data.images[id].userId) {
                data.images[id].userId = String(meta.userId);
                changed = true;
            }
            return changed ? writeImageHistory(channelKey, data) : false;
        }
        data.images[id] = {
            url: normalizedUrl,
            file: normalizedFile,
            conversationKey: meta.conversationKey ? String(meta.conversationKey) : '',
            userId: meta.userId ? String(meta.userId) : '',
            ts: Date.now(),
            analyzed: false,
            analysis: null,
            sourceRole: meta.sourceRole === 'assistant' ? 'assistant' : 'user',
            sentByBot: !!meta.sentByBot,
            analysisStatus: 'pending',
            analysisKind: '',
        };
        return writeImageHistory(channelKey, data);
    });
}
async function getImageEntry(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readImageHistory(channelKey);
        const entry = data.images[String(messageId)] || null;
        return entry ? { ...entry } : null;
    });
}
async function getRecentImages(channelKey, limit = 5) {
    if (!channelKey)
        return [];
    return enqueueImageStoreTask(channelKey, async () => {
        const data = cleanExpired(await readImageHistory(channelKey));
        await writeImageHistory(channelKey, data);
        return getRecentImagesFromData(data, limit);
    });
}
function getRecentImagesCached(channelKey, limit = 5) {
    const cached = imageHistoryCache.get(getImageStoreQueueKey(channelKey));
    if (!cached)
        return [];
    const data = cleanExpired(cloneImageHistoryData(cached));
    return getRecentImagesFromData(data, limit);
}
async function markAnalyzed(channelKey, messageId, analysis) {
    if (!channelKey || !messageId)
        return false;
    const { sanitizeImageAnalysis } = require('./image-analysis-sanitizer');
    const sanitized = sanitizeImageAnalysis(String(analysis || ''));
    if (!sanitized)
        return markAnalysisUnavailable(channelKey, messageId, 'unavailable');
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readImageHistory(channelKey);
        const id = String(messageId);
        if (!data.images[id])
            return false;
        data.images[id].analyzed = true;
        data.images[id].analysis = sanitized;
        data.images[id].analysisStatus = 'analyzed';
        data.images[id].analysisKind = 'objective';
        return writeImageHistory(channelKey, data);
    });
}
async function markAnalysisUnavailable(channelKey, messageId, status = 'unavailable') {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readImageHistory(channelKey);
        const id = String(messageId);
        if (!data.images[id])
            return false;
        data.images[id].analyzed = false;
        data.images[id].analysis = null;
        data.images[id].analysisStatus = String(status || 'unavailable').slice(0, 40);
        data.images[id].analysisKind = '';
        return writeImageHistory(channelKey, data);
    });
}
async function storeAssistantImageAnchor(channelKey, messageId, meta = {}) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = cleanExpired(await readImageHistory(channelKey));
        const id = String(messageId);
        const previous = data.images[id] || null;
        data.images[id] = {
            url: String(meta.url || previous?.url || ''),
            file: meta.file ? String(meta.file) : (previous?.file || null),
            conversationKey: meta.conversationKey ? String(meta.conversationKey) : (previous?.conversationKey || ''),
            userId: meta.userId ? String(meta.userId) : (previous?.userId || 'bot'),
            ts: Number(meta.ts || previous?.ts || Date.now()),
            analyzed: !!previous?.analyzed,
            analysis: previous?.analysis == null ? null : String(previous.analysis),
            sourceRole: 'assistant',
            sentByBot: true,
            analysisStatus: previous?.analysisStatus || 'pending',
            analysisKind: previous?.analysisKind || '',
        };
        return writeImageHistory(channelKey, data);
    });
}
async function isAlreadyAnalyzed(channelKey, messageId) {
    const entry = await getImageEntry(channelKey, messageId);
    return !!(entry && entry.analyzed);
}
async function getCachedAnalysis(channelKey, messageId) {
    const entry = await getImageEntry(channelKey, messageId);
    return entry && entry.analyzed ? entry.analysis : null;
}
function getChannelCacheDir(channelKey) {
    return path.join(IMAGE_CACHE_DIR, getSafeKey(channelKey));
}
async function cacheImageFile(channelKey, messageId, buffer) {
    if (!channelKey || !messageId || !Buffer.isBuffer(buffer))
        return null;
    if (buffer.length > MAX_CACHED_IMAGE_BYTES)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        try {
            const dir = getChannelCacheDir(channelKey);
            await fs.mkdir(dir, { recursive: true });
            const ext = detectImageExt(buffer);
            const filePath = path.join(dir, `${getSafeKey(messageId)}.${ext}`);
            await fs.writeFile(filePath, buffer);
            await enforceChannelCacheLimitNow(channelKey);
            return filePath;
        }
        catch (error) {
            console.warn(`[image-store] cache image failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    });
}
async function readCachedImage(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        try {
            const dir = getChannelCacheDir(channelKey);
            const safeMessageId = getSafeKey(messageId);
            const files = (await fs.readdir(dir)).filter((f) => path.parse(f).name === safeMessageId);
            if (!files.length)
                return null;
            const filePath = path.join(dir, files[0]);
            const stat = await fs.stat(filePath);
            if (!stat.isFile() || stat.size > MAX_CACHED_IMAGE_BYTES)
                return null;
            const buf = await fs.readFile(filePath);
            const mime = mimeFromExt(path.extname(filePath));
            return `data:${mime};base64,${buf.toString('base64')}`;
        }
        catch { /* non-critical: missing/unreadable cached image falls back to fresh download */
            return null;
        }
    });
}
async function enforceChannelCacheLimitNow(channelKey) {
    try {
        const dir = getChannelCacheDir(channelKey);
        const names = await fs.readdir(dir);
        const files = [];
        for (const name of names) {
            try {
                const fp = path.join(dir, name);
                const stat = await fs.stat(fp);
                if (stat.isFile())
                    files.push({ name, path: fp, mtime: stat.mtimeMs });
            }
            catch { /* non-critical: skip one unreadable cached image while enforcing cache limit */
            }
        }
        files.sort((a, b) => b.mtime - a.mtime);
        if (files.length > MAX_IMAGES_PER_CHANNEL) {
            for (let i = MAX_IMAGES_PER_CHANNEL; i < files.length; i++) {
                try {
                    await fs.unlink(files[i].path);
                }
                catch { /* non-critical: best-effort cached image cleanup */
                }
            }
        }
    }
    catch { /* non-critical: cache limit cleanup should not block image analysis */
    }
}
async function enforceChannelCacheLimit(channelKey) {
    if (!channelKey)
        return;
    return enqueueImageStoreTask(channelKey, () => enforceChannelCacheLimitNow(channelKey));
}
function detectImageExt(buffer) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50)
        return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49)
        return 'gif';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57 && buffer[9] === 0x45)
        return 'webp';
    return 'jpg';
}
function mimeFromExt(ext) {
    const e = String(ext).replace('.', '').toLowerCase();
    if (e === 'png')
        return 'image/png';
    if (e === 'gif')
        return 'image/gif';
    if (e === 'webp')
        return 'image/webp';
    return 'image/jpeg';
}
async function replaceImagePlaceholder(channelKey, messageId, analysis) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const { replaceImagePlaceholderInConversation } = require('../../conversation');
        const imageEntry = (await readImageHistory(channelKey)).images[String(messageId)] || null;
        const convKey = imageEntry && imageEntry.conversationKey ? imageEntry.conversationKey : channelKey;
        return replaceImagePlaceholderInConversation(convKey, messageId, analysis);
    });
}
module.exports = {
    storeImageUrl,
    getImageEntry,
    getRecentImages,
    getRecentImagesCached,
    markAnalyzed,
    markAnalysisUnavailable,
    storeAssistantImageAnchor,
    isAlreadyAnalyzed,
    getCachedAnalysis,
    replaceImagePlaceholder,
    cacheImageFile,
    readCachedImage,
    enforceChannelCacheLimit,
    IMAGE_HISTORY_DIR,
    IMAGE_CACHE_DIR,
};
