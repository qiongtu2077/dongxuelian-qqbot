"use strict";
/**
 * MODULE: 图片历史与原图存储。
 * 职责: 统一执行两小时、每频道十条及单图十兆限制，联动记录和物理文件。
 * 边界: 不调用模型、不下载图片、不发送消息。
 */
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { DATA_DIR } = require('../../core/constants');
const { isProcessAlive } = require('../../resource-common/files');
const { getSafeMediaStorageKey: getSafeKey, getMediaHistoryFilePath, getLegacyMediaHistoryFilePath, } = require('../storage-key');
const IMAGE_HISTORY_DIR = path.join(DATA_DIR, 'image-history');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const IMAGE_EXPIRE_MS = 2 * 60 * 60 * 1000;
const MAX_IMAGES_PER_CHANNEL = 10;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_CACHED_IMAGE_BYTES = 10 * 1024 * 1024;
const imageHistoryCache = new Map();
const imageStoreQueues = new Map();
// --- 记录规范化与保留规则 --- //
// 将磁盘中的既有记录转换为统一结构，未分析记录默认仅表示已记录。
function normalizeImageEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    const data = entry;
    return {
        url: String(data.url || ''),
        file: data.file ? String(data.file) : null,
        conversationKey: String(data.conversationKey || ''),
        userId: String(data.userId || ''),
        ts: Number(data.ts) || 0,
        analyzed: !!data.analyzed,
        analysis: data.analysis == null ? null : String(data.analysis),
        sourceRole: data.sourceRole === 'assistant' ? 'assistant' : 'user',
        sentByBot: !!data.sentByBot,
        analysisStatus: String(data.analysisStatus || (data.analyzed ? 'analyzed' : 'recorded')).slice(0, 40),
        analysisKind: String(data.analysisKind || (data.analyzed ? 'objective' : '')).slice(0, 40),
    };
}
// 克隆历史结构，避免同步读取者修改共享缓存。
function normalizeImageHistoryData(value) {
    const images = {};
    const data = value && typeof value === 'object' ? value : {};
    const source = data.images && typeof data.images === 'object' ? data.images : {};
    for (const [id, entry] of Object.entries(source)) {
        const normalized = normalizeImageEntry(entry);
        if (normalized)
            images[id] = normalized;
    }
    return { images };
}
// 原图片时间决定有效性；访问和重试均不延长窗口。
function cleanExpired(data) {
    const now = Date.now();
    const ids = Object.keys(data.images)
        .filter(id => data.images[id].ts > 0 && now - data.images[id].ts < IMAGE_EXPIRE_MS)
        .sort((a, b) => data.images[b].ts - data.images[a].ts);
    const retained = new Set(ids.slice(0, MAX_IMAGES_PER_CHANNEL));
    let removed = 0;
    for (const id of Object.keys(data.images)) {
        if (!retained.has(id)) {
            delete data.images[id];
            removed++;
        }
    }
    return removed;
}
// 按图片时间提供有限的最近候选，不改变原记录。
function getRecentImagesFromData(data, limit) {
    return Object.entries(data.images).map(([messageId, entry]) => ({ messageId, ...entry }))
        .sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, Math.min(MAX_IMAGES_PER_CHANNEL, limit)));
}
// --- 原子存储与跨进程所有权 --- //
// 同频道串行操作并取得磁盘所有权，防止插件进程与媒体进程相互覆盖。
function enqueueImageStoreTask(channelKey, task) {
    const key = getSafeKey(channelKey);
    const previous = imageStoreQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => { }).then(async () => {
        await fs.mkdir(IMAGE_HISTORY_DIR, { recursive: true });
        const lock = getMediaHistoryFilePath(IMAGE_HISTORY_DIR, channelKey) + '.lock';
        const owner = `${process.pid}:${randomUUID()}`;
        const candidate = `${lock}.${randomUUID()}.tmp`;
        // 先写完整所有者再通过 hard link 原子发布，其他进程不会读到半条锁记录。
        await fs.writeFile(candidate, owner, { flag: 'wx' });
        let acquired = false;
        try {
            const deadline = Date.now() + 5000;
            while (!acquired) {
                try {
                    await fs.link(candidate, lock);
                    acquired = true;
                }
                catch (error) {
                    if (error.code !== 'EEXIST')
                        throw error;
                    const existing = await fs.readFile(lock, 'utf8').catch(() => '');
                    if (existing && !isProcessAlive(Number(existing.split(':')[0]))) {
                        if (await fs.readFile(lock, 'utf8').catch(() => '') === existing)
                            await fs.unlink(lock).catch(() => { });
                    }
                    if (Date.now() >= deadline)
                        throw new Error('image_store_lock_timeout');
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            }
            return await task();
        }
        finally {
            await fs.unlink(candidate).catch(() => { });
            if (acquired && await fs.readFile(lock, 'utf8').catch(() => '') === owner)
                await fs.unlink(lock).catch(() => { });
        }
    });
    const cleanup = current.finally(() => {
        if (imageStoreQueues.get(key) === cleanup)
            imageStoreQueues.delete(key);
    }).catch(() => { });
    imageStoreQueues.set(key, cleanup);
    return current;
}
// 读取实际磁盘记录；失败时不以旧内存缓存复活已删除的图片。
async function readImageHistory(channelKey) {
    const safeFile = getMediaHistoryFilePath(IMAGE_HISTORY_DIR, channelKey);
    let file = safeFile;
    try {
        let stat;
        try {
            stat = await fs.stat(file);
        }
        catch (error) {
            const legacy = getLegacyMediaHistoryFilePath(IMAGE_HISTORY_DIR, channelKey);
            if (!legacy || error.code !== 'ENOENT')
                throw error;
            file = legacy;
            stat = await fs.stat(file);
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            return { images: {} };
        const data = normalizeImageHistoryData(JSON.parse(await fs.readFile(file, 'utf8')));
        if (file !== safeFile && await writeImageHistory(channelKey, data))
            await fs.unlink(file);
        return data;
    }
    catch (error) {
        imageHistoryCache.delete(getSafeKey(channelKey));
        if (error.code !== 'ENOENT')
            console.warn(`[image-store] read failed: ${error instanceof Error ? error.message : String(error)}`);
        return { images: {} };
    }
}
// 原子替换历史文件；缓存只在磁盘写入成功后更新。
async function writeImageHistory(channelKey, data) {
    const file = getMediaHistoryFilePath(IMAGE_HISTORY_DIR, channelKey);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.mkdir(IMAGE_HISTORY_DIR, { recursive: true });
        await fs.writeFile(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temp, file);
        imageHistoryCache.set(getSafeKey(channelKey), normalizeImageHistoryData(data));
        return true;
    }
    catch (error) {
        console.warn(`[image-store] write failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    finally {
        await fs.unlink(temp).catch(() => { });
    }
}
// 返回限定频道内的物理缓存目录。
function getChannelCacheDir(channelKey) {
    return path.join(IMAGE_CACHE_DIR, getSafeKey(channelKey));
}
// 删除没有有效记录、重复格式或超大小的原图，保留每条有效记录最多一个文件。
async function cleanupChannelFiles(channelKey, data) {
    const dir = getChannelCacheDir(channelKey);
    const retained = new Set(Object.keys(data.images).map(id => getSafeKey(id)));
    const seen = new Set();
    let removed = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory())
            continue;
        const file = path.join(dir, entry.name);
        const id = path.parse(entry.name).name;
        const stat = await fs.lstat(file).catch(() => null);
        const valid = entry.isFile() && !!stat && stat.size > 0 && stat.size <= MAX_CACHED_IMAGE_BYTES
            && retained.has(id) && !seen.has(id) && /^\.(?:png|jpg|gif|webp)$/.test(path.extname(entry.name));
        if (valid)
            seen.add(id);
        else {
            try {
                await fs.unlink(file);
                removed++;
            }
            catch { /* 并行清理已移除的文件无需重试。 */ }
        }
    }
    return removed;
}
// 在每次读写之前统一裁剪记录并回收对应原图。
async function readRetainedHistory(channelKey) {
    const data = await readImageHistory(channelKey);
    const removed = cleanExpired(data);
    if (removed)
        await writeImageHistory(channelKey, data);
    else
        imageHistoryCache.set(getSafeKey(channelKey), normalizeImageHistoryData(data));
    await cleanupChannelFiles(channelKey, data);
    return data;
}
// --- 图片记录与分析结果 --- //
// 保存图片身份；入站状态只表示 recorded，不表示已排队分析。
async function storeImageUrl(channelKey, messageId, url, file, meta = {}) {
    const normalizedUrl = String(url || '').trim();
    const normalizedFile = file ? String(file) : null;
    if (!channelKey || !messageId || (!normalizedUrl && !normalizedFile))
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        const previous = data.images[messageId];
        if (previous) {
            previous.url || (previous.url = normalizedUrl);
            previous.file || (previous.file = normalizedFile);
            previous.conversationKey || (previous.conversationKey = String(meta.conversationKey || ''));
            previous.userId || (previous.userId = String(meta.userId || ''));
        }
        else {
            data.images[messageId] = {
                url: normalizedUrl, file: normalizedFile,
                conversationKey: String(meta.conversationKey || ''), userId: String(meta.userId || ''),
                ts: Number(meta.ts) || Date.now(), analyzed: false, analysis: null,
                sourceRole: meta.sourceRole === 'assistant' ? 'assistant' : 'user', sentByBot: !!meta.sentByBot,
                analysisStatus: 'recorded', analysisKind: '',
            };
        }
        cleanExpired(data);
        const written = await writeImageHistory(channelKey, data);
        if (written)
            await cleanupChannelFiles(channelKey, data);
        return written;
    });
}
// 按原消息编号读取仍在保留窗口内的记录。
async function getImageEntry(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        const entry = (await readRetainedHistory(channelKey)).images[messageId];
        return entry ? { ...entry } : null;
    });
}
// 读取有限候选并同步回收失效记录及原图。
async function getRecentImages(channelKey, limit = 5) {
    if (!channelKey)
        return [];
    return enqueueImageStoreTask(channelKey, async () => getRecentImagesFromData(await readRetainedHistory(channelKey), limit));
}
// 同步提示仅读内存，并在返回前立即拒绝过期记录。
function getRecentImagesCached(channelKey, limit = 5) {
    const cached = imageHistoryCache.get(getSafeKey(channelKey));
    if (!cached)
        return [];
    const data = normalizeImageHistoryData(cached);
    cleanExpired(data);
    if (!Object.keys(data.images).length)
        imageHistoryCache.delete(getSafeKey(channelKey));
    return getRecentImagesFromData(data, limit);
}
// 仅为仍然有效的原图片写回净化后的客观摘要。
async function markAnalyzed(channelKey, messageId, analysis) {
    if (!channelKey || !messageId)
        return false;
    const { sanitizeImageAnalysis } = require('./image-analysis-sanitizer');
    const sanitized = sanitizeImageAnalysis(String(analysis || ''));
    if (!sanitized)
        return markAnalysisUnavailable(channelKey, messageId);
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        const entry = data.images[messageId];
        if (!entry)
            return false;
        Object.assign(entry, { analyzed: true, analysis: sanitized, analysisStatus: 'analyzed', analysisKind: 'objective' });
        return writeImageHistory(channelKey, data);
    });
}
// 为有效记录设置分析状态，缓存操作不会调用此接口。
async function markAnalysisUnavailable(channelKey, messageId, status = 'unavailable') {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        const entry = data.images[messageId];
        if (!entry)
            return false;
        // 旧任务迁移前的快照可能已经落后于前台识图；持锁重读后不能清掉刚写入的摘要。
        if (status === 'recorded' && entry.analyzed)
            return false;
        Object.assign(entry, { analyzed: false, analysis: null, analysisStatus: status.slice(0, 40), analysisKind: '' });
        return writeImageHistory(channelKey, data);
    });
}
// 标记已成功排队的识图需求；细节追问排队期间保留现有客观摘要。
async function markAnalysisPending(channelKey, messageId, isStillQueued) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        if (!data.images[messageId])
            return false;
        if (isStillQueued && !isStillQueued())
            return false;
        data.images[messageId].analysisStatus = 'pending';
        return writeImageHistory(channelKey, data);
    });
}
// 仅结算仍在等待且没有其他活跃需求的状态；失败或取消不能清除已有客观摘要。
async function finishImageAnalysisStatus(channelKey, messageId, status, canFinish) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        const entry = data.images[messageId];
        // 队列和识别持有者在存储锁内复核，新的 pending 写入会按同一锁顺序生效。
        if (!entry || entry.analysisStatus !== 'pending' || !canFinish())
            return false;
        entry.analysisStatus = status;
        return writeImageHistory(channelKey, data);
    });
}
// 保存机器人发送的图片锚点，保留已有分析及原图片时间。
async function storeAssistantImageAnchor(channelKey, messageId, meta = {}) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        const previous = data.images[messageId];
        data.images[messageId] = {
            url: String(meta.url || previous?.url || ''), file: meta.file ? String(meta.file) : previous?.file || null,
            conversationKey: String(meta.conversationKey || previous?.conversationKey || ''),
            userId: String(meta.userId || previous?.userId || 'bot'), ts: previous?.ts || Number(meta.ts) || Date.now(),
            analyzed: !!previous?.analyzed, analysis: previous?.analysis || null,
            sourceRole: 'assistant', sentByBot: true,
            analysisStatus: previous?.analysisStatus || 'recorded', analysisKind: previous?.analysisKind || '',
        };
        cleanExpired(data);
        const written = await writeImageHistory(channelKey, data);
        if (written)
            await cleanupChannelFiles(channelKey, data);
        return written;
    });
}
// 查询有效图片是否已有分析结果。
async function isAlreadyAnalyzed(channelKey, messageId) {
    return !!(await getImageEntry(channelKey, messageId))?.analyzed;
}
// 读取有效图片的已有摘要。
async function getCachedAnalysis(channelKey, messageId) {
    const entry = await getImageEntry(channelKey, messageId);
    return entry?.analyzed ? entry.analysis : null;
}
// 将摘要替换到原图所属会话；失效目标不再回写。
async function replaceImagePlaceholder(channelKey, messageId, analysis) {
    if (!channelKey || !messageId)
        return false;
    return enqueueImageStoreTask(channelKey, async () => {
        const entry = (await readRetainedHistory(channelKey)).images[messageId];
        if (!entry)
            return false;
        const { replaceImagePlaceholderInConversation } = require('../../conversation');
        return replaceImagePlaceholderInConversation(entry.conversationKey || channelKey, messageId, analysis);
    });
}
// --- 原图文件与全局维护 --- //
// 在有效记录所有权内原子写原图，下载结束不能复活已淘汰的对象。
async function cacheImageFile(channelKey, messageId, buffer) {
    if (!channelKey || !messageId || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CACHED_IMAGE_BYTES)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        if (!data.images[messageId])
            return null;
        const dir = getChannelCacheDir(channelKey);
        const file = path.join(dir, `${getSafeKey(messageId)}.${detectImageExt(buffer)}`);
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(temp, buffer, { flag: 'wx' });
            // 写文件期间也可能跨过两小时边界；提交前再次检查原记录。
            if (Date.now() - data.images[messageId].ts >= IMAGE_EXPIRE_MS) {
                cleanExpired(data);
                await writeImageHistory(channelKey, data);
                await cleanupChannelFiles(channelKey, data);
                return null;
            }
            await fs.rename(temp, file);
            // 同一消息更新图片格式时明确保留本次原图，不能由目录顺序误留旧格式。
            for (const name of await fs.readdir(dir)) {
                const alternate = path.join(dir, name);
                if (alternate !== file && path.parse(name).name === getSafeKey(messageId))
                    await fs.unlink(alternate).catch(() => { });
            }
            await cleanupChannelFiles(channelKey, data);
            return file;
        }
        catch (error) {
            console.warn(`[image-store] cache failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
        finally {
            await fs.unlink(temp).catch(() => { });
        }
    });
}
// 只读取有效记录对应的受限本地原图，读取不会延长图片寿命。
async function readCachedImage(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    return enqueueImageStoreTask(channelKey, async () => {
        const data = await readRetainedHistory(channelKey);
        if (!data.images[messageId])
            return null;
        const dir = getChannelCacheDir(channelKey);
        for (const name of await fs.readdir(dir).catch(() => [])) {
            if (path.parse(name).name !== getSafeKey(messageId))
                continue;
            const file = path.join(dir, name);
            try {
                const buffer = await fs.readFile(file);
                if (!buffer.length || buffer.length > MAX_CACHED_IMAGE_BYTES)
                    return null;
                if (Date.now() - data.images[messageId].ts >= IMAGE_EXPIRE_MS)
                    return null;
                return `data:${mimeFromExt(path.extname(file))};base64,${buffer.toString('base64')}`;
            }
            catch {
                return null;
            }
        }
        return null;
    });
}
// 对单频道执行完整保留策略，兼容既有调用方。
async function enforceChannelCacheLimit(channelKey) {
    if (!channelKey)
        return;
    await enqueueImageStoreTask(channelKey, async () => { await readRetainedHistory(channelKey); });
}
// 启动及周期扫描全部历史和缓存目录，回收无人再访问的过期与孤立原图。
async function cleanupImageStorage() {
    const keys = new Set();
    for (const entry of await fs.readdir(IMAGE_HISTORY_DIR, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith('.json'))
            keys.add(entry.name.slice(0, -5));
    }
    for (const entry of await fs.readdir(IMAGE_CACHE_DIR, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory())
            keys.add(entry.name);
    }
    const result = { channels: 0, removedRecords: 0, removedFiles: 0 };
    for (const key of keys) {
        await enqueueImageStoreTask(key, async () => {
            const data = await readImageHistory(key);
            const removed = cleanExpired(data);
            if (removed)
                await writeImageHistory(key, data);
            result.removedRecords += removed;
            result.removedFiles += await cleanupChannelFiles(key, data);
            result.channels++;
            if (!Object.keys(data.images).length)
                imageHistoryCache.delete(key);
        });
    }
    // 崩溃可能留下原子写临时文件及锁候选；活进程的所有权与写入始终保留。
    for (const item of await fs.readdir(IMAGE_HISTORY_DIR, { withFileTypes: true }).catch(() => [])) {
        if (!item.isFile() || !/\.json(?:\.lock)?(?:\.[\w.-]+\.tmp|\.lock)$/.test(item.name))
            continue;
        const file = path.join(IMAGE_HISTORY_DIR, item.name);
        const owner = await fs.readFile(file, 'utf8').catch(() => '');
        const pid = Number(item.name.match(/\.json\.(\d+)\.[\w-]+\.tmp$/)?.[1] || owner.split(':')[0]);
        const stat = await fs.stat(file).catch(() => null);
        if (isProcessAlive(pid) || (!pid && (!stat || Date.now() - stat.mtimeMs < 60000)))
            continue;
        if (await fs.readFile(file, 'utf8').catch(() => '') === owner) {
            try {
                await fs.unlink(file);
                result.removedFiles++;
            }
            catch { /* 已被所有者或其他维护移除。 */ }
        }
    }
    return result;
}
// 依图片头选择既有支持的文件扩展名。
function detectImageExt(buffer) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50)
        return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49)
        return 'gif';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57 && buffer[9] === 0x45)
        return 'webp';
    return 'jpg';
}
// 为缓存文件生成数据 URL MIME。
function mimeFromExt(ext) {
    if (ext === '.png')
        return 'image/png';
    if (ext === '.gif')
        return 'image/gif';
    if (ext === '.webp')
        return 'image/webp';
    return 'image/jpeg';
}
module.exports = {
    storeImageUrl, getImageEntry, getRecentImages, getRecentImagesCached, finishImageAnalysisStatus,
    markAnalyzed, markAnalysisUnavailable, markAnalysisPending, storeAssistantImageAnchor,
    isAlreadyAnalyzed, getCachedAnalysis, replaceImagePlaceholder,
    cacheImageFile, readCachedImage, enforceChannelCacheLimit, cleanupImageStorage,
    IMAGE_HISTORY_DIR, IMAGE_CACHE_DIR,
};
