"use strict";
/**
 * MODULE: TTS 资源门控。
 * 职责: 让短交互 TTS 在调用外部合成 API 前统一经过 S1 准入和 S0 独占锁。
 * 边界: 不执行 TTS 业务本身，不发送语音，不写 S2 长期队列。
 */
const { admitTask } = require('../../resource-scheduler/admission');
const { acquireResourceGate } = require('../../resource-gate/gate');
const { sanitizeId } = require('../../resource-common/files');
const VOICE_TTS_TASK_KIND = 'voice_tts_generation';
// 为一次短交互 TTS 生成可追踪 taskId，便于 S0/S1 事件定位来源。
function buildVoiceTtsTaskId(input) {
    const context = sanitizeId(input.context || 'tts');
    const channel = sanitizeId(input.channelKey || 'global');
    return `${VOICE_TTS_TASK_KIND}-${context}-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// 把非放行的 S1 决策转成调用方可直接展示或回退的结果。
function buildRejectedTtsResult(decision) {
    return {
        ok: false,
        decision: String(decision?.decision || 'reject'),
        reason: String(decision?.reason || 'voice tts resource gate rejected'),
        resourceState: decision?.resourceState,
        botMode: decision?.botMode,
    };
}
// 在 S1/S0 保护下运行一次短交互 TTS；资源不可用时不等待长期排队。
async function runVoiceTtsWithResourceGate(options) {
    const taskId = sanitizeId(options.taskId || buildVoiceTtsTaskId(options));
    const source = String(options.source || 'voice-tts');
    const owner = String(options.owner || source);
    const channelKey = String(options.channelKey || '');
    const userId = String(options.userId || '');
    const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 65;
    const waitTimeoutMs = Math.max(500, Math.min(30000, Number(options.waitTimeoutMs || 5000)));
    const runTimeoutMs = Math.max(1000, Math.min(120000, Number(options.runTimeoutMs || 60000)));
    const admission = admitTask({
        taskId,
        kind: VOICE_TTS_TASK_KIND,
        source,
        channelKey,
        userId,
        exclusive: true,
        priority,
        deferable: false,
        queueTimeoutMs: waitTimeoutMs,
        runTimeoutMs,
    });
    if (admission.decision !== 'run_now')
        return buildRejectedTtsResult(admission);
    let gateHandle = null;
    try {
        gateHandle = await acquireResourceGate({
            taskId,
            kind: VOICE_TTS_TASK_KIND,
            owner,
            channelKey,
            userId,
            priority,
            timeoutMs: runTimeoutMs,
            waitTimeoutMs,
            pollMs: 500,
            memAvailableMb: admission.memAvailableMb,
            step: 'tts_prepare',
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'unknown error');
        try {
            options.logger?.warn(`voice tts gate rejected: ${message}`);
        }
        catch { /* non-critical: logging failure must not break fallback */ }
        return {
            ok: false,
            decision: 'queue',
            reason: message,
            resourceState: admission.resourceState,
            botMode: admission.botMode,
        };
    }
    try {
        gateHandle.updateStep('tts_synthesizing', admission.memAvailableMb);
        const value = await options.run();
        return {
            ok: true,
            value,
            decision: 'run_now',
            reason: 'voice tts completed',
            resourceState: admission.resourceState,
            botMode: admission.botMode,
        };
    }
    finally {
        gateHandle.release('voice-tts-finally');
    }
}
module.exports = {
    VOICE_TTS_TASK_KIND,
    buildVoiceTtsTaskId,
    runVoiceTtsWithResourceGate,
};
