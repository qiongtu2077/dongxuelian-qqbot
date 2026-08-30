"use strict";
/**
 * MODULE: S2 worker 主入口。
 * 职责: 提供独立 worker 循环、S1 准入、S0 独占锁和任务状态迁移。
 * 边界: 不注册 Koishi middleware，不直接处理用户消息入口。
 */
const { admitTask } = require('../resource-scheduler/admission');
const { RESOURCE_TASK_KIND, shouldYieldToToolActiveKind, } = require('../resource-common/resource-task-kinds');
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive');
const { readResourceActivityLease } = require('../resource-scheduler/resource-activity-lease');
const { acquireResourceGate } = require('../resource-gate/gate');
const { checkWorkerMemoryLimit, writeProcessCleanupEvent, terminateRecordedProcessPids, } = require('../resource-system/system-protection');
const { claimNextTask, markTaskRunning, failIsolatedClaimingTask, completeTask, failTask, deferTask, requeueTask, updateTaskStep, writeWorkerHeartbeat, } = require('./task-store');
const { runDailyWorkerTask } = require('./daily-worker');
const { runAgentWorkerTask } = require('./agent-worker');
const { drainOneMediaTask } = require('./media-worker');
const { runEmotionRenderWorkerTask } = require('./emotion-worker');
const { runMemoryWorkerTask } = require('./memory-worker');
const { runBackgroundLlmWorkerTask } = require('./background-llm-worker');
const { runDailySlotTask } = require('../daily-precompute/daily-slot-worker');
function resolveBoundedNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
const DEFAULT_WORKER_MAX_CONSECUTIVE_FAILURES = resolveBoundedNumber(process.env.RESOURCE_WORKER_MAX_CONSECUTIVE_FAILURES, 5, 1, 20);
const DEFAULT_WORKER_IDLE_EXIT_MS = resolveBoundedNumber(process.env.RESOURCE_WORKER_IDLE_EXIT_MS, 45000, 30000, 5 * 60 * 1000);
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
function createInitialWorkerProgress() {
    return {
        loopIterations: 0,
        lastClaimAttemptAt: '',
        lastTaskFinishedAt: '',
        currentTaskId: '',
        currentTaskStartedAt: '',
        parked: false,
        parkSleepMs: 0,
        idleSinceAt: '',
    };
}
function updateWorkerProgress(progress, patch = {}) {
    Object.assign(progress, patch);
    return progress;
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
function startWorkerHeartbeat(workerName, type, initialStep, progress, identity = {}) {
    let step = initialStep;
    let extra = {};
    const startedAt = new Date().toISOString();
    const write = () => {
        writeWorkerHeartbeat(workerName, { kind: type, startedAt, step, ...identity, ...progress, ...extra });
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
        patchProgress(patch = {}) {
            Object.assign(progress, patch);
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
function resolveClaimKindsForToolActive(kinds, toolActive) {
    if (!toolActive)
        return kinds;
    const allowed = kinds.filter(kind => !shouldYieldToToolActiveKind(kind));
    return allowed.length ? allowed : kinds;
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
    if (task.kind === RESOURCE_TASK_KIND.CONVERSATION_SUMMARY || task.kind === RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS)
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
async function runTaskWithoutGate(task, workerName, heartbeat, progress) {
    const startedAt = new Date().toISOString();
    if (progress) {
        updateWorkerProgress(progress, {
            currentTaskId: task.id,
            currentTaskStartedAt: startedAt,
            parked: false,
            parkSleepMs: 0,
        });
    }
    if (heartbeat) {
        if (progress)
            heartbeat.patchProgress(progress);
        heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind });
    }
    const runningTask = markTaskRunning(task, workerName, 'running');
    if (runningTask.status !== 'running') {
        failIsolatedClaimingTask(runningTask, new Error('task did not enter running'), { reason: 'task_did_not_enter_running' });
        if (progress) {
            updateWorkerProgress(progress, {
                currentTaskId: '',
                currentTaskStartedAt: '',
                lastTaskFinishedAt: new Date().toISOString(),
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('tick');
        }
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
        if (progress) {
            updateWorkerProgress(progress, {
                currentTaskId: '',
                currentTaskStartedAt: '',
                lastTaskFinishedAt: new Date().toISOString(),
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('tick');
        }
    }
    return true;
}
// 处理一个 S2 pending 任务；没有任务时返回 false。
async function runOneQueuedTask(options = {}, heartbeat, progress) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    const kinds = getWorkerTaskKinds(type);
    const toolActive = !!readResourceActivityLease('tool_active');
    const claimKinds = resolveClaimKindsForToolActive(kinds, toolActive);
    if (progress) {
        updateWorkerProgress(progress, {
            lastClaimAttemptAt: new Date().toISOString(),
            parked: false,
            parkSleepMs: 0,
        });
    }
    if (heartbeat && progress)
        heartbeat.patchProgress(progress);
    const task = claimNextTask(claimKinds, workerName);
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
        if (progress)
            updateWorkerProgress(progress, { lastTaskFinishedAt: new Date().toISOString() });
        if (heartbeat && progress)
            heartbeat.patchProgress(progress);
        return false;
    }
    if (admission.decision === 'queue') {
        requeueTask(task, String(admission.reason || admission.decision));
        if (progress)
            updateWorkerProgress(progress, { lastTaskFinishedAt: new Date().toISOString() });
        if (heartbeat && progress)
            heartbeat.patchProgress(progress);
        return false;
    }
    const admittedTask = applyAdmissionDecisionToTask(task, admission);
    if (!exclusive)
        return runTaskWithoutGate(admittedTask, workerName, heartbeat, progress);
    let runningTask = markTaskRunning(admittedTask, workerName, 'waiting_lock');
    if (runningTask.status !== 'running') {
        failIsolatedClaimingTask(runningTask, new Error('task did not enter running'), { reason: 'task_did_not_enter_running' });
        if (progress) {
            updateWorkerProgress(progress, {
                lastTaskFinishedAt: new Date().toISOString(),
                currentTaskId: '',
                currentTaskStartedAt: '',
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('tick');
        }
        return true;
    }
    let gateHandle = null;
    try {
        if (progress) {
            updateWorkerProgress(progress, {
                currentTaskId: task.id,
                currentTaskStartedAt: new Date().toISOString(),
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('waiting_lock', { taskId: task.id, taskKind: task.kind });
        }
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
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind });
        }
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
            if (progress) {
                updateWorkerProgress(progress, {
                    lastTaskFinishedAt: new Date().toISOString(),
                    currentTaskId: '',
                    currentTaskStartedAt: '',
                });
            }
            if (heartbeat && progress)
                heartbeat.patchProgress(progress);
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
        if (progress) {
            updateWorkerProgress(progress, {
                currentTaskId: '',
                currentTaskStartedAt: '',
                lastTaskFinishedAt: new Date().toISOString(),
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('tick');
        }
    }
}
// 执行一次 worker tick，media 类型走 S6 队列，其余类型走 S2 队列。
async function runWorkerTick(options = {}, heartbeat, progress) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    if (progress) {
        updateWorkerProgress(progress, {
            loopIterations: Number(progress.loopIterations || 0) + 1,
            parked: false,
            parkSleepMs: 0,
        });
    }
    if (heartbeat) {
        if (progress)
            heartbeat.patchProgress(progress);
        heartbeat.setStep('tick');
    }
    else
        writeWorkerHeartbeat(workerName, { kind: type, step: 'tick', ...(progress || {}) });
    const memory = checkWorkerMemoryLimit(workerName);
    if (memory.exceeded) {
        if (heartbeat)
            heartbeat.setStep('memory_limit_exceeded', { rssMb: memory.rssMb });
        else
            writeWorkerHeartbeat(workerName, {
                kind: type,
                step: 'memory_limit_exceeded',
                rssMb: Number.isFinite(Number(memory.rssMb)) ? Number(memory.rssMb) : null,
                ...(progress || {}),
            });
        process.exitCode = 75;
        return false;
    }
    const backgroundDirective = readWorkerBackgroundDirective(type, workerName);
    if (backgroundDirective && backgroundDirective.directive.action === 'park') {
        if (progress) {
            updateWorkerProgress(progress, {
                parked: true,
                parkSleepMs: Number(backgroundDirective.directive.sleepMs || 0),
            });
        }
        if (heartbeat) {
            if (progress)
                heartbeat.patchProgress(progress);
            heartbeat.setStep('parked', {
                reason: backgroundDirective.directive.reason,
                resourceState: backgroundDirective.directive.resourceState,
            });
        }
        return false;
    }
    if (type === 'media')
        return drainOneMediaTask({ workerName, gateWaitMs: options.gateWaitMs });
    return runOneQueuedTask(options, heartbeat, progress);
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
// 判断受 supervisor 管理的 small 模式 worker 是否已超过空闲退出窗口。
function shouldExitManagedWorker(options, idleSinceAt, now = Date.now()) {
    if (!String(options.ownerGeneration || '') || !String(options.startToken || ''))
        return false;
    const idleSince = Date.parse(String(idleSinceAt || ''));
    if (!Number.isFinite(idleSince))
        return false;
    const idleExitMs = resolveBoundedNumber(options.idleExitMs, DEFAULT_WORKER_IDLE_EXIT_MS, 30000, 5 * 60 * 1000);
    if (now - idleSince < idleExitMs)
        return false;
    const workerName = getWorkerName(String(options.type || 'daily'), options.workerName || '');
    const directive = readWorkerBackgroundDirective(String(options.type || 'daily'), workerName);
    return String(directive?.snapshot?.serverMode || 'large') === 'small';
}
// 运行 worker 主循环；once=true 时只执行一轮，便于运维手动验证。
async function runWorkerLoop(options = {}) {
    const type = String(options.type || 'daily');
    const workerName = getWorkerName(type, options.workerName || '');
    const pollMs = Math.max(500, Math.min(30000, Number(options.pollMs || 2000)));
    const progress = createInitialWorkerProgress();
    const heartbeat = startWorkerHeartbeat(workerName, type, 'started', progress, {
        ownerGeneration: String(options.ownerGeneration || ''),
        startToken: String(options.startToken || ''),
        executable: process.execPath,
        args: process.argv.slice(1),
    });
    let consecutiveFailures = 0;
    try {
        heartbeat.patchProgress(progress);
        heartbeat.setStep('started', { startedAt: new Date().toISOString() });
        do {
            let worked = false;
            try {
                worked = await runWorkerTick({ ...options, type, workerName }, heartbeat, progress);
                consecutiveFailures = 0;
            }
            catch (error) {
                consecutiveFailures += 1;
                writeProcessCleanupEvent({
                    event: 'worker_tick_failed',
                    workerName,
                    workerType: type,
                    consecutiveFailures,
                    error: error instanceof Error ? error.message : String(error || 'worker tick failed'),
                });
                if (consecutiveFailures >= DEFAULT_WORKER_MAX_CONSECUTIVE_FAILURES) {
                    process.exitCode = 77;
                    break;
                }
                worked = false;
            }
            if (worked) {
                updateWorkerProgress(progress, { idleSinceAt: '' });
            }
            else if (!progress.idleSinceAt) {
                updateWorkerProgress(progress, { idleSinceAt: new Date().toISOString() });
            }
            heartbeat.patchProgress(progress);
            if (!options.once && shouldExitManagedWorker({ ...options, type, workerName }, progress.idleSinceAt)) {
                writeProcessCleanupEvent({
                    event: 'worker_idle_exit',
                    workerName,
                    workerType: type,
                    ownerGeneration: String(options.ownerGeneration || ''),
                    idleSinceAt: progress.idleSinceAt,
                });
                break;
            }
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
        else if (arg === '--generation')
            options.ownerGeneration = argv[++i];
        else if (arg === '--start-token')
            options.startToken = argv[++i];
        else if (arg === '--idle-exit-ms')
            options.idleExitMs = Number(argv[++i]);
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
    shouldExitManagedWorker,
    runOneQueuedTask,
    runTaskWithTimeout,
    parseWorkerCliArgs,
};
