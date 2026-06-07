"use strict";
/**
 * MODULE: S2 agent-worker executor.
 * Responsibility: execute standalone Agent tasks from serializable S2 payloads.
 * Boundary: no QQ/Dashboard sending; result delivery is handled by result-notifier or polling.
 */
const { getAgentWorkerPayloadStatus } = require('./agent-payload');
const pendingStore = require('../agent/pending');
function resultLike(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
// Convert an Agent result into the compact S2 result.json shape.
function buildAgentWorkerResult(task, result, mode, warnings = []) {
    const record = resultLike(result);
    return {
        mode,
        reply: String(record.reply || record.message || ''),
        message: String(record.message || ''),
        error: String(record.error || ''),
        ok: record.ok !== false,
        pendingId: record.pendingId || null,
        toolCalls: Number(record.toolCalls || 0),
        toolResults: Array.isArray(record.toolResults) ? record.toolResults.slice(0, 20) : [],
        warnings,
        reason: `agent worker completed task ${String(task?.id || '')}`,
    };
}
// Execute one standalone Agent task when its serialized payload is complete.
async function runAgentWorkerTask(task) {
    const status = getAgentWorkerPayloadStatus(task);
    if (!status.executable || !status.payload) {
        return {
            defer: true,
            mode: 'agent_worker_payload_incomplete',
            reason: `${status.reason} for task ${String(task?.id || '')}`,
        };
    }
    const engine = require('../agent/engine');
    const payload = status.payload;
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(String) : [];
    if (payload.action === 'resume_pending') {
        if (payload.pendingSnapshot && typeof pendingStore.upsertPendingToolSnapshot === 'function') {
            pendingStore.upsertPendingToolSnapshot(payload.pendingSnapshot);
        }
        const result = await engine.resumePending({
            ...(payload.resumeInput || {}),
            bot: undefined,
            resourceTaskId: String(task?.id || ''),
        });
        return buildAgentWorkerResult(task, result, 'agent_resume_worker', warnings);
    }
    const result = await engine.run({
        ...(payload.engineInput || {}),
        bot: undefined,
        resourceTaskId: String(task?.id || ''),
    });
    return buildAgentWorkerResult(task, result, 'agent_worker', warnings);
}
module.exports = {
    runAgentWorkerTask,
};
