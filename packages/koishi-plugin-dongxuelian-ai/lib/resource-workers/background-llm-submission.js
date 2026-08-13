"use strict";
/**
 * MODULE: 后台 LLM 任务提交器。
 * 职责: 为 Koishi 主进程提交对话摘要、敏感缓存分析任务。
 * 边界: 不调用模型，不执行后台 LLM，只写 S2 任务。
 */
const { submitWorkerTaskWithAdmission } = require('./task-client');
const { countResourceTasksByKind } = require('./task-store');
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds');
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive');
// 返回后台 LLM 任务过期时间，避免 hidden pending 无限堆积。
function getBackgroundExpiryIso(ttlMs) {
    return new Date(Date.now() + Math.max(1000, Number(ttlMs) || 1000)).toISOString();
}
// 统计同类活跃后台 LLM 任务，防止定时器重复提交刷爆队列。
function countActiveBackgroundTasks(kind, matcher, limit = 1) {
    return countResourceTasksByKind({
        kind,
        statuses: ['pending', 'claiming', 'running', 'deferred'],
        limit: Math.max(1, Math.min(10, Number(limit || 1))),
    }, task => matcher(task));
}
// 将 task-client 返回值压成调用方可记录的轻量结果。
function normalizeBackgroundSubmission(result, kind) {
    const decision = String(result.admission?.decision || '');
    const accepted = !!result.accepted || decision === 'queue' || decision === 'defer';
    return {
        accepted,
        task: result.task,
        admission: result.admission,
        taskId: result.task?.id,
        status: accepted ? (decision || 'accepted') : 'rejected',
        message: `${kind} task ${accepted ? 'submitted' : 'rejected'}${result.task?.id ? `: ${result.task.id}` : ''}`,
    };
}
function getParkedBackgroundSubmission(input) {
    const gate = decideBackgroundDirective({
        kind: input.kind,
        source: input.source,
        channelKey: input.channelKey,
        userId: input.userId,
        priority: input.priority,
        exclusive: true,
        timeoutMs: input.timeoutMs,
        queueTimeoutMs: input.timeoutMs,
        runTimeoutMs: input.timeoutMs,
    });
    if (gate.directive.action !== 'park')
        return null;
    return {
        accepted: false,
        status: 'parked',
        message: `${input.kind} task parked: ${gate.directive.reason}`,
    };
}
// 提交对话摘要任务；主进程不再同步调用轻量模型。
function submitConversationSummaryTask(options) {
    const key = String(options.key || '');
    if (!key)
        return { accepted: false, status: 'invalid', message: 'conversation key is empty' };
    if (countActiveBackgroundTasks('conversation_summary', task => String(task.payload?.key || '') === key, 1) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active conversation_summary task already exists' };
    }
    const channelKey = key.split('::')[0] || 'conversation';
    const userId = key.split('::')[1] || '';
    const parked = getParkedBackgroundSubmission({
        kind: RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
        source: String(options.source || 'conversation-summary'),
        channelKey,
        userId,
        priority: 98,
        timeoutMs: 120000,
    });
    if (parked)
        return parked;
    const result = submitWorkerTaskWithAdmission({
        kind: RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
        source: String(options.source || 'conversation-summary'),
        channelKey,
        userId,
        priority: 98,
        timeoutMs: 120000,
        expiresAt: getBackgroundExpiryIso(60 * 60 * 1000),
        payload: { key },
        notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: true });
    return normalizeBackgroundSubmission(result, 'conversation_summary');
}
// 提交敏感缓存分析任务；worker 命中后写持久 alert 文件供主进程消费。
function submitSensitiveCacheAnalysisTask(options) {
    const channelKey = String(options.channelKey || '');
    if (!channelKey)
        return { accepted: false, status: 'invalid', message: 'channelKey is empty' };
    if (countActiveBackgroundTasks('sensitive_cache_analysis', task => String(task.channelKey || task.payload?.channelKey || '') === channelKey, 1) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active sensitive_cache_analysis task already exists' };
    }
    const parked = getParkedBackgroundSubmission({
        kind: RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
        source: String(options.source || 'sensitive-cache-analysis'),
        channelKey,
        userId: '',
        priority: 60,
        timeoutMs: 120000,
    });
    if (parked)
        return parked;
    const result = submitWorkerTaskWithAdmission({
        kind: RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
        source: String(options.source || 'sensitive-cache-analysis'),
        channelKey,
        userId: '',
        priority: 60,
        timeoutMs: 120000,
        expiresAt: getBackgroundExpiryIso(2 * 60 * 60 * 1000),
        payload: { channelKey },
        notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: true });
    return normalizeBackgroundSubmission(result, 'sensitive_cache_analysis');
}
module.exports = {
    submitConversationSummaryTask,
    submitSensitiveCacheAnalysisTask,
};
