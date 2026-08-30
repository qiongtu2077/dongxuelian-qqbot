"use strict";
/**
 * MODULE: 文件历史存储。
 * 职责: 存储群聊文件元数据、去重、过期清理、摘要回写。
 * 边界: 不调用 AI API、不发送消息。
 * 状态: 磁盘 JSON 文件 (data/file-history/{channelKey}.json)。
 */
const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../../core/constants');
const { getSafeMediaStorageKey: getSafeKey, getMediaHistoryFilePath, getLegacyMediaHistoryFilePath, } = require('../storage-key');
const FILE_HISTORY_DIR = path.join(DATA_DIR, 'file-history');
const FILE_CACHE_DIR = path.join(DATA_DIR, 'file-cache');
const FILE_EXPIRE_MS = 4 * 60 * 60 * 1000;
const FILE_ANALYZED_EXPIRE_MS = 24 * 60 * 60 * 1000;
const MAX_FILES_PER_CHANNEL = 20;
const MAX_HISTORY_FILE_BYTES = 256 * 1024;
const fileHistoryCache = new Map();
const fileStoreQueues = new Map();
function getLegacyPrivateKey(channelKey) {
    return /^private:/.test(String(channelKey || '')) ? 'private' : '';
}
function getPrivateUserId(channelKey) {
    return /^private:/.test(String(channelKey || '')) ? String(channelKey).slice('private:'.length) : '';
}
function matchesPrivateUser(entry, channelKey) {
    const userId = getPrivateUserId(channelKey);
    if (!userId)
        return true;
    return String(entry?.userId || '') === userId;
}
function getQueueKey(channelKey) {
    return getSafeKey(channelKey) || 'unknown';
}
function ignoreFileStoreQueueFailure(error) {
    void error;
}
function enqueueTask(channelKey, task) {
    const key = getQueueKey(channelKey);
    const previous = fileStoreQueues.get(key) || Promise.resolve();
    const current = previous.catch(ignoreFileStoreQueueFailure).then(task);
    const cleanup = current.finally(() => {
        if (fileStoreQueues.get(key) === cleanup)
            fileStoreQueues.delete(key);
    }).catch(ignoreFileStoreQueueFailure);
    fileStoreQueues.set(key, cleanup);
    return current;
}
function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    const data = entry;
    return {
        fileName: String(data.fileName || ''),
        fileSize: Number(data.fileSize) || 0,
        mimeType: String(data.mimeType || ''),
        ext: String(data.ext || ''),
        url: String(data.url || ''),
        fileId: data.fileId ? String(data.fileId) : null,
        conversationKey: data.conversationKey ? String(data.conversationKey) : '',
        userId: data.userId ? String(data.userId) : '',
        ts: Number(data.ts) || 0,
        skipped: !!data.skipped,
        skipReason: data.skipReason ? String(data.skipReason) : null,
        analyzed: !!data.analyzed,
        analysis: data.analysis == null ? null : String(data.analysis),
        localPath: data.localPath ? String(data.localPath) : null,
    };
}
function normalizeData(data) {
    const files = {};
    const record = data && typeof data === 'object' ? data : {};
    const source = record.files && typeof record.files === 'object'
        ? record.files : {};
    for (const [id, entry] of Object.entries(source)) {
        const norm = normalizeEntry(entry);
        if (norm)
            files[String(id)] = norm;
    }
    return { files };
}
function cleanExpiredWithChange(data) {
    const now = Date.now();
    const files = data.files || {};
    let changed = false;
    for (const id of Object.keys(files)) {
        const expiry = files[id].analyzed ? FILE_ANALYZED_EXPIRE_MS : FILE_EXPIRE_MS;
        if (now - (files[id].ts || 0) > expiry) {
            delete files[id];
            changed = true;
        }
    }
    const keys = Object.keys(files);
    if (keys.length > MAX_FILES_PER_CHANNEL) {
        keys.sort((a, b) => (files[a].ts || 0) - (files[b].ts || 0));
        for (let i = 0; i < keys.length - MAX_FILES_PER_CHANNEL; i++) {
            delete files[keys[i]];
            changed = true;
        }
    }
    data.files = files;
    return { data, changed };
}
function cleanExpired(data) {
    return cleanExpiredWithChange(data).data;
}
async function readFileHistory(channelKey) {
    const cacheKey = getQueueKey(channelKey);
    try {
        await fs.mkdir(FILE_HISTORY_DIR, { recursive: true });
        let fp = getMediaHistoryFilePath(FILE_HISTORY_DIR, channelKey);
        let stat;
        try {
            stat = await fs.stat(fp);
        }
        catch (error) {
            const legacyPath = getLegacyMediaHistoryFilePath(FILE_HISTORY_DIR, channelKey);
            if (!legacyPath || error?.code !== 'ENOENT')
                throw error;
            fp = legacyPath;
            stat = await fs.stat(fp);
        }
        if (!stat.isFile() || stat.size > MAX_HISTORY_FILE_BYTES)
            return { files: {} };
        const parsed = JSON.parse(await fs.readFile(fp, 'utf8'));
        const data = normalizeData(parsed);
        fileHistoryCache.set(cacheKey, data);
        return data;
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            fileHistoryCache.delete(cacheKey);
            return { files: {} };
        }
        const cached = fileHistoryCache.get(cacheKey);
        return cached ? normalizeData(cached) : { files: {} };
    }
}
async function writeFileHistory(channelKey, data) {
    try {
        await fs.mkdir(FILE_HISTORY_DIR, { recursive: true });
        const normalized = normalizeData(data);
        await fs.writeFile(getMediaHistoryFilePath(FILE_HISTORY_DIR, channelKey), JSON.stringify(normalized), 'utf8');
        fileHistoryCache.set(getQueueKey(channelKey), normalized);
        return true;
    }
    catch (error) {
        console.warn(`[file-store] write history failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
async function storeFile(channelKey, messageId, fileInfo) {
    if (!channelKey || !messageId || !fileInfo)
        return false;
    return enqueueTask(channelKey, async () => {
        const data = cleanExpired(await readFileHistory(channelKey));
        const id = String(messageId);
        if (data.files[id])
            return false;
        data.files[id] = {
            fileName: String(fileInfo.fileName || ''),
            fileSize: Number(fileInfo.fileSize) || 0,
            mimeType: String(fileInfo.mimeType || ''),
            ext: String(fileInfo.ext || ''),
            url: String(fileInfo.url || ''),
            fileId: fileInfo.fileId ? String(fileInfo.fileId) : null,
            conversationKey: fileInfo.conversationKey ? String(fileInfo.conversationKey) : '',
            userId: fileInfo.userId ? String(fileInfo.userId) : '',
            ts: Date.now(),
            skipped: !!fileInfo.skipped,
            skipReason: fileInfo.skipReason ? String(fileInfo.skipReason) : null,
            analyzed: false,
            analysis: null,
            localPath: null,
        };
        return writeFileHistory(channelKey, data);
    });
}
async function getFileEntry(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    return enqueueTask(channelKey, async () => {
        const data = await readFileHistory(channelKey);
        const entry = data.files[String(messageId)] || null;
        return entry ? { ...entry } : null;
    }).then(async (entry) => {
        if (entry)
            return entry;
        const legacyKey = getLegacyPrivateKey(channelKey);
        if (!legacyKey)
            return null;
        const legacyEntry = await getFileEntry(legacyKey, messageId);
        return matchesPrivateUser(legacyEntry, channelKey) ? legacyEntry : null;
    });
}
async function markFileAnalyzed(channelKey, messageId, analysis) {
    if (!channelKey || !messageId)
        return false;
    return enqueueTask(channelKey, async () => {
        const data = await readFileHistory(channelKey);
        const id = String(messageId);
        if (!data.files[id])
            return false;
        data.files[id].analyzed = true;
        data.files[id].analysis = String(analysis || '').slice(0, 1000);
        return writeFileHistory(channelKey, data);
    });
}
async function markFileSkipped(channelKey, messageId, reason) {
    if (!channelKey || !messageId)
        return false;
    return enqueueTask(channelKey, async () => {
        const data = await readFileHistory(channelKey);
        const id = String(messageId);
        if (!data.files[id])
            return false;
        data.files[id].skipped = true;
        data.files[id].skipReason = String(reason || 'unknown');
        return writeFileHistory(channelKey, data);
    });
}
async function setLocalPath(channelKey, messageId, localPath) {
    if (!channelKey || !messageId)
        return false;
    return enqueueTask(channelKey, async () => {
        const data = await readFileHistory(channelKey);
        const id = String(messageId);
        if (!data.files[id])
            return false;
        data.files[id].localPath = String(localPath);
        return writeFileHistory(channelKey, data);
    });
}
async function getRecentFiles(channelKey, limit = 5) {
    if (!channelKey)
        return [];
    const current = await enqueueTask(channelKey, async () => {
        const cleaned = cleanExpiredWithChange(await readFileHistory(channelKey));
        if (cleaned.changed)
            await writeFileHistory(channelKey, cleaned.data);
        return Object.entries(cleaned.data.files || {})
            .map(([id, entry]) => ({ messageId: id, ...entry }))
            .sort((a, b) => (b.ts || 0) - (a.ts || 0))
            .slice(0, limit);
    });
    const legacyKey = getLegacyPrivateKey(channelKey);
    if (!legacyKey || current.length >= limit)
        return current;
    const seen = new Set(current.map(file => String(file.messageId || '')));
    const legacy = await getRecentFiles(legacyKey, limit);
    return current
        .concat(legacy.filter(file => matchesPrivateUser(file, channelKey) && !seen.has(String(file.messageId || ''))))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit);
}
function getRecentFilesCached(channelKey, limit = 5) {
    const cached = fileHistoryCache.get(getQueueKey(channelKey));
    const files = [];
    if (cached) {
        const data = normalizeData(cached);
        files.push(...Object.entries(data.files || {}).map(([id, entry]) => ({ messageId: id, ...entry })));
    }
    const legacyKey = getLegacyPrivateKey(channelKey);
    const legacyCached = legacyKey ? fileHistoryCache.get(getQueueKey(legacyKey)) : null;
    if (legacyCached) {
        const seen = new Set(files.map(file => String(file.messageId || '')));
        const data = normalizeData(legacyCached);
        for (const [id, entry] of Object.entries(data.files || {})) {
            const file = { messageId: id, ...entry };
            if (matchesPrivateUser(file, channelKey) && !seen.has(String(id)))
                files.push(file);
        }
    }
    return files
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit);
}
const MAX_CACHED_FILES_PER_CHANNEL = 10;
function getSafeCacheDir(channelKey) {
    return path.join(FILE_CACHE_DIR, getSafeKey(channelKey));
}
async function enforceFileCacheLimit(channelKey) {
    try {
        const dir = getSafeCacheDir(channelKey);
        const names = await fs.readdir(dir);
        if (names.length <= MAX_CACHED_FILES_PER_CHANNEL)
            return;
        const entries = [];
        for (const name of names) {
            try {
                const stat = await fs.stat(path.join(dir, name));
                entries.push({ name, mtimeMs: stat.mtimeMs });
            }
            catch { /* non-critical: skip one unreadable cached file while enforcing cache limit */
            }
        }
        entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const toDelete = entries.slice(0, entries.length - MAX_CACHED_FILES_PER_CHANNEL);
        for (const entry of toDelete) {
            try {
                await fs.unlink(path.join(dir, entry.name));
            }
            catch { /* non-critical: best-effort cached file cleanup */
            }
        }
    }
    catch { /* non-critical: cache limit cleanup should not block file analysis */
    }
}
async function cacheFileLocally(channelKey, messageId, buffer, ext) {
    if (!channelKey || !messageId || !Buffer.isBuffer(buffer))
        return null;
    if (buffer.length > 1024 * 1024)
        return null;
    try {
        const dir = getSafeCacheDir(channelKey);
        await fs.mkdir(dir, { recursive: true });
        const safeId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = path.join(dir, `${safeId}.${ext || 'bin'}`);
        await fs.writeFile(filePath, buffer);
        await enforceFileCacheLimit(channelKey);
        return filePath;
    }
    catch (error) {
        console.warn(`[file-store] cache file locally failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
module.exports = {
    storeFile,
    getFileEntry,
    markFileAnalyzed,
    markFileSkipped,
    setLocalPath,
    getRecentFiles,
    getRecentFilesCached,
    cacheFileLocally,
    FILE_HISTORY_DIR,
    FILE_CACHE_DIR,
};
