"use strict";
/**
 * MODULE: Agent S2 worker 任务提交。
 * 职责: 将可序列化 Agent payload 提交到 S2 长期队列，供 agent-worker 异步执行。
 * 边界: 不调用 engine.run/resumePending，不获取 S0 锁，不发送最终消息。
 */
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client');
const { listResourceTasks } = require('../resource-workers/task-store');
// 按 channel 决定 S2 任务类型。
function resolveAgentTaskKind(channel = '', taskKind = '') {
    if (taskKind)
        return String(taskKind);
    return channel === 'dashboard' ? 'dashboard_agent' : 'agent_task';
}
// 统计同一用户已有的 pending/claiming/running Agent 任务，防止长期队列爆掉。
function countActiveAgentWorkerTasks(kind, channelKey, userId) {
    return listResourceTasks({ statuses: ['pending', 'claiming', 'running'], limit: 1000 })
        .filter(task => String(task.kind || '') === kind)
        .filter(task => String(task.channelKey || '') === String(channelKey || ''))
        .filter(task => String(task.userId || '') === String(userId || ''))
        .length;
}
// 返回用户可见的准入拒绝/延期提示。
function formatAdmissionBlockedMessage(admission, taskId = '') {
    const decision = String(admission?.decision || '');
    const reason = String(admission?.reason || decision || 'resource unavailable');
    if (decision === 'defer')
        return `当前资源紧张，Agent 任务已记录为延期任务${taskId ? `：${taskId}` : ''}。`;
    if (decision === 'reject' || decision === 'silent_drop')
        return `当前资源不足，Agent 暂时不能执行：${reason}`;
    return `Agent 任务暂时不能进入队列：${reason}`;
}
// 返回用户可见的提交成功提示。
function formatAcceptedMessage(task, admission) {
    const taskId = String(task?.id || '');
    const decision = String(admission?.decision || '');
    const prefix = decision === 'queue' ? 'Agent 已加入资源队列' : 'Agent 已提交后台执行';
    return `${prefix}，任务 ID：${taskId}。完成后会自动发回结果。`;
}
// 提交 Agent worker 任务：入口只落 S2 队列，真正执行交给 agent-worker。
function submitAgentWorkerTask(options) {
    const channel = String(options.channel || '');
    const kind = resolveAgentTaskKind(channel, options.taskKind || '');
    const channelKey = String(options.channelKey || '');
    const userId = String(options.userId || '');
    const maxActivePerUser = Math.max(1, Math.min(10, Number(options.maxActivePerUser || 1)));
    const activeCount = countActiveAgentWorkerTasks(kind, channelKey, userId);
    if (activeCount >= maxActivePerUser) {
        return {
            accepted: false,
            status: 429,
            message: 'Agent 已有任务在处理或排队，请等当前任务结束后再试。',
        };
    }
    const result = submitWorkerTaskWithAdmission({
        kind,
        source: String(options.source || 'koishi-worker'),
        channelKey,
        userId,
        priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : (kind === 'dashboard_agent' ? 45 : 40),
        timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 600000,
        payload: {
            channel,
            taskKind: kind,
            ...(options.payload || {}),
        },
        notify: {
            target: channel === 'dashboard' ? 'dashboard' : 'qq-group',
            channelKey,
            status: 'pending',
        },
    }, { checkAdmission: true, exclusive: true });
    if (!result.accepted) {
        return {
            accepted: false,
            task: result.task,
            admission: result.admission,
            taskId: result.task?.id,
            status: String(result.admission?.decision || '') === 'defer' ? 202 : 503,
            message: formatAdmissionBlockedMessage(result.admission, result.task?.id),
        };
    }
    return {
        accepted: true,
        task: result.task,
        admission: result.admission,
        taskId: result.task?.id,
        status: 202,
        message: formatAcceptedMessage(result.task, result.admission),
    };
}
module.exports = {
    submitAgentWorkerTask,
    countActiveAgentWorkerTasks,
};
