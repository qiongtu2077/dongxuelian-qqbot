"use strict";
/**
 * MODULE: 后台 LLM 任务提交器。
 * 职责: 为 Koishi 主进程提交表达抽象、对话摘要、敏感缓存分析任务。
 * 边界: 不调用模型，不执行后台 LLM，只写 S2 任务。
 */
const { submitWorkerTaskWithAdmission } = require('./task-client');
const { listResourceTasks } = require('./task-store');
// 返回后台 LLM 任务过期时间，避免 hidden pending 无限堆积。
function getBackgroundExpiryIso(ttlMs) {
    return new Date(Date.now() + Math.max(1000, Number(ttlMs) || 1000)).toISOString();
}
// 统计同类活跃后台 LLM 任务，防止定时器重复提交刷爆队列。
function countActiveBackgroundTasks(kind, matcher) {
    return listResourceTasks({ statuses: ['pending', 'claiming', 'running', 'deferred'], limit: 1000 })
        .filter(task => String(task.kind || '') === kind)
        .filter(matcher)
        .length;
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
// 提交表达学习抽象任务；真正模型调用由 background-llm-worker 执行。
function submitExpressionHarvestTask(options = {}) {
    const channels = Array.isArray(options.channels) ? options.channels.map(String).filter(Boolean).slice(0, 200) : [];
    const dedupeKey = channels.length ? channels.sort().join(',') : 'all';
    if (countActiveBackgroundTasks('expression_harvest', task => String(task.payload?.dedupeKey || 'all') === dedupeKey) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active expression_harvest task already exists' };
    }
    const result = submitWorkerTaskWithAdmission({
        kind: 'expression_harvest',
        source: String(options.source || 'expression-harvest-scheduler'),
        channelKey: 'global',
        userId: '',
        priority: 97,
        timeoutMs: 180000,
        expiresAt: getBackgroundExpiryIso(24 * 60 * 60 * 1000),
        payload: {
            dedupeKey,
            channels,
            selfUserId: String(options.selfUserId || ''),
            botName: String(options.botName || ''),
        },
        notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: true });
    return normalizeBackgroundSubmission(result, 'expression_harvest');
}
// 提交对话摘要任务；主进程不再同步调用轻量模型。
function submitConversationSummaryTask(options) {
    const key = String(options.key || '');
    if (!key)
        return { accepted: false, status: 'invalid', message: 'conversation key is empty' };
    if (countActiveBackgroundTasks('conversation_summary', task => String(task.payload?.key || '') === key) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active conversation_summary task already exists' };
    }
    const result = submitWorkerTaskWithAdmission({
        kind: 'conversation_summary',
        source: String(options.source || 'conversation-summary'),
        channelKey: key.split('::')[0] || 'conversation',
        userId: key.split('::')[1] || '',
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
    if (countActiveBackgroundTasks('sensitive_cache_analysis', task => String(task.channelKey || task.payload?.channelKey || '') === channelKey) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active sensitive_cache_analysis task already exists' };
    }
    const result = submitWorkerTaskWithAdmission({
        kind: 'sensitive_cache_analysis',
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
    submitExpressionHarvestTask,
    submitConversationSummaryTask,
    submitSensitiveCacheAnalysisTask,
};
