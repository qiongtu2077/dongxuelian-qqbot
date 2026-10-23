"use strict";
/**
 * MODULE: 按需图片识别所有权。
 * 职责: 在聊天和媒体工作进程间合并相同图片的识别，复用摘要及等价细节结果。
 * 边界: 不下载图片、不调用模型、不发送消息；记录只在原图片有效期内保留。
 * 状态: 原子文件锁及每张图片最多八个问题结果，不保存原始提问。
 */
const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { DATA_DIR } = require('../../core/constants');
const { readJsonFile, writeJsonAtomic, isProcessAlive } = require('../../resource-common/files');
const { getImageEntry, finishImageAnalysisStatus } = require('./image-store');
const { recordImageRequestEvent } = require('../../core/request-diagnostics');
const REQUEST_ROOT = path.join(DATA_DIR, 'image-analysis-requests');
const IMAGE_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_RESULTS = 8;
// --- 请求身份与持久结果 --- //
// 哈希图片身份，避免文件名碰撞或把用户输入拼进路径。
function imageRequestHash(value) { return createHash('sha256').update(value).digest('hex'); }
// 把提问与强制原图区分为等价需求，不用关键词推断自然语言意图。
function imageQuestionKey(options) {
    return imageRequestHash(JSON.stringify([!!options.force, String(options.question || '').trim()]));
}
// 只读取对应有效图片、同一问题的细节结果；摘要由图片存储统一管理。
function readQuestionResult(file, key) {
    const results = readJsonFile(file, null, 128 * 1024);
    if (!results || results.expiresAt <= Date.now())
        return null;
    const value = results.values?.[key];
    return typeof value?.analysis === 'string' && value.analysis ? value.analysis : null;
}
// 释放时只删除自己持有的锁，防止取消与完成竞态误删别人的所有权。
async function releaseImageOwner(lockFile, token) {
    const owner = readJsonFile(lockFile);
    if (owner?.token === token)
        await fs.unlink(lockFile).catch(() => { });
}
// --- 跨进程识别协调 --- //
// 为队列状态结算读取实际持有者，不把等待超时误当成识图已结束。
function hasActiveImageRequest(channelKey, messageId) {
    const target = imageRequestHash(JSON.stringify([channelKey, messageId]));
    const owner = readJsonFile(path.join(REQUEST_ROOT, imageRequestHash(channelKey), target + '.lock'));
    return !!owner && owner.channelKey === channelKey && owner.messageId === messageId && isProcessAlive(owner.pid);
}
// 领取目标图片的识别权；等待有界，只有持有者能发起新模型请求。
async function acquireImageRequest(channelKey, messageId, options) {
    if (!channelKey || !messageId || !['explicit-image', 'random-image', 'history-tool'].includes(options.source))
        return { status: 'unavailable' };
    const target = imageRequestHash(JSON.stringify([channelKey, messageId]));
    const dir = path.join(REQUEST_ROOT, imageRequestHash(channelKey));
    const lockFile = path.join(dir, target + '.lock');
    const resultFile = path.join(dir, target + '.json');
    const key = imageQuestionKey(options);
    const diagnostic = { source: options.source, target, demandId: randomUUID() };
    recordImageRequestEvent({ ...diagnostic, event: 'requested', force: !!options.force });
    await fs.mkdir(dir, { recursive: true });
    const deadline = Date.now() + Math.max(0, Math.min(30000, options.waitMs ?? 20000));
    while (true) {
        const entry = await getImageEntry(channelKey, messageId);
        if (!entry) {
            recordImageRequestEvent({ ...diagnostic, event: 'unavailable' });
            return { status: 'unavailable' };
        }
        const cached = readQuestionResult(resultFile, key) || (!options.force && entry.analyzed && entry.analysis);
        if (cached) {
            recordImageRequestEvent({ ...diagnostic, event: 'reused', cache: options.force ? 'detail' : 'summary' });
            return { status: 'reused', diagnostic, analysis: cached };
        }
        const token = randomUUID();
        const candidate = `${lockFile}.${token}.tmp`;
        await fs.writeFile(candidate, JSON.stringify({ token, pid: process.pid, channelKey, messageId, createdAt: Date.now() }), { flag: 'wx' });
        try {
            await fs.link(candidate, lockFile);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const owner = readJsonFile(lockFile);
            // 活进程的请求绝不因等待超时而被偷走；死进程锁可安全恢复。
            if (owner && !isProcessAlive(owner.pid))
                await releaseImageOwner(lockFile, owner.token);
            if (Date.now() >= deadline) {
                recordImageRequestEvent({ ...diagnostic, event: 'pending' });
                return { status: 'pending' };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }
        finally {
            await fs.unlink(candidate).catch(() => { });
        }
        // 竞争者可能在最后一次缓存检查后完成；持锁后再次检查，避免顺序重复消费。
        let fresh;
        try {
            fresh = await getImageEntry(channelKey, messageId);
        }
        catch (error) {
            // 所有权尚未交给调用方，复检失败必须由领取端释放，不能留下活进程锁。
            await releaseImageOwner(lockFile, token);
            recordImageRequestEvent({ ...diagnostic, event: 'failed' });
            throw error;
        }
        const ready = readQuestionResult(resultFile, key) || (!options.force && fresh?.analyzed && fresh.analysis);
        if (!fresh || ready) {
            await releaseImageOwner(lockFile, token);
            if (ready) {
                recordImageRequestEvent({ ...diagnostic, event: 'reused', cache: options.force ? 'detail' : 'summary' });
                return { status: 'reused', diagnostic, analysis: ready };
            }
            recordImageRequestEvent({ ...diagnostic, event: 'unavailable' });
            return { status: 'unavailable' };
        }
        let finished = false;
        let released = false;
        recordImageRequestEvent({ ...diagnostic, event: 'owned' });
        return {
            status: 'owned', diagnostic,
            // 保存有界问题结果；摘要和会话回写仍由调用者负责。
            async complete(analysis) {
                if (finished)
                    return;
                const valid = await getImageEntry(channelKey, messageId);
                if (!valid)
                    return;
                const result = String(analysis || '').trim().slice(0, 8000);
                if (!result)
                    return;
                const previous = readJsonFile(resultFile, null, 128 * 1024);
                const values = previous && previous.expiresAt > Date.now() ? previous.values : {};
                values[key] = { analysis: result, createdAt: Date.now() };
                const ordered = Object.entries(values).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, MAX_RESULTS);
                writeJsonAtomic(resultFile, { channelKey, messageId, expiresAt: valid.ts + IMAGE_WINDOW_MS, values: Object.fromEntries(ordered) });
                finished = true;
                recordImageRequestEvent({ ...diagnostic, event: 'completed' });
            },
            // 无论成功、异常、超时还是取消，都归还当前图片的模型执行权。
            async release() {
                if (released)
                    return;
                const completed = finished;
                if (!finished)
                    recordImageRequestEvent({ ...diagnostic, event: 'failed' });
                finished = true;
                await releaseImageOwner(lockFile, token);
                released = true;
                // 队列模块不依赖请求持有者；延迟读取避免加载阶段扩大模块依赖。
                const { hasImageAnalysisDemand } = require('../backpressure/media-queue');
                await finishImageAnalysisStatus(channelKey, messageId, completed ? 'completed' : 'failed', () => !hasImageAnalysisDemand(channelKey, messageId) && !hasActiveImageRequest(channelKey, messageId));
            },
        };
    }
}
// 清理已淘汰图片的问题结果与失效锁，由现有启动维护调度调用。
async function cleanupImageRequests() {
    const channels = await fs.readdir(REQUEST_ROOT, { withFileTypes: true }).catch(() => []);
    for (const channel of channels) {
        if (!channel.isDirectory())
            continue;
        const dir = path.join(REQUEST_ROOT, channel.name);
        const names = await fs.readdir(dir);
        for (const name of names) {
            const file = path.join(dir, name);
            if (name.endsWith('.lock')) {
                const owner = readJsonFile(file);
                if (owner && !isProcessAlive(owner.pid))
                    await releaseImageOwner(file, owner.token);
            }
            else if (name.endsWith('.json')) {
                const result = readJsonFile(file, null, 128 * 1024);
                if (!result || result.expiresAt <= Date.now() || !await getImageEntry(result.channelKey, result.messageId))
                    await fs.unlink(file).catch(() => { });
            }
            else if (name.endsWith('.tmp')) {
                const candidate = readJsonFile(file);
                if (candidate && !isProcessAlive(candidate.pid))
                    await fs.unlink(file).catch(() => { });
            }
        }
        // 频道目录也是并发申请的工作空间；保留空目录，避免删掉已 mkdir、尚在等记录的申请路径。
    }
}
module.exports = { acquireImageRequest, cleanupImageRequests, hasActiveImageRequest };
