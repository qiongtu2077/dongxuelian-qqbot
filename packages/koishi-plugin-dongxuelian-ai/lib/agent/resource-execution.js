"use strict";
/**
 * MODULE: Agent 资源执行包装。
 * 职责: 在 Agent 真正执行前统一经过 S1 准入、S2 状态记录和 S0 独占锁。
 * 边界: 不实现 Agent 推理，不改变旧 Agent 队列的排队策略。
 */
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate } = require('../resource-gate/gate');
const { submitResourceTask, claimTaskById, markTaskRunning, failIsolatedClaimingTask, updateTaskStep, completeTask, failTask, deferTask, updateTaskNotifyStatus, } = require('../resource-workers/task-store');
const { sanitizeId } = require('../resource-common/files');
// 生成 Agent 资源任务 ID。
function createAgentResourceTaskId(kind, channelKey, userId) {
    return `${sanitizeId(kind)}-${Date.now()}-${sanitizeId(channelKey)}-${sanitizeId(userId)}-${Math.random().toString(36).slice(2, 8)}`;
}
// 将 S1 准入拒绝转换成旧队列能识别的错误。
function createAdmissionError(decision, reason) {
    const message = String(reason || '当前资源不足，Agent 暂时不能执行。');
    const error = new Error(message);
    error.code = decision === 'defer' ? 'RESOURCE_ADMISSION_DEFERRED' : 'RESOURCE_ADMISSION_REJECTED';
    return error;
}
// 包装 Agent 执行函数：进入 S1、S2、S0，完成后释放资源。
async function runAgentWithResourceGate(options) {
    const channel = String(options.channel || '');
    const kind = String(options.taskKind || (channel === 'dashboard' ? 'dashboard_agent' : 'agent_task'));
    const channelKey = String(options.channelKey || channel || 'unknown');
    const userId = String(options.userId || 'unknown');
    const taskId = createAgentResourceTaskId(kind, channelKey, userId);
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 600000;
    const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : (kind === 'dashboard_agent' ? 45 : 40);
    const budget = {
        taskId,
        kind,
        source: String(options.source || 'koishi-worker'),
        channelKey,
        userId,
        exclusive: true,
        priority,
        degradable: false,
        deferable: true,
        queueTimeoutMs: timeoutMs,
        runTimeoutMs: timeoutMs,
    };
    const admission = admitTask(budget);
    const submittedTask = submitResourceTask({
        id: taskId,
        kind,
        source: String(options.source || 'koishi-worker'),
        channelKey,
        userId,
        priority,
        timeoutMs,
        payload: { channel, taskKind: kind, ...(options.payload || {}) },
        notify: { target: channel === 'dashboard' ? 'dashboard' : 'qq-group', channelKey, status: 'pending' },
    });
    if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
        failTask(submittedTask, createAdmissionError(admission.decision, admission.reason), { reason: admission.reason || admission.decision });
        throw createAdmissionError(admission.decision, admission.reason);
    }
    if (admission.decision === 'defer') {
        deferTask(submittedTask, String(admission.reason || 'resource defer'));
        throw createAdmissionError(admission.decision, admission.reason);
    }
    const workerName = 'agent-inline-worker';
    // 领取使用提交后已规范化的身份，竞争失败不能让初始记录进入运行。
    const claimedTask = claimTaskById(submittedTask.id, workerName, submittedTask.kind);
    if (!claimedTask)
        throw new Error('resource task did not enter running');
    const task = markTaskRunning(claimedTask, workerName, 'waiting_lock');
    if (task.status !== 'running') {
        const error = new Error('resource task did not enter running');
        failIsolatedClaimingTask(task, error, { mode: 'agent', reason: 'task_did_not_enter_running' });
        throw error;
    }
    let gateHandle = null;
    try {
        gateHandle = await acquireResourceGate({
            ...budget,
            owner: workerName,
            step: options.step || 'thinking',
        });
        gateHandle.updateStep(options.step || 'thinking');
        updateTaskStep(task.id, task.kind, options.step || 'thinking');
        const result = await Promise.resolve().then(options.run);
        const doneTask = completeTask(task, { mode: 'agent', reason: 'completed' });
        updateTaskNotifyStatus(doneTask, 'skipped');
        return result;
    }
    catch (error) {
        failTask(task, error, { mode: 'agent', reason: error instanceof Error ? error.message : String(error || '') });
        throw error;
    }
    finally {
        if (gateHandle)
            gateHandle.release('agent-finally');
    }
}
module.exports = {
    runAgentWithResourceGate,
};
