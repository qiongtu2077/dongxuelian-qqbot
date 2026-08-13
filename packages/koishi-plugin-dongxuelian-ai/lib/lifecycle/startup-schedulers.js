"use strict";
/* ==========================================================================
 * MODULE: startup-schedulers
 * 职责：管理插件启动后的周期性维护任务定时器。
 * 边界：不注册 middleware、不发送消息、不修改聊天/随机策略；只调度清理和日报预计算。
 * 状态：持有 dailyCleanupTimer 与 dailyPrecomputeTimer，dispose 时由调用方显式清理。
 * ========================================================================== */
const { trimChannelRuntimeCaches, cleanupDailyStatsFiles, } = require('../conversation');
const { todayCst } = require('../core/utils');
const { logDebug } = require('../core/logging-config');
const { countResourceTasks, cleanupFinishedTasks } = require('../resource-workers/task-store');
const { planDailySlotTasks } = require('../daily-precompute/daily-slot-planner');
const { listDailyCoverage } = require('../daily-precompute/precompute-status');
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive');
let dailyCleanupTimer = null;
let dailyPrecomputeTimer = null;
const DAILY_SLOT_BACKLOG_STOP_MAX_PENDING = Math.max(1, Number(process.env.DAILY_SLOT_BACKLOG_STOP_MAX_PENDING || 8));
function getStartupSchedulerErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '');
}
function getNextShanghaiMidnightDelayMs(now = Date.now()) {
    const [year, month, day] = todayCst(new Date(now)).split('-').map(Number);
    const nextMidnightUtc = Date.UTC(year, month - 1, day, 16, 0, 0, 0);
    return Math.max(1000, nextMidnightUtc - now);
}
function scheduleDailyStatsCleanup(ctx) {
    const runDailyStatsCleanup = async () => {
        try {
            const result = await cleanupDailyStatsFiles();
            trimChannelRuntimeCaches();
            const gc = cleanupFinishedTasks();
            logDebug(ctx, 'cleanup', `daily stats cleanup removed=${result.removed} compacted=${result.compacted} tasksRemoved=${gc.removed} resultsRemoved=${gc.resultsRemoved} orphanResults=${gc.orphanResultsRemoved}`);
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${getStartupSchedulerErrorMessage(error)}`);
        }
        finally {
            dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs());
            if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function')
                dailyCleanupTimer.unref();
        }
    };
    dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs());
    if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function')
        dailyCleanupTimer.unref();
}
async function runDailyPrecomputePlanningTick(ctx) {
    const gate = decideBackgroundDirective({
        kind: 'daily_summary',
        source: 'daily-precompute-scheduler',
        channelKey: 'global',
        userId: '',
        priority: 70,
        exclusive: false,
        timeoutMs: 120000,
        queueTimeoutMs: 120000,
        runTimeoutMs: 120000,
    });
    if (gate.directive.action === 'park') {
        logDebug(ctx, 'daily-precompute', `planning parked reason=${gate.directive.reason} resource=${gate.directive.resourceState} sleepMs=${gate.directive.sleepMs}`);
        return { parked: true, planned: 0, channels: 0, reason: gate.directive.reason };
    }
    const activeBacklog = countResourceTasks({
        kind: 'daily_summary',
        statuses: ['pending', 'claiming', 'running', 'deferred'],
        limit: 20000,
    });
    if (activeBacklog >= DAILY_SLOT_BACKLOG_STOP_MAX_PENDING) {
        logDebug(ctx, 'daily-precompute', `planning short-circuited by backlog active=${activeBacklog} limit=${DAILY_SLOT_BACKLOG_STOP_MAX_PENDING}`);
        return { parked: false, planned: 0, channels: 0, reason: 'backlog_full' };
    }
    const today = todayCst();
    const coverages = listDailyCoverage(200)
        .filter(item => String(item.date || '') === today)
        .slice(0, 80);
    let planned = 0;
    for (const item of coverages) {
        const channelKey = String(item.channelKey || '');
        if (!channelKey)
            continue;
        const tasks = planDailySlotTasks(today, channelKey, {
            source: 'daily-precompute-scheduler',
            maxSlots: 4,
        });
        planned += tasks.length;
    }
    logDebug(ctx, 'daily-precompute', `planned slot tasks=${planned} channels=${coverages.length}`);
    return { parked: false, planned, channels: coverages.length, reason: gate.directive.reason };
}
// 按 coverage 中出现过的频道低频规划 S3 分片任务，真正执行仍交给 daily-worker。
function scheduleDailyPrecomputePlanning(ctx) {
    const intervalMs = Math.max(5 * 60 * 1000, Math.min(6 * 60 * 60 * 1000, Number(process.env.DAILY_PRECOMPUTE_PLAN_INTERVAL_MS || 30 * 60 * 1000)));
    const runDailyPrecomputeTick = async () => {
        try {
            await runDailyPrecomputePlanningTick(ctx);
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn(`daily precompute planning failed: ${getStartupSchedulerErrorMessage(error)}`);
        }
        finally {
            dailyPrecomputeTimer = setTimeout(runDailyPrecomputeTick, intervalMs);
            if (dailyPrecomputeTimer && typeof dailyPrecomputeTimer.unref === 'function')
                dailyPrecomputeTimer.unref();
        }
    };
    dailyPrecomputeTimer = setTimeout(runDailyPrecomputeTick, Math.min(2 * 60 * 1000, intervalMs));
    if (dailyPrecomputeTimer && typeof dailyPrecomputeTimer.unref === 'function')
        dailyPrecomputeTimer.unref();
}
function clearStartupSchedulers() {
    if (dailyCleanupTimer) {
        clearTimeout(dailyCleanupTimer);
        dailyCleanupTimer = null;
    }
    if (dailyPrecomputeTimer) {
        clearTimeout(dailyPrecomputeTimer);
        dailyPrecomputeTimer = null;
    }
}
module.exports = {
    getNextShanghaiMidnightDelayMs,
    scheduleDailyStatsCleanup,
    runDailyPrecomputePlanningTick,
    scheduleDailyPrecomputePlanning,
    clearStartupSchedulers,
};
