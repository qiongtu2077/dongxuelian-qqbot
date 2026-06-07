"use strict";
/**
 * MODULE: S1 资源准入决策。
 * 职责: 根据任务预算和资源快照输出 run/queue/downgrade/defer/reject/silent_drop。
 * 边界: 不写长期任务队列，不获取 S0 锁。
 */
const path = require('path');
const { appendJsonlEvent } = require('../resource-common/files');
const { normalizeTaskBudget } = require('./task-budget');
const { SCHEDULER_ROOT, readResourceSnapshot } = require('./resource-snapshot');
function isRunningTaskLike(value) {
    return !!value && typeof value === 'object';
}
// 返回当天 S1 准入事件日志路径。
function admissionEventFile(date = new Date()) {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(SCHEDULER_ROOT, `admissions-${stamp}.jsonl`);
}
// 判断某任务是否允许作为低成本状态查询绕过重任务限制。
function isStatusQuery(kind) {
    return kind === 'status_query';
}
// 判断任务是否属于普通聊天入口。
function isNormalChat(kind) {
    return kind === 'normal_chat';
}
// 判断任务是否属于媒体后台负载。
function isMediaTask(kind) {
    return kind === 'media_image_analysis' || kind === 'media_file_analysis' || kind === 'media_voice_transcription';
}
// 判断任务是否需要 Chromium 或浏览器工具。
function isChromiumTask(kind) {
    return kind === 'daily_report_render' || kind === 'browser_action';
}
// 构造准入结果。
function buildDecision(decision, reason, budget, snapshot, fallback = '') {
    return {
        decision,
        reason,
        resourceState: snapshot.resourceState,
        botMode: snapshot.botMode,
        memAvailableMb: snapshot.memAvailableMb,
        fallback: fallback || undefined,
        budget,
        snapshot,
    };
}
// 按 S1 最终计划输出统一资源准入决策。
function decideAdmission(input, snapshot = readResourceSnapshot()) {
    const budget = normalizeTaskBudget(input);
    const kind = String(budget.kind || '');
    const currentLock = snapshot.running || null;
    const lockedBySelf = !!(budget.taskId && isRunningTaskLike(currentLock) && currentLock.taskId === budget.taskId);
    if (isStatusQuery(kind))
        return buildDecision('run_now', 'status query is always low cost', budget, snapshot);
    if (snapshot.botMode === 'maintenance') {
        if (isNormalChat(kind))
            return buildDecision('silent_drop', 'maintenance mode silences normal chat', budget, snapshot);
        return buildDecision('reject', 'maintenance mode rejects heavy tasks', budget, snapshot);
    }
    if (snapshot.botMode === 'report_silent') {
        if (isNormalChat(kind))
            return buildDecision('silent_drop', 'daily report is running', budget, snapshot);
        if (isMediaTask(kind))
            return buildDecision('defer', 'media drain paused during daily report', budget, snapshot);
        if (kind === 'daily_report' || kind === 'daily_report_render')
            return buildDecision('queue', 'daily report already running', budget, snapshot);
        if (budget.exclusive)
            return buildDecision('queue', 'exclusive task waits for current report', budget, snapshot);
    }
    if (snapshot.resourceState === 'black') {
        if (isNormalChat(kind))
            return buildDecision('silent_drop', 'resource state black silences chat', budget, snapshot);
        if (budget.deferable)
            return buildDecision('defer', 'resource state black defers heavy task', budget, snapshot);
        return buildDecision('reject', 'resource state black rejects heavy task', budget, snapshot);
    }
    if (snapshot.resourceState === 'red') {
        if (isNormalChat(kind))
            return buildDecision('silent_drop', 'resource state red silences chat', budget, snapshot);
        if (kind === 'daily_report' || kind === 'daily_report_render') {
            const fallback = budget.fallbacks[0] || 'daily_report_text';
            return buildDecision('downgrade', 'resource state red disables Chromium', budget, snapshot, fallback);
        }
        if (isChromiumTask(kind))
            return buildDecision(budget.deferable ? 'defer' : 'reject', 'Chromium task blocked in red state', budget, snapshot);
        if (isMediaTask(kind))
            return buildDecision('defer', 'media task deferred in red state', budget, snapshot);
        if (budget.exclusive)
            return buildDecision(budget.deferable ? 'defer' : 'reject', 'exclusive task deferred in red state', budget, snapshot);
    }
    if (snapshot.locked && !lockedBySelf && budget.exclusive)
        return buildDecision('queue', 'exclusive slot is busy', budget, snapshot);
    if (snapshot.locked && !lockedBySelf && isMediaTask(kind))
        return buildDecision('defer', 'media waits for exclusive slot to clear', budget, snapshot);
    if (snapshot.resourceState === 'yellow' && isMediaTask(kind))
        return buildDecision('defer', 'media is throttled in yellow state', budget, snapshot);
    return buildDecision('run_now', 'resource budget accepted', budget, snapshot);
}
// 记录准入事件；Dashboard 只展示事件，不反推业务原因。
function writeAdmissionEvent(decision) {
    const budget = decision.budget;
    appendJsonlEvent(admissionEventFile(), {
        event: 'admission_decided',
        taskId: budget.taskId,
        kind: budget.kind,
        source: budget.source,
        channelKey: budget.channelKey,
        userId: budget.userId,
        decision: decision.decision,
        resourceState: decision.resourceState,
        botMode: decision.botMode,
        memAvailableMb: decision.memAvailableMb,
        fallback: decision.fallback || '',
        reason: decision.reason,
    });
}
// 统一入口：读取快照、决策、写事件并返回结果。
function admitTask(input) {
    const snapshot = readResourceSnapshot();
    const decision = decideAdmission(input, snapshot);
    writeAdmissionEvent(decision);
    return decision;
}
module.exports = {
    admissionEventFile,
    decideAdmission,
    writeAdmissionEvent,
    admitTask,
};
