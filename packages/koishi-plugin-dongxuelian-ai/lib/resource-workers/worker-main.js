"use strict";
/**
 * MODULE: S2 worker 主入口。
 * 职责: 提供独立 worker 循环、S1 准入、S0 独占锁和任务状态迁移。
 * 边界: 不注册 Koishi middleware，不直接处理用户消息入口。
 */
const { admitTask } = require('../resource-scheduler/admission');
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds');
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive');
const { acquireResourceGate } = require('../resource-gate/gate');
const { collectProcessMetrics, checkWorkerMemoryLimit, writeProcessCleanupEvent, terminateRecordedProcessPids, } = require('../resource-system/system-protection');
const { claimNextTask, markTaskRunning, failIsolatedClaimingTask, completeTask, failTask, deferTask, requeueTask, updateTaskStep, writeWorkerHeartbeat, } = require('./task-store');
const { runDailyWorkerTask } = require('./daily-worker');
const { runAgentWorkerTask } = require('./agent-worker');
const { drainOneMediaTask } = require('./media-worker');
const { runEmotionRenderWorkerTask } = require('./emotion-worker');
const { runMemoryWorkerTask } = require('./memory-worker');
const { runBackgroundLlmWorkerTask } = require('./background-llm-worker');
const { runDailySlotTask } = require('../daily-precompute/daily-slot-worker');
// 等待指定毫秒，用于 worker 空转和退避。
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// 解析任务运行超时；避免异常配置让 worker 永久等待。
function resolveTaskTimeoutMs(task, fallbackMs = 300000) {
    const timeout = Number(task?.timeoutMs || task?.payload?.timeoutMs || fallbackMs);
    if (!Number.isFinite(timeout))
        return fallbackMs;
    return Math.max(10000, Math.min(30 * 60 * 1000, timeout));
}
// 给单个 worker 任务加 S8 运行超时兜底；超时后由调用方标记失败并退出进程。
async function runTaskWithTimeout(task) {
    const timeoutMs = resolveTaskTimeoutMs(task);
    let timer = null;
    try {
        return await Promise.race([
            executeWorkerTask(task),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`resource worker task timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
// 判断错误是否为 S8 任务超时。
function isTaskTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error || '');
    return /resource worker task timed out/i.test(message);
}
// 记录任务超时并让独立 worker 进程退出，由 supervisor 拉起干净进程。
function handleTaskTimeoutExit(workerName, task, error) {
    const taskId = String(task?.id || '');
    const kind = String(task?.kind || '');
    writeProcessCleanupEvent({
        event: 'task_timed_out',
        workerName,
        taskId,
        kind,
        timeoutMs: resolveTaskTimeoutMs(task),
        error: error instanceof Error ? error.message : String(error || 'task timeout'),
    });
    terminateRecordedProcessPids({
        taskId,
        kind,
        owner: workerName,
        source: 'resource_worker_timeout',
        reason: 'task_timed_out',
    });
    process.exitCode = process.exitCode || 76;
}
// 启动 worker 周期心跳，避免长任务执行期间被 supervisor 误判为死亡。
function startWorkerHeartbeat(workerName, type, initialStep) {
    let step = initialStep;
    let extra = {};
    const startedAt = new Date().toISOString();
    const write = () => {
        writeWorkerHeartbeat(workerName, { kind: type, startedAt, step, ...extra });
    };
    const timer = setInterval(write, 2000);
    if (timer.unref)
        timer.unref();
    write();
    return {
        setStep(nextStep, patch = {}) {
            step = nextStep || step;
            extra = patch;
            write();
        },
        stop(finalStep = 'stopped') {
            clearInterval(timer);
            step = finalStep;
            extra = {};
            write();
        },
    };
}
// 将 worker 类型映射为 S2 任务 kind 列表。
function getWorkerTaskKinds(type) {
    if (type === 'daily')
        return [RESOURCE_TASK_KIND.DAILY_REPORT, RESOURCE_TASK_KIND.DAILY_SUMMARY, RESOURCE_TASK_KIND.EMOTION_RENDER];
    if (type === 'agent') {
        return [
            RESOURCE_TASK_KIND.AGENT_TASK,
            RESOURCE_TASK_KIND.DASHBOARD_AGENT,
            RESOURCE_TASK_KIND.AGENT_MEMORY,
            RESOURCE_TASK_KIND.AGENT_MEMORY_COMPACTION,
            RESOURCE_TASK_KIND.EXPRESSION_HARVEST,
            RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
            RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
        ];
    }
    return [String(type || '')].filter(Boolean);
}
// 生成 worker 名称。
function getWorkerName(type, explicit = '') {
    return explicit || `${type || 'resource'}-worker`;
}
function getWorkerBackgroundDirectiveProbe(type, workerName) {
    if (type === 'media') {
        return {
            kind: RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS,
            source: workerName,
            channelKey: 'media',
            userId: '',
        };
    }
    if (type === 'daily') {
        return {
            kind: RESOURCE_TASK_KIND.DAILY_REPORT,
            source: workerName,
            channelKey: 'global',
            userId: '',
        };
    }
    if (type === 'agent') {
        return {
            kind: RESOURCE_TASK_KIND.AGENT_TASK,
            source: workerName,
            channelKey: 'global',
            userId: '',
        };
    }
    return null;
}
function readWorkerBackgroundDirective(type, workerName) {
    const probe = getWorkerBackgroundDirectiveProbe(type, workerName);
    if (!probe)
        return null;
    return decideBackgroundDirective(probe);
}
// 根据任务类型调用对应执行器。
async function executeWorkerTask(task) {
    if (task.kind === RESOURCE_TASK_KIND.DAILY_REPORT)
        return await runDailyWorkerTask(task);
    if (task.kind === RESOURCE_TASK_KIND.DAILY_SUMMARY)
        return runDailySlotTask(task);
    if (task.kind === RESOURCE_TASK_KIND.EMOTION_RENDER)
        return await runEmotionRenderWorkerTask(task);
    if (task.kind === RESOURCE_TASK_KIND.AGENT_TASK || task.kind === RESOURCE_TASK_KIND.DASHBOARD_AGENT)
        return await runAgentWorkerTask(task);
    if (task.kind === RESOURCE_TASK_KIND.AGENT_MEMORY || task.kind === RESOURCE_TASK_KIND.AGENT_MEMORY_COMPACTION)
        return await runMemoryWorkerTask(task);
    if (task.kind === RESOURCE_TASK_KIND.EXPRESSION_HARVEST || task.kind === RESOURCE_TASK_KIND.CONVERSATION_SUMMARY || task.kind === RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS)
        return await runBackgroundLlmWorkerTask(task);
    throw new Error(`unsupported S2 worker task kind: ${String(task.kind || '')}`);
}
// 判断任务是否需要 S0 独占锁；daily_summary 是非 AI 预计算统计，不占高风险运行槽。
function requiresExclusiveGate(task) {
    return task.kind !== RESOURCE_TASK_KIND.DAILY_SUMMARY;
}
// 按 S1 降级决策调整任务 payload，避免 worker 继续执行被禁止的高成本阶段。
function applyAdmissionDecisionToTask(task, admission) {
    if (!admission || admission.decision !== 'downgrade')
        return task;
    if (task.kind !== RESOURCE_TASK_KIND.DAILY_REPORT)
        return task;
    return {
        ...task,
        payload: {
            ...(task.payload || {}),
            renderImage: false,
            level: 'text',
            downgradeReason: String(admission.reason || 'resource downgrade'),
            fallback: String(admission.fallback || 'daily_report_text'),
        },
    };
}
// 执行不需要 S0 独占锁的低风险任务，同时保留 S2 状态迁移和结果落盘。
async function runTaskWithoutGate(task, workerName, heartbeat) {
    if (heartbeat)
        heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind });
    const runningTask = markTaskRunning(task, workerName, 'running');
    if (runningTask.status !== 'running') {
        failIsolatedClaimingTask(runningTask, new Error('task did not enter running'), { reason: 'task_did_not_enter_running' });
        if (heartbeat)
            heartbeat.setStep('tick');
        return true;
    }
    try {
        const result = await runTaskWithTimeout(runningTask);
        if (result && result.defer) {
            deferTask(runningTask, String(result.reason || 'worker deferred'));
        }
        else {
            completeTask(runningTask, result || { mode: 'worker', reason: 'completed' });
        }
    }
    catch (error) {
        failTask(runningTask, error, { reason: error instanceof Error ? error.message : String(error || '') });
        if (isTaskTimeoutError(error))
            handleTaskTimeoutExit(workerName, runningTask, error);
    }
    finally {
        if (heartbeat)
            heartbeat.setStep('tick');
    }
    return true;
}
// 处理一个 S2 pending 任务；没有任务时返回 false。
async function runOneQueuedTask(options = {}, heartbeat) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    const kinds = getWorkerTaskKinds(type);
    const task = claimNextTask(kinds, workerName);
    if (!task)
        return false;
    const exclusive = requiresExclusiveGate(task);
    const admission = admitTask({
        taskId: task.id,
        kind: task.kind,
        source: workerName,
        channelKey: task.channelKey,
        userId: task.userId,
        exclusive,
        priority: task.priority,
        queueTimeoutMs: task.timeoutMs,
        runTimeoutMs: task.timeoutMs,
    });
    if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
        failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision });
        return true;
    }
    if (admission.decision === 'defer') {
        deferTask(task, String(admission.reason || admission.decision));
        return false;
    }
    if (admission.decision === 'queue') {
        requeueTask(task, String(admission.reason || admission.decision));
        return false;
    }
    const admittedTask = applyAdmissionDecisionToTask(task, admission);
    if (!exclusive)
        return runTaskWithoutGate(admittedTask, workerName, heartbeat);
    let runningTask = markTaskRunning(admittedTask, workerName, 'waiting_lock');
    if (runningTask.status !== 'running') {
        failIsolatedClaimingTask(runningTask, new Error('task did not enter running'), { reason: 'task_did_not_enter_running' });
        if (heartbeat)
            heartbeat.setStep('tick');
        return true;
    }
    let gateHandle = null;
    try {
        if (heartbeat)
            heartbeat.setStep('waiting_lock', { taskId: task.id, taskKind: task.kind });
        gateHandle = await acquireResourceGate({
            taskId: task.id,
            kind: task.kind,
            owner: workerName,
            channelKey: task.channelKey,
            userId: task.userId,
            priority: task.priority,
            timeoutMs: task.timeoutMs,
            waitTimeoutMs: Number.isFinite(Number(options.gateWaitMs)) ? Number(options.gateWaitMs) : 15000,
            step: 'running',
        });
        gateHandle.updateStep('running');
        if (heartbeat)
            heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind });
        runningTask = markTaskRunning(runningTask, workerName, 'running');
        if (runningTask.status !== 'running') {
            failIsolatedClaimingTask(runningTask, new Error('task did not enter running'), { reason: 'task_did_not_enter_running' });
            return true;
        }
        const result = await runTaskWithTimeout(runningTask);
        if (result && result.defer) {
            deferTask(runningTask, String(result.reason || 'worker deferred'));
        }
        else {
            completeTask(runningTask, result || { mode: 'worker', reason: 'completed' });
        }
        return true;
    }
    catch (error) {
        if (!gateHandle) {
            requeueTask(runningTask, error instanceof Error ? error.message : String(error || 'lock_wait_failed'));
            return false;
        }
        else {
            failTask(runningTask, error, { reason: error instanceof Error ? error.message : String(error || '') });
            if (isTaskTimeoutError(error))
                handleTaskTimeoutExit(workerName, runningTask, error);
        }
        return true;
    }
    finally {
        if (gateHandle)
            gateHandle.release('worker-finally');
        if (heartbeat)
            heartbeat.setStep('tick');
    }
}
// 执行一次 worker tick，media 类型走 S6 队列，其余类型走 S2 队列。
async function runWorkerTick(options = {}, heartbeat) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    if (heartbeat)
        heartbeat.setStep('tick');
    else
        writeWorkerHeartbeat(workerName, { kind: type, step: 'tick' });
    collectProcessMetrics({ workerName, workerType: type });
    const memory = checkWorkerMemoryLimit(workerName);
    if (memory.exceeded) {
        if (heartbeat)
            heartbeat.setStep('memory_limit_exceeded', { rssMb: memory.rssMb });
        else
            writeWorkerHeartbeat(workerName, { kind: type, step: 'memory_limit_exceeded', rssMb: memory.rssMb });
        process.exitCode = 75;
        return false;
    }
    if (type === 'media')
        return drainOneMediaTask({ workerName, gateWaitMs: options.gateWaitMs });
    const backgroundDirective = readWorkerBackgroundDirective(type, workerName);
    if (backgroundDirective && backgroundDirective.directive.action === 'park') {
        if (heartbeat) {
            heartbeat.setStep('parked', {
                reason: backgroundDirective.directive.reason,
                resourceState: backgroundDirective.directive.resourceState,
            });
        }
        return false;
    }
    return runOneQueuedTask(options, heartbeat);
}
function resolveWorkerIdleSleepMs(options = {}, worked = false) {
    const pollMs = Math.max(500, Math.min(30000, Number(options.pollMs || 2000)));
    if (worked)
        return 200;
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    const backgroundDirective = readWorkerBackgroundDirective(type, workerName);
    if (!backgroundDirective || backgroundDirective.directive.action !== 'park')
        return pollMs;
    return Math.max(pollMs, Number(backgroundDirective.directive.sleepMs || pollMs));
}
// 运行 worker 主循环；once=true 时只执行一轮，便于运维手动验证。
async function runWorkerLoop(options = {}) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    const pollMs = Math.max(500, Math.min(30000, Number(options.pollMs || 2000)));
    const heartbeat = startWorkerHeartbeat(workerName, type, 'started');
    try {
        heartbeat.setStep('started', { startedAt: new Date().toISOString() });
        do {
            const worked = await runWorkerTick({ ...options, type, workerName }, heartbeat);
            if (options.once)
                break;
            await sleep(resolveWorkerIdleSleepMs({ ...options, type, workerName, pollMs }, worked));
        } while (!process.exitCode);
    }
    finally {
        heartbeat.stop('stopped');
    }
}
// 解析命令行参数，支持 node worker-main.js --type media --once。
function parseWorkerCliArgs(argv = process.argv.slice(2)) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--type')
            options.type = argv[++i];
        else if (arg === '--name')
            options.workerName = argv[++i];
        else if (arg === '--once')
            options.once = true;
        else if (arg === '--poll-ms')
            options.pollMs = Number(argv[++i]);
        else if (arg === '--gate-wait-ms')
            options.gateWaitMs = Number(argv[++i]);
    }
    return options;
}
if (require.main === module) {
    runWorkerLoop(parseWorkerCliArgs()).catch(error => {
        console.error('[resource-worker] failed:', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }).finally(() => {
        const exitCode = Number(process.exitCode || 0);
        if (Number.isFinite(exitCode) && exitCode > 0)
            process.exit(exitCode);
    });
}
module.exports = {
    runWorkerLoop,
    runWorkerTick,
    resolveWorkerIdleSleepMs,
    runOneQueuedTask,
    runTaskWithTimeout,
    parseWorkerCliArgs,
};
