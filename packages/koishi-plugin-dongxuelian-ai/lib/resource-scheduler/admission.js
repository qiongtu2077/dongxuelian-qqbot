"use strict";
/**
 * MODULE: S1 资源准入决策。
 * 职责: 根据任务预算和资源快照输出 run/queue/downgrade/defer/reject/silent_drop。
 * 边界: 不写长期任务队列，不获取 S0 锁。
 */
const path = require('path');
const { appendJsonlEvent } = require('../resource-common/files');
const { isStatusQueryKind, isNormalChatKind, isMediaTaskKind, isChromiumTaskKind, isDailyReportKind, canRunInRedStateByKind, } = require('../resource-common/resource-task-kinds');
const { normalizeTaskBudget } = require('./task-budget');
const { SCHEDULER_ROOT, readResourceSnapshot } = require('./resource-snapshot');
const ADMISSION_EVENT_DEDUPE_WINDOW_MS = Math.max(1000, Math.min(60000, Number(process.env.RESOURCE_ADMISSION_EVENT_DEDUPE_MS || 10000)));
const recentAdmissionEvents = new Map();
function isRunningTaskLike(value) {
    return !!value && typeof value === 'object';
}
// 返回当天 S1 准入事件日志路径。
function admissionEventFile(date = new Date()) {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(SCHEDULER_ROOT, `admissions-${stamp}.jsonl`);
}
// 判断当前任务是否低于自身最低内存预算，避免全局档位放宽后重任务越过预算运行。
function isBelowTaskMinMemory(kind, budget, snapshot) {
    if (isStatusQueryKind(kind) || isNormalChatKind(kind))
        return false;
    if (snapshot.memAvailableMb === null)
        return false;
    return snapshot.memAvailableMb < budget.minMemMb;
}
// 在非 red 档下按任务自身预算输出保守降级/延后决策。
function decideBelowTaskMinMemory(kind, budget, snapshot) {
    if (!isBelowTaskMinMemory(kind, budget, snapshot))
        return null;
    if (isDailyReportKind(kind)) {
        const fallback = budget.fallbacks[0] || 'daily_report_text';
        return buildDecision('downgrade', 'available memory is below task min memory budget', budget, snapshot, fallback);
    }
    if (budget.deferable)
        return buildDecision('defer', 'available memory is below task min memory budget', budget, snapshot);
    return buildDecision('reject', 'available memory is below task min memory budget', budget, snapshot);
}
// 判断当前任务是否可按自身预算在 red 档继续运行。
function canRunInRedState(kind, budget, snapshot) {
    if (!canRunInRedStateByKind(kind))
        return false;
    if (snapshot.memAvailableMb === null)
        return false;
    return snapshot.memAvailableMb >= budget.minMemMb;
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
function buildAdmissionEventKey(decision) {
    const budget = decision.budget;
    return [
        String(budget.taskId || ''),
        String(budget.kind || ''),
        String(budget.source || ''),
        String(decision.decision || ''),
        String(decision.reason || ''),
        String(decision.resourceState || ''),
        String(decision.botMode || ''),
    ].join('|');
}
function shouldWriteAdmissionEvent(decision, now = Date.now()) {
    const key = buildAdmissionEventKey(decision);
    const lastAt = recentAdmissionEvents.get(key) || 0;
    if (now - lastAt < ADMISSION_EVENT_DEDUPE_WINDOW_MS)
        return false;
    recentAdmissionEvents.set(key, now);
    for (const [entryKey, entryAt] of recentAdmissionEvents) {
        if (now - entryAt > ADMISSION_EVENT_DEDUPE_WINDOW_MS)
            recentAdmissionEvents.delete(entryKey);
    }
    return true;
}
// 按 S1 最终计划输出统一资源准入决策。
function decideAdmission(input, snapshot = readResourceSnapshot()) {
    const budget = normalizeTaskBudget(input);
    const kind = String(budget.kind || '');
    const currentLock = snapshot.running || null;
    const lockedBySelf = !!(budget.taskId && isRunningTaskLike(currentLock) && currentLock.taskId === budget.taskId);
    if (isStatusQueryKind(kind))
        return buildDecision('run_now', 'status query is always low cost', budget, snapshot);
    if (snapshot.botMode === 'maintenance') {
        if (isNormalChatKind(kind))
            return buildDecision('silent_drop', 'maintenance mode silences normal chat', budget, snapshot);
        return buildDecision('reject', 'maintenance mode rejects heavy tasks', budget, snapshot);
    }
    if (snapshot.botMode === 'report_silent') {
        if (isNormalChatKind(kind))
            return buildDecision('silent_drop', 'daily report is running', budget, snapshot);
        if (isMediaTaskKind(kind))
            return buildDecision('defer', 'media drain paused during daily report', budget, snapshot);
        if (isDailyReportKind(kind))
            return buildDecision('queue', 'daily report already running', budget, snapshot);
        if (budget.exclusive)
            return buildDecision('queue', 'exclusive task waits for current report', budget, snapshot);
    }
    if (snapshot.resourceState === 'black') {
        if (isNormalChatKind(kind))
            return buildDecision('silent_drop', 'resource state black silences chat', budget, snapshot);
        if (budget.deferable)
            return buildDecision('defer', 'resource state black defers heavy task', budget, snapshot);
        return buildDecision('reject', 'resource state black rejects heavy task', budget, snapshot);
    }
    if (snapshot.resourceState === 'red') {
        if (isNormalChatKind(kind))
            return buildDecision('silent_drop', 'resource state red silences chat', budget, snapshot);
        if (canRunInRedState(kind, budget, snapshot)) {
            if (snapshot.locked && !lockedBySelf && budget.exclusive)
                return buildDecision('queue', 'exclusive slot is busy', budget, snapshot);
            return buildDecision('run_now', 'red state accepted by task min memory budget', budget, snapshot);
        }
        if (isDailyReportKind(kind)) {
            const fallback = budget.fallbacks[0] || 'daily_report_text';
            return buildDecision('downgrade', 'resource state red disables Chromium', budget, snapshot, fallback);
        }
        if (isChromiumTaskKind(kind))
            return buildDecision(budget.deferable ? 'defer' : 'reject', 'Chromium task blocked in red state', budget, snapshot);
        if (isMediaTaskKind(kind))
            return buildDecision('defer', 'media task deferred in red state', budget, snapshot);
        if (budget.exclusive)
            return buildDecision(budget.deferable ? 'defer' : 'reject', 'exclusive task deferred in red state', budget, snapshot);
    }
    if (snapshot.locked && !lockedBySelf && budget.exclusive)
        return buildDecision('queue', 'exclusive slot is busy', budget, snapshot);
    if (snapshot.locked && !lockedBySelf && isMediaTaskKind(kind))
        return buildDecision('defer', 'media waits for exclusive slot to clear', budget, snapshot);
    const belowMinDecision = decideBelowTaskMinMemory(kind, budget, snapshot);
    if (belowMinDecision)
        return belowMinDecision;
    if (snapshot.resourceState === 'yellow' && isMediaTaskKind(kind))
        return buildDecision('defer', 'media is throttled in yellow state', budget, snapshot);
    return buildDecision('run_now', 'resource budget accepted', budget, snapshot);
}
// 记录准入事件；Dashboard 只展示事件，不反推业务原因。
function writeAdmissionEvent(decision) {
    if (!shouldWriteAdmissionEvent(decision))
        return;
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
    decideBelowTaskMinMemory,
    writeAdmissionEvent,
    admitTask,
};
