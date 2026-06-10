"use strict";
/**
 * MODULE: S3 分片规划器。
 * 职责: 根据 index 和 coverage 生成未覆盖分片任务。
 * 边界: 不执行分片，不调用 AI。
 */
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client');
const { getResourceTaskById } = require('../resource-workers/task-store');
const { sanitizeId } = require('../resource-common/files');
const { readPrecomputeIndex, writePrecomputeEvent } = require('./precompute-index');
const { readDailySlots } = require('./daily-summary-merge');
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot');
// 生成 slot id，使用索引范围和消息时间便于排障。
function buildSlotId(records, start, end) {
    const first = records[start];
    const last = records[end - 1];
    return `${start}-${end - 1}-${sanitizeId(first?.messageId || first?.timestamp || 'start')}-${sanitizeId(last?.messageId || last?.timestamp || 'end')}`.slice(0, 140);
}
// 从已有 slot 文件收集已覆盖 messageId，避免重复提交已经完成的分片。
function getCoveredMessageIds(date, channelKey) {
    const covered = new Set();
    for (const slot of readDailySlots(date, channelKey)) {
        for (const id of Array.isArray(slot.coveredMessageIds) ? slot.coveredMessageIds : [])
            covered.add(String(id));
    }
    return covered;
}
// 判断确定性 slot 任务是否已经在 S2 队列或历史中，不重复提交同一个 taskId。
// failed 也算已追踪：避免每轮对失败 slot 无限重提交（retryAfter 尚未支持前的止血）。
function isSlotTaskAlreadyTracked(taskId) {
    const task = getResourceTaskById(taskId);
    if (!task)
        return false;
    return ['pending', 'claiming', 'running', 'done', 'deferred', 'failed'].includes(String(task.status || ''));
}
// 规划指定日期频道的 slot 任务。
function planDailySlotTasks(date, channelKey, options = {}) {
    // 止血：red/black/维护模式下后台预计算必须让路，连规划扫描都不做。
    // S3 是机会式增强，不具备默认运行权（见 S0-S8 资源架构重整计划 9.6 节）。
    const snapshot = readResourceSnapshot();
    const resourceState = String(snapshot.resourceState || '');
    if (resourceState === 'red' || resourceState === 'black' || snapshot.maintenance) {
        writePrecomputeEvent('daily_slot_planning_skipped', { date, channelKey, resourceState, maintenance: !!snapshot.maintenance });
        return [];
    }
    const records = readPrecomputeIndex(date, channelKey);
    const coveredIds = getCoveredMessageIds(date, channelKey);
    const slotSize = Math.max(20, Math.min(500, Number(options.slotSize || 120)));
    const maxSlots = Math.max(1, Math.min(100, Number(options.maxSlots || 12)));
    const tasks = [];
    for (let start = 0; start < records.length && tasks.length < maxSlots; start += slotSize) {
        const end = Math.min(records.length, start + slotSize);
        const slice = records.slice(start, end);
        if (!slice.length)
            continue;
        const messageIds = slice.map(item => String(item.messageId || '')).filter(Boolean);
        if (messageIds.length && messageIds.every(id => coveredIds.has(id)))
            continue;
        const slotId = buildSlotId(records, start, end);
        const taskId = `daily_slot-${sanitizeId(date)}-${sanitizeId(channelKey)}-${sanitizeId(slotId)}`;
        if (isSlotTaskAlreadyTracked(taskId))
            continue;
        const submit = submitWorkerTaskWithAdmission({
            id: taskId,
            kind: 'daily_summary',
            source: options.source || 'daily-slot-planner',
            channelKey,
            priority: 70,
            timeoutMs: 120000,
            payload: {
                date,
                channelKey,
                slotId,
                start,
                end,
                messageIds,
            },
            notify: { target: 'none', status: 'pending' },
        }, { checkAdmission: true, exclusive: false });
        tasks.push(submit);
    }
    writePrecomputeEvent('daily_slot_tasks_planned', { date, channelKey, totalMessages: records.length, tasks: tasks.length });
    return tasks;
}
module.exports = {
    planDailySlotTasks,
};
