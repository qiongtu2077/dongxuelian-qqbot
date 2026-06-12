"use strict";
/**
 * MODULE: S2 任务客户端。
 * 职责: 为 Koishi/Dashboard 提供统一的资源任务提交入口。
 * 边界: 不执行任务，不获取 S0 锁。
 */
const { admitTaskDirective } = require('../resource-scheduler/resource-directive');
const { submitResourceTask, deferTask, failTask, createTaskId, getResourceTaskByIdForKind } = require('./task-store');
function getExistingExplicitTask(input) {
    const explicitTaskId = String(input.id || '');
    const kind = String(input.kind || '');
    if (!explicitTaskId)
        return null;
    if (!kind)
        return null;
    const existing = getResourceTaskByIdForKind(explicitTaskId, kind);
    if (!existing)
        return null;
    return existing;
}
function buildExistingTaskResult(task) {
    const status = String(task.status || '');
    if (status === 'deferred') {
        return {
            task,
            admission: { decision: 'defer', reason: 'existing explicit task already deferred' },
            directive: { action: 'defer', reason: 'existing explicit task already deferred' },
            accepted: false,
        };
    }
    if (status === 'failed' || status === 'cancelled') {
        return {
            task,
            admission: { decision: 'reject', reason: `existing explicit task already ${status}` },
            directive: { action: 'reject', reason: `existing explicit task already ${status}` },
            accepted: false,
        };
    }
    return {
        task,
        admission: { decision: 'run_now', reason: 'existing explicit task reused' },
        directive: { action: 'pass', reason: 'existing explicit task reused' },
        accepted: true,
    };
}
// 构造 S1 准入预算；具体默认阈值由 S1 normalizeTaskBudget 处理。
function buildAdmissionInput(taskId, input, options = {}) {
    return {
        taskId,
        kind: input.kind,
        source: input.source || 'task-client',
        channelKey: input.channelKey || '',
        userId: input.userId || '',
        priority: input.priority,
        exclusive: options.exclusive,
        queueTimeoutMs: input.timeoutMs,
        runTimeoutMs: input.timeoutMs,
    };
}
// 只提交 S2 pending 任务，适合入口已完成 S1 判断的调用方。
function submitWorkerTask(input) {
    const existing = getExistingExplicitTask(input);
    if (existing)
        return existing;
    const taskId = input.id || createTaskId(input.kind, input.channelKey || '');
    return submitResourceTask({ ...input, id: taskId });
}
// 提交任务前顺便问 S1；非 run/queue 时仍落盘为 deferred/failed，方便 Dashboard 追踪。
function submitWorkerTaskWithAdmission(input, options = {}) {
    const existing = getExistingExplicitTask(input);
    if (existing)
        return buildExistingTaskResult(existing);
    const taskId = input.id || createTaskId(input.kind, input.channelKey || '');
    const skippedAdmission = { decision: 'run_now', reason: 'admission skipped by caller' };
    const skippedDirective = { action: 'pass', reason: 'admission skipped by caller' };
    const resourceDecision = options.checkAdmission === false
        ? { admission: skippedAdmission, directive: skippedDirective }
        : admitTaskDirective(buildAdmissionInput(taskId, input, options));
    const admission = resourceDecision.admission;
    const directive = resourceDecision.directive;
    const task = submitResourceTask({ ...input, id: taskId });
    if (admission.decision === 'defer') {
        return { task: deferTask(task, String(admission.reason || 'resource defer')), admission, directive, accepted: false };
    }
    if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
        return { task: failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision }), admission, directive, accepted: false };
    }
    return { task, admission, directive, accepted: true };
}
module.exports = {
    submitWorkerTask,
    submitWorkerTaskWithAdmission,
    buildAdmissionInput,
};
