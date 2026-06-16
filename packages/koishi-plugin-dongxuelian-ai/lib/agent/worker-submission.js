"use strict";
/**
 * MODULE: Agent S2 worker 任务提交。
 * 职责: 将可序列化 Agent payload 提交到 S2 长期队列，供 agent-worker 异步执行。
 * 边界: 不调用 engine.run/resumePending，不获取 S0 锁，不发送最终消息。
 */
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client');
const { countResourceTasksByKind } = require('../resource-workers/task-store');
const MIN_AGENT_TASK_TIMEOUT_MS = 5000;
const MAX_AGENT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_AGENT_TASK_TIMEOUT_MS = 600000;
const DEFAULT_AGENT_ACTIVE_BACKLOG_MAX = Math.max(1, Math.min(200, Number(process.env.RESOURCE_AGENT_ACTIVE_BACKLOG_MAX
    || process.env.RESOURCE_DEFERRED_RESTORE_MAX_ACTIVE
    || process.env.DAILY_SLOT_BACKLOG_STOP_MAX_PENDING
    || 8)));
const AGENT_DEFERRED_EXPIRY_GRACE_MS = Math.max(30 * 1000, Math.min(5 * 60 * 1000, Number(process.env.RESOURCE_AGENT_DEFERRED_EXPIRY_GRACE_MS || 2 * 60 * 1000)));
function resolveAgentDirectiveAction(directive, admission) {
    const action = String(directive?.action || '');
    if (action)
        return action;
    const decision = String(admission?.decision || '');
    if (decision === 'run_now')
        return 'pass';
    return decision || 'reject';
}
// 按 channel 决定 S2 任务类型。
function resolveAgentTaskKind(channel = '', taskKind = '') {
    if (taskKind)
        return String(taskKind);
    return channel === 'dashboard' ? 'dashboard_agent' : 'agent_task';
}
function resolveAgentTaskTimeoutMs(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed))
        return DEFAULT_AGENT_TASK_TIMEOUT_MS;
    return Math.max(MIN_AGENT_TASK_TIMEOUT_MS, Math.min(MAX_AGENT_TASK_TIMEOUT_MS, parsed));
}
function getAgentTaskExpiryIso(timeoutMs) {
    const ttlMs = Math.max(MIN_AGENT_TASK_TIMEOUT_MS, timeoutMs + AGENT_DEFERRED_EXPIRY_GRACE_MS);
    return new Date(Date.now() + ttlMs).toISOString();
}
function resolveAgentActiveBacklogMax() {
    return DEFAULT_AGENT_ACTIVE_BACKLOG_MAX;
}
// 统计同一用户已有的 pending/claiming/running Agent 任务，防止长期队列爆掉。
function countActiveAgentWorkerTasks(kind, channelKey, userId, limit = 1) {
    return countResourceTasksByKind({
        kind,
        statuses: ['pending', 'claiming', 'running', 'deferred'],
        limit: Math.max(1, Math.min(10, Number(limit || 1))),
    }, task => String(task.channelKey || '') === String(channelKey || '') && String(task.userId || '') === String(userId || ''));
}
function countAgentWorkerTaskBacklog(kind, limit = DEFAULT_AGENT_ACTIVE_BACKLOG_MAX) {
    return countResourceTasksByKind({
        kind,
        statuses: ['pending', 'claiming', 'running', 'deferred'],
        limit: Math.max(1, Math.min(200, Number(limit || DEFAULT_AGENT_ACTIVE_BACKLOG_MAX))),
    });
}
// 返回用户可见的准入拒绝/延期提示。
function formatAdmissionBlockedMessage(directive, admission, taskId = '') {
    const action = resolveAgentDirectiveAction(directive, admission);
    const reason = String(directive?.reason || admission?.reason || action || 'resource unavailable');
    if (action === 'defer')
        return `当前资源紧张，Agent 任务已记录为延期任务${taskId ? `：${taskId}` : ''}。`;
    if (action === 'reject' || action === 'silent_drop' || action === 'downgrade')
        return `当前资源不足，Agent 暂时不能执行：${reason}`;
    return `Agent 任务暂时不能进入队列：${reason}`;
}
// 聊天口径：资源保护触发时不向前台暴露内部 taskId / defer 机制。
function formatNaturalBlockedMessage(directive, admission) {
    const action = resolveAgentDirectiveAction(directive, admission);
    if (action === 'defer')
        return '我先不乱查，等资源缓一缓再看。';
    if (action === 'reject' || action === 'silent_drop' || action === 'downgrade')
        return '这会儿不太适合继续查，我先按现有信息回答你。';
    return '我先不乱动工具，先按眼下能确定的说。';
}
// 返回用户可见的提交成功提示。
function formatAcceptedMessage(task, directiveOrAdmission, admissionOrMode, modeArg = 'normal') {
    const mode = admissionOrMode === 'quiet' || admissionOrMode === 'normal' || admissionOrMode === 'silent' ? admissionOrMode : modeArg;
    const directive = admissionOrMode === 'quiet' || admissionOrMode === 'normal' || admissionOrMode === 'silent'
        ? null
        : directiveOrAdmission;
    const admission = admissionOrMode === 'quiet' || admissionOrMode === 'normal' || admissionOrMode === 'silent'
        ? directiveOrAdmission
        : admissionOrMode;
    const taskId = String(task?.id || '');
    const action = resolveAgentDirectiveAction(directive, admission);
    const prefix = action === 'queue' ? 'Agent 已加入资源队列' : 'Agent 已提交后台执行';
    if (mode === 'silent')
        return '';
    if (mode === 'quiet')
        return `我先去后台查一下，拿到可靠结果再说。${taskId ? `任务 ID：${taskId}。` : ''}`;
    return `${prefix}，任务 ID：${taskId}。完成后会自动发回结果。`;
}
// 提交 Agent worker 任务：入口只落 S2 队列，真正执行交给 agent-worker。
function submitAgentWorkerTask(options) {
    const channel = String(options.channel || '');
    const kind = resolveAgentTaskKind(channel, options.taskKind || '');
    const channelKey = String(options.channelKey || '');
    const userId = String(options.userId || '');
    const notifyTarget = options.notifyTarget || (channel === 'dashboard' ? 'dashboard' : 'qq-group');
    const acceptedMessageMode = options.acceptedMessageMode === 'silent'
        ? 'silent'
        : options.acceptedMessageMode === 'quiet'
            ? 'quiet'
            : 'normal';
    const blockedMessageMode = options.blockedMessageMode === 'natural' ? 'natural' : 'system';
    const maxActivePerUser = Math.max(1, Math.min(10, Number(options.maxActivePerUser || 1)));
    const timeoutMs = resolveAgentTaskTimeoutMs(options.timeoutMs);
    const activeCount = countActiveAgentWorkerTasks(kind, channelKey, userId, maxActivePerUser);
    if (activeCount >= maxActivePerUser) {
        return {
            accepted: false,
            status: 429,
            message: 'Agent 已有任务在处理或排队，请等当前任务结束后再试。',
        };
    }
    const maxBacklog = resolveAgentActiveBacklogMax();
    const activeBacklog = countAgentWorkerTaskBacklog(kind, maxBacklog);
    if (activeBacklog >= maxBacklog) {
        return {
            accepted: false,
            status: 429,
            message: '当前 Agent 后台队列已满，请稍后再试。',
        };
    }
    const result = submitWorkerTaskWithAdmission({
        kind,
        source: String(options.source || 'koishi-worker'),
        channelKey,
        userId,
        priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : (kind === 'dashboard_agent' ? 45 : 40),
        timeoutMs,
        expiresAt: getAgentTaskExpiryIso(timeoutMs),
        payload: {
            channel,
            taskKind: kind,
            ...(options.payload || {}),
        },
        notify: {
            target: notifyTarget,
            channelKey,
            status: 'pending',
        },
    }, { checkAdmission: true, exclusive: true });
    if (!result.accepted) {
        const action = resolveAgentDirectiveAction(result.directive, result.admission);
        return {
            accepted: action === 'pass' || action === 'queue',
            task: result.task,
            admission: result.admission,
            taskId: result.task?.id,
            status: action === 'defer' ? 202 : 503,
            message: blockedMessageMode === 'natural'
                ? formatNaturalBlockedMessage(result.directive, result.admission)
                : formatAdmissionBlockedMessage(result.directive, result.admission, result.task?.id),
        };
    }
    const action = resolveAgentDirectiveAction(result.directive, result.admission);
    return {
        accepted: action === 'pass' || action === 'queue',
        task: result.task,
        admission: result.admission,
        taskId: result.task?.id,
        status: 202,
        message: formatAcceptedMessage(result.task, result.directive, result.admission, acceptedMessageMode),
    };
}
module.exports = {
    submitAgentWorkerTask,
    countActiveAgentWorkerTasks,
    formatAcceptedMessage,
    formatNaturalBlockedMessage,
};
