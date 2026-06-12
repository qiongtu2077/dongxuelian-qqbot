"use strict";
/**
 * MODULE: S2 media-worker 执行器。
 * 职责: 从 S6 背压队列领取媒体任务，并调用现有图片/文件分析器写缓存。
 * 边界: 不发送消息，不绕过 S1/S0。
 */
const { admitTask } = require('../resource-scheduler/admission');
const { RESOURCE_TASK_KIND, isImageMediaTaskKind, isFileMediaTaskKind, isVoiceMediaTaskKind, } = require('../resource-common/resource-task-kinds');
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive');
const { acquireResourceGate } = require('../resource-gate/gate');
const { writeProcessCleanupEvent } = require('../resource-system/system-protection');
const { analyzeImageNow } = require('../media/image/image-analyzer');
const { analyzeFileNow } = require('../media/file/file-analyzer');
const { transcribeVoice } = require('../media/voice/voice');
const { loadConfig } = require('../core/runtime-config');
const { markVoiceTranscribed, markVoiceTranscriptionUnavailable, } = require('../media/voice/voice-store');
const { claimNextMediaTask, requeueMediaTask, completeMediaTask, failMediaTask, } = require('../media/backpressure/media-queue');
const MEDIA_TASK_TIMEOUT_MS = Math.max(10000, Math.min(10 * 60 * 1000, Number(process.env.RESOURCE_MEDIA_TASK_TIMEOUT_MS || 180000)));
// 判断媒体任务类型是否为图片分析。
function isImageMediaTask(task) {
    return isImageMediaTaskKind(task?.kind);
}
// 判断媒体任务类型是否为文件分析。
function isFileMediaTask(task) {
    return isFileMediaTaskKind(task?.kind);
}
// 判断媒体任务类型是否为语音转写。
function isVoiceMediaTask(task) {
    return isVoiceMediaTaskKind(task?.kind);
}
// 从语音任务 payload 中提取可用 URL。
function getVoiceTaskUrl(task) {
    return String(task?.payload?.url || task?.url || '');
}
// 从语音任务 payload 中提取 OneBot record file 标识。
function getVoiceTaskFile(task) {
    return String(task?.payload?.file || task?.fileId || '');
}
// 为 transcribeVoice 构造最小 session，避免 media-worker 依赖 Koishi 主进程上下文。
function buildVoiceTranscriptionSession(task) {
    const url = getVoiceTaskUrl(task);
    const file = getVoiceTaskFile(task);
    return {
        messageId: task?.messageId || task?.id || '',
        content: file ? `[CQ:record,file=${file}]` : '',
        event: {
            message: [
                {
                    type: 'record',
                    data: { url, file },
                },
            ],
        },
    };
}
// 执行语音 ASR 并写回 voice-store。
async function runVoiceTranscriptionTask(task) {
    const channelKey = String(task?.channelKey || '');
    const messageId = String(task?.messageId || '');
    if (!channelKey || !messageId)
        throw new Error('voice transcription task missing channelKey or messageId');
    try {
        const cfg = await loadConfig();
        const transcript = await transcribeVoice(buildVoiceTranscriptionSession(task), { ...cfg });
        if (transcript) {
            await markVoiceTranscribed(channelKey, messageId, transcript);
            return { mode: 'voice', transcript, ok: true };
        }
        await markVoiceTranscriptionUnavailable(channelKey, messageId, 'empty');
        return { mode: 'voice', transcript: '', ok: false };
    }
    catch (error) {
        await markVoiceTranscriptionUnavailable(channelKey, messageId, 'failed');
        throw error;
    }
}
// 执行已领取的媒体任务，并返回分析结果摘要。
async function runClaimedMediaTask(task) {
    if (isImageMediaTask(task)) {
        const analysis = await analyzeImageNow(String(task.channelKey || ''), String(task.messageId || ''));
        return { mode: 'image', analysis: analysis || '', ok: !!analysis };
    }
    if (isFileMediaTask(task)) {
        const analysis = await analyzeFileNow(String(task.channelKey || ''), String(task.messageId || ''));
        return { mode: 'file', analysis: analysis || '', ok: !!analysis };
    }
    if (isVoiceMediaTask(task))
        return runVoiceTranscriptionTask(task);
    throw new Error(`unsupported media task kind: ${String(task?.kind || '')}`);
}
// 给媒体分析加 S8 超时兜底；超时后 media-worker 退出，由 supervisor 拉起新进程。
async function runClaimedMediaTaskWithTimeout(task) {
    let timer = null;
    try {
        return await Promise.race([
            runClaimedMediaTask(task),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`media worker task timed out after ${MEDIA_TASK_TIMEOUT_MS}ms`));
                }, MEDIA_TASK_TIMEOUT_MS);
                if (timer.unref)
                    timer.unref();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
