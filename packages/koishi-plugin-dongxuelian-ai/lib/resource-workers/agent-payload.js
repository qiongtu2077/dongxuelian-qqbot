"use strict";
/**
 * MODULE: S2 Agent worker payload helpers.
 * Responsibility: build and validate serializable Agent payloads for standalone workers.
 * Boundary: no Agent execution, no queue state changes, no bot/session references.
 */
const RUN_INPUT_FIELDS = [
    'userMessage',
    'userName',
    'userId',
    'channelKey',
    'channel',
    'systemExtra',
    'history',
    'forceTools',
    'preExecuteTools',
    'enableThinking',
    'agentMode',
    'scheduledTask',
    'contextPolicy',
    'isAdmin',
];
const RESUME_INPUT_FIELDS = [
    'channelKey',
    'userId',
    'channel',
    'expectedId',
    'isAdmin',
];
// Convert arbitrary values to JSON-safe data and trim large fields for S2 task files.
function toJsonSafe(value, depth = 0) {
    if (value === null)
        return null;
    if (value === undefined)
        return undefined;
    const type = typeof value;
    if (type === 'string') {
        const text = String(value);
        return text.length > 20000 ? `${text.slice(0, 20000)}...[truncated]` : text;
    }
    if (type === 'number')
        return Number.isNaN(value) ? null : value;
    if (type === 'boolean')
        return value;
    if (type === 'bigint')
        return String(value);
    if (type === 'function' || type === 'symbol')
        return undefined;
    if (depth >= 8)
        return '[max-depth]';
    if (Array.isArray(value)) {
        return value.slice(0, 80).map(item => toJsonSafe(item, depth + 1)).filter(item => item !== undefined);
    }
    if (type !== 'object')
        return String(value);
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
        const safe = toJsonSafe(item, depth + 1);
        if (safe !== undefined)
            result[key] = safe;
    }
    return result;
}
// Pick an allow-list of fields from an engine input object.
function pickSerializableFields(input, fields) {
    const result = {};
    for (const field of fields) {
        const value = toJsonSafe(input[field]);
        if (value !== undefined)
            result[field] = value;
    }
    return result;
}
function recordOrNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function recordOrUndefined(value) {
    return recordOrNull(value) || undefined;
}
function stringArrayOrUndefined(value) {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;
}
// Build a worker payload for engine.run.
function createAgentRunWorkerPayload(entry, input = {}, warnings = []) {
    return {
        action: 'run',
        entry: String(entry || 'agent-run'),
        engineInput: pickSerializableFields(input, RUN_INPUT_FIELDS),
        warnings: warnings.map(String).filter(Boolean),
    };
}
// Build a worker payload for engine.resumePending.
function createAgentResumeWorkerPayload(entry, input = {}, pendingSnapshot = null, warnings = []) {
    return {
        action: 'resume_pending',
        entry: String(entry || 'agent-resume'),
        resumeInput: pickSerializableFields(input, RESUME_INPUT_FIELDS),
        pendingSnapshot: pendingSnapshot ? toJsonSafe(pendingSnapshot) : null,
        warnings: warnings.map(String).filter(Boolean),
    };
}
// Return the nested Agent worker payload from a S2 task.
function getAgentWorkerPayload(task) {
    const payload = recordOrNull(task?.payload) || {};
    const worker = recordOrNull(payload.agentWorker);
    if (!worker)
        return null;
    const action = String(worker.action || '');
    if (action !== 'run' && action !== 'resume_pending')
        return null;
    return {
        action,
        entry: String(worker.entry || 'agent-worker'),
        engineInput: recordOrUndefined(worker.engineInput),
        resumeInput: recordOrUndefined(worker.resumeInput),
        pendingSnapshot: recordOrNull(worker.pendingSnapshot),
        warnings: stringArrayOrUndefined(worker.warnings),
    };
}
// Validate whether a payload has enough data for standalone execution.
function getAgentWorkerPayloadStatus(task) {
    const payload = getAgentWorkerPayload(task);
    if (!payload)
        return { executable: false, reason: 'agent worker payload missing', payload: null };
    if (payload.action === 'run') {
        const input = payload.engineInput || {};
        if (!input.userMessage || !input.userId || !input.channelKey)
            return { executable: false, reason: 'agent run payload missing userMessage/userId/channelKey', payload };
        return { executable: true, reason: 'ok', payload };
    }
    const input = payload.resumeInput || {};
    if (!input.userId || !input.channelKey)
        return { executable: false, reason: 'agent resume payload missing userId/channelKey', payload };
    return { executable: true, reason: 'ok', payload };
}
module.exports = {
    createAgentRunWorkerPayload,
    createAgentResumeWorkerPayload,
    getAgentWorkerPayload,
    getAgentWorkerPayloadStatus,
    toJsonSafe,
};
