"use strict";
/**
 * MODULE: 后台图片分析。
 * 职责: 异步下载图片 → 缓存本地 → 调视觉模型分析 → 写回 image-store + 替换占位符。
 * 边界: 全程静默，不发消息，不阻塞 chat/agent。
 * 状态: 内存并发队列。
 */
const { downloadImageAsBase64, callGetImage, readImageAsBase64, isVisionModel, requestChatCompletions } = require('../../core/api');
const { loadConfig } = require('../../core/runtime-config');
const { markAnalyzed, replaceImagePlaceholder, cacheImageFile, readCachedImage, getImageEntry } = require('./image-store');
const { isVisionBlindnessReply } = require('./vision');
const MAX_CONCURRENT = 2;
const ANALYSIS_TIMEOUT_MS = 20000;
let activeCount = 0;
const queue = [];
const inFlight = new Map();
function getImageAnalyzerErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function imageTaskKey(channelKey, messageId) {
    return `${String(channelKey || '')}::${String(messageId || '')}`;
}
async function enqueueAnalysis(channelKey, messageId) {
    if (!channelKey || !messageId)
        return;
    try {
        const entry = await getImageEntry(channelKey, messageId);
        if (!entry || entry.analyzed)
            return;
        const key = imageTaskKey(channelKey, messageId);
        if (inFlight.has(key) || queue.some(item => imageTaskKey(item.channelKey, item.messageId) === key))
            return;
        if (queue.length >= 200)
            return;
        queue.push({ channelKey, messageId, url: entry.url, file: entry.file });
        drainQueue();
    }
    catch (error) {
        console.warn(`[image-analyzer] enqueue failed: ${getImageAnalyzerErrorMessage(error)}`);
    }
}
function drainQueue() {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
        const task = queue.shift();
        if (!task)
            return;
        activeCount++;
        const key = imageTaskKey(task.channelKey, task.messageId);
        const promise = runAnalysis(task);
        inFlight.set(key, promise);
        promise.finally(() => {
            if (inFlight.get(key) === promise)
                inFlight.delete(key);
            activeCount--;
            drainQueue();
        });
    }
}
async function runAnalysis({ channelKey, messageId, url, file }) {
    try {
        const freshEntry = await getImageEntry(channelKey, messageId);
        if (!freshEntry)
            return null;
        if (freshEntry.analyzed && freshEntry.analysis)
            return freshEntry.analysis;
        url = url || freshEntry.url;
        file = file || freshEntry.file;
        let base64 = await readCachedImage(channelKey, messageId);
        if (!base64 && file) {
            try {
                const imgInfo = await callGetImage(file);
                if (imgInfo && imgInfo.file) {
                    base64 = await readImageAsBase64(String(imgInfo.file));
                    if (base64) {
                        const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
                        await cacheImageFile(channelKey, messageId, buf);
                    }
                }
            }
            catch { /* non-critical: OneBot get_image failure falls back to URL download */
            }
        }
        if (!base64 && url) {
            base64 = await downloadImageAsBase64(url, 10000);
            if (base64) {
                const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
                await cacheImageFile(channelKey, messageId, buf);
            }
        }
        if (!base64)
            return null;
        const config = await loadConfig();
        if (!isVisionModel(config.provider, config.model))
            return null;
        const messages = [
            { role: 'user', content: [
                    { type: 'text', text: '只描述图片中客观看到的内容，50字以内。不要称呼用户，不要续聊，不要评价好不好玩，不要角色扮演语气。' },
                    { type: 'image_url', image_url: { url: base64 } },
                ] },
        ];
        const result = await requestChatCompletions(messages, config, { max_tokens: 200, _timeoutMs: ANALYSIS_TIMEOUT_MS });
        const resultRecord = result && typeof result === 'object' ? result : null;
        const rawAnalysis = typeof result === 'string' ? result : (resultRecord && resultRecord.content || '');
        const { sanitizeImageAnalysis } = require('./image-analysis-sanitizer');
        const analysis = sanitizeImageAnalysis(String(rawAnalysis || ''));
        if (!analysis)
            return null;
        if (isVisionBlindnessReply(analysis)) {
            console.warn(`[image-analyzer] vision blindness, skipping write. provider=${config.provider} model=${config.model} reply=${analysis.slice(0, 60)}`);
            return null;
        }
        await markAnalyzed(channelKey, messageId, analysis);
        await replaceImagePlaceholder(channelKey, messageId, analysis);
        return analysis;
    }
    catch (e) {
        console.warn('[image-analyzer] analysis failed:', getImageAnalyzerErrorMessage(e));
        return null;
    }
}
async function analyzeImageNow(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    const entry = await getImageEntry(channelKey, messageId);
    if (!entry)
        return null;
    if (entry.analyzed && entry.analysis)
        return entry.analysis;
    const key = imageTaskKey(channelKey, messageId);
    if (inFlight.has(key))
        return inFlight.get(key);
    const promise = runAnalysis({ channelKey, messageId, url: entry.url, file: entry.file });
    inFlight.set(key, promise);
    try {
        return await promise;
    }
    finally {
        if (inFlight.get(key) === promise)
            inFlight.delete(key);
    }
}
module.exports = {
    enqueueAnalysis,
    analyzeImageNow,
};