// 记录媒体任务超时，并让当前 worker 自退，避免卡住的下载/解析继续污染进程。
function handleMediaTaskTimeout(workerName, task, error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (!/media worker task timed out/i.test(message))
        return;
    writeProcessCleanupEvent({
        event: 'media_task_timed_out',
        workerName,
        taskId: task?.id || '',
        kind: task?.kind || '',
        timeoutMs: MEDIA_TASK_TIMEOUT_MS,
        error: message,
    });
    process.exitCode = process.exitCode || 76;
}
// 领取并执行一个 S6 媒体任务；没有任务或本轮被资源拒绝时返回 false，让主循环走 pollMs 退避。
async function drainOneMediaTask(options = {}) {
    const workerName = String(options.workerName || 'media-worker');
    const gate = decideBackgroundDirective({
        kind: RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS,
        source: workerName,
        channelKey: 'media',
        userId: '',
        priority: 60,
        exclusive: false,
        timeoutMs: MEDIA_TASK_TIMEOUT_MS,
        queueTimeoutMs: MEDIA_TASK_TIMEOUT_MS,
        runTimeoutMs: MEDIA_TASK_TIMEOUT_MS,
    });
    if (gate.directive.action === 'park')
        return false;
    const task = claimNextMediaTask(workerName);
    if (!task)
        return false;
    const admission = admitTask({
        taskId: task.id,
        kind: task.kind,
        source: workerName,
        channelKey: task.channelKey,
        userId: String(task.payload?.userId || ''),
        exclusive: false,
    });
    if (admission.decision !== 'run_now') {
        // 止血：资源不足时 requeue 后返回 false，避免 worked=true 触发 200ms claim/requeue 忙等。
        // 返回 false 让 runWorkerLoop 走 pollMs（默认 2s）退避，形成真背压而非忙等。
        requeueMediaTask(task, String(admission.reason || admission.decision));
        return false;
    }
    let gateHandle = null;
    try {
        gateHandle = await acquireResourceGate({
            taskId: task.id,
            kind: task.kind,
            owner: workerName,
            channelKey: task.channelKey,
            userId: String(task.payload?.userId || ''),
            priority: task.priority,
            timeoutMs: 180000,
            waitTimeoutMs: Number.isFinite(Number(options.gateWaitMs)) ? Number(options.gateWaitMs) : 15000,
            step: 'analyzing_media',
        });
        gateHandle.updateStep('analyzing_media');
        const result = await runClaimedMediaTaskWithTimeout(task);
        completeMediaTask(task, result);
        return true;
    }
    catch (error) {
        if (!gateHandle) {
            // 锁等待失败也属于资源繁忙，requeue 后返回 false 退避，不立刻重抢。
            requeueMediaTask(task, error instanceof Error ? error.message : String(error || 'lock_wait_failed'));
            return false;
        }
        failMediaTask(task, error, 'media_worker_failed');
        handleMediaTaskTimeout(workerName, task, error);
        return true;
    }
    finally {
        if (gateHandle)
            gateHandle.release('media-worker-finally');
    }
}
module.exports = {
    drainOneMediaTask,
    runClaimedMediaTask,
    runClaimedMediaTaskWithTimeout,
    runVoiceTranscriptionTask,
};
