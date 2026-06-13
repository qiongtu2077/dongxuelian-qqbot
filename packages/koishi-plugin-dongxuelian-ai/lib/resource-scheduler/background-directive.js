"use strict";
/**
 * MODULE: 后台循环统一指令薄门面。
 * 职责: 基于现有资源快照与任务准入结果，为后台循环输出 run / park 与退避时长。
 * 边界: 不接管 worker 状态机，不创建新的资源中心，不复制 admission 判断树。
 */
const { decideTaskDirective, readResourceContext, } = require('./resource-directive');
const { RESOURCE_TASK_KIND, shouldYieldToToolActiveKind, } = require('../resource-common/resource-task-kinds');
const { readResourceActivityLease, } = require('./resource-activity-lease');
function normalizeResourceState(snapshot) {
    return String(snapshot?.resourceState || 'yellow');
}
function normalizeBotMode(snapshot) {
    return String(snapshot?.botMode || 'normal');
}
function getBackgroundDirectiveSleepMs(snapshot, taskAction) {
    const resourceState = normalizeResourceState(snapshot);
    const botMode = normalizeBotMode(snapshot);
    if (botMode === 'maintenance')
        return 30000;
    if (resourceState === 'black')
        return 30000;
    if (resourceState === 'red')
        return 15000;
    if (taskAction === 'queue')
        return 5000;
    if (resourceState === 'yellow')
        return 5000;
    return 2000;
}
function shouldParkBackgroundDirective(action) {
    return action === 'defer' || action === 'reject' || action === 'silent_drop' || action === 'queue';
}
function getBackgroundDirectiveKind(input) {
    return String(input.kind || '');
}
function decideBackgroundDirective(input, snapshot = readResourceContext()) {
    const task = decideTaskDirective(input, snapshot);
    const taskAction = String(task.directive?.action || '');
    const kind = getBackgroundDirectiveKind(input);
    const toolActiveLease = shouldYieldToToolActiveKind(kind)
        ? readResourceActivityLease('tool_active')
        : null;
    if (toolActiveLease) {
        return {
            directive: {
                action: 'park',
                reason: `foreground tool active (${String(toolActiveLease.owner || toolActiveLease.taskId || toolActiveLease.pid || 'unknown')})`,
                resourceState: normalizeResourceState(snapshot),
                botMode: normalizeBotMode(snapshot),
                sleepMs: getBackgroundDirectiveSleepMs(snapshot, 'queue'),
                taskAction,
            },
            task,
            snapshot,
        };
    }
    const parked = shouldParkBackgroundDirective(taskAction);
    return {
        directive: {
            action: parked ? 'park' : 'run',
            reason: String(task.directive?.reason || taskAction || 'background directive'),
            resourceState: normalizeResourceState(snapshot),
            botMode: normalizeBotMode(snapshot),
            sleepMs: parked ? getBackgroundDirectiveSleepMs(snapshot, taskAction) : 0,
            taskAction,
            fallback: task.directive?.fallback || undefined,
        },
        task,
        snapshot,
    };
}
module.exports = {
    getBackgroundDirectiveSleepMs,
    shouldParkBackgroundDirective,
    decideBackgroundDirective,
};
