"use strict";
/**
 * MODULE: S2 worker supervisor。
 * 职责: 生成 worker 启动配置、记录 supervisor 状态、审计 stale running 任务。
 * 边界: 不执行系统级 kill，不实现 S9 扩容迁移。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { decideAdmission } = require('../resource-scheduler/admission');
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot');
const { SUPERVISOR_DIR } = require('./task-paths');
const { listWorkerStates, listResourceTasks, countResourceTasks, failTask, failIsolatedClaimingTask, requeueTask, writeWorkerEvent } = require('./task-store');
const { ensureDir, isProcessAlive, nowIso, writeJsonAtomic } = require('../resource-common/files');
const { writeProcessCleanupEvent, terminateProcessTree } = require('../resource-system/system-protection');
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds');
const WORKER_MEMORY_LIMITS = {
    daily: Number(process.env.RESOURCE_DAILY_WORKER_OLD_SPACE_MB || 768),
    agent: Number(process.env.RESOURCE_AGENT_WORKER_OLD_SPACE_MB || 768),
    media: Number(process.env.RESOURCE_MEDIA_WORKER_OLD_SPACE_MB || 512),
};
const DEFAULT_WORKER_TYPES = ['daily', 'agent', 'media'];
const DEFERRED_RESTORE_MAX_ACTIVE = Math.max(1, Number(process.env.RESOURCE_DEFERRED_RESTORE_MAX_ACTIVE || process.env.DAILY_SLOT_BACKLOG_STOP_MAX_PENDING || 8));
const WORKER_HEARTBEAT_STALE_MS = 10000;
const ownedWorkerProcesses = new Map();
// 记录当前 supervisor 亲自启动的 worker，并在进程退出后撤销所有权。
function rememberOwnedWorkerProcess(workerName, child) {
    ownedWorkerProcesses.set(workerName, child);
    const release = () => {
        if (ownedWorkerProcesses.get(workerName) === child)
            ownedWorkerProcesses.delete(workerName);
    };
    child.once('exit', release);
    child.once('error', release);
}
// 判断 worker PID 是否仍对应当前 supervisor 持有的活子进程句柄。
function isOwnedWorkerProcessAlive(workerName, pid) {
    const child = ownedWorkerProcesses.get(workerName);
    return !!child
        && Number(child.pid) === pid
        && child.exitCode === null
        && child.signalCode === null;
}
// 清空 supervisor 持有的 worker 句柄引用；不额外终止子进程。
function clearOwnedWorkerProcesses() {
    ownedWorkerProcesses.clear();
}
function resolveBoundedNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
const RESOURCE_WORKER_ZOMBIE_STAGNATION_MS = resolveBoundedNumber(process.env.RESOURCE_WORKER_ZOMBIE_STAGNATION_MS, 15 * 60 * 1000, 60000, 60 * 60 * 1000);
// 判断 deferred 任务是否已经超过自身有效期。
function isTaskExpired(task) {
    const expiresAt = Date.parse(String(task?.expiresAt || ''));
    return Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt;
}
// 判断 S1 决策是否代表任务可以回到 S2 pending 队列等待 worker 执行。
function canRestoreDeferredTask(decision) {
    return decision === 'run_now' || decision === 'queue' || decision === 'downgrade';
}
function didDeferredTaskTransition(task, next, expectedStatus) {
    return String(task?.status || '') !== expectedStatus
        && String(next?.status || '') === expectedStatus;
}
function getDeferredRestoreMaxActive(kind) {
    if (String(kind || '') !== 'daily_summary')
        return null;
    return DEFERRED_RESTORE_MAX_ACTIVE;
}
function getDeferredRestoreActiveBacklog(kind) {
    return countResourceTasks({
        kind,
        statuses: ['pending', 'claiming', 'running'],
        limit: 20000,
    });
}
function getWorkerKinds(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'daily')
        return [RESOURCE_TASK_KIND.DAILY_REPORT, RESOURCE_TASK_KIND.DAILY_SUMMARY, RESOURCE_TASK_KIND.EMOTION_RENDER];
    if (normalized === 'agent') {
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
    if (normalized === 'media')
        return [];
    return [];
}
function getSupervisorWorkerSamples() {
    try {
        const state = JSON.parse(fs.readFileSync(getSupervisorStateFile(), 'utf8'));
        const stateUpdatedAt = String(state?.updatedAt || '');
        const workers = Array.isArray(state?.workers) ? state.workers : [];
        const result = {};
        for (const worker of workers) {
            const item = worker && typeof worker === 'object' ? worker : {};
            const name = String(item.name || '');
            if (!name)
                continue;
            result[name] = { ...item, updatedAt: String(item.updatedAt || stateUpdatedAt) };
        }
        return result;
    }
    catch {
        return {};
    }
}
function attachWorkerProgressSamples(workers, previousSamples = {}) {
    const now = nowIso();
    return workers.map(worker => {
        const name = String(worker?.name || '');
        const previous = previousSamples[name] || {};
        const currentLoopIterations = Number(worker?.loopIterations);
        const previousLoopIterations = Number(previous.loopIterations);
        const previousLoopChangedAt = String(previous.loopChangedAt || previous.updatedAt || '');
        const loopChangedAt = Number.isFinite(currentLoopIterations)
            && Number.isFinite(previousLoopIterations)
            && currentLoopIterations <= previousLoopIterations
            && previousLoopChangedAt
            ? previousLoopChangedAt
            : now;
        return {
            ...worker,
            loopChangedAt,
        };
    });
}
function getWorkerTypeFromNameOrState(worker, fallbackName = '') {
    const explicit = String(worker?.kind || '').trim();
    if (explicit)
        return explicit;
    const name = String(worker?.name || fallbackName || '').trim();
    if (name.endsWith('-worker'))
        return name.slice(0, -'-worker'.length);
    return name;
}
function getWorkerBacklogCount(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'media') {
        const media = require('../media/backpressure/media-queue');
        const status = media.getMediaBackpressureStatus();
        return Number(status.imagePending || 0) + Number(status.filePending || 0) + Number(status.voicePending || 0);
    }
    return countPendingTasksForKinds(getWorkerKinds(normalized));
}
function countPendingTasksForKinds(kinds) {
    let total = 0;
    for (const kind of kinds) {
        total += countResourceTasks({
            kind,
            statuses: ['pending'],
            limit: 20000,
        });
    }
    return total;
}
function hasWorkerBacklog(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'media')
        return getWorkerBacklogCount('media');
    return countPendingTasksForKinds(getWorkerKinds(normalized));
}
function isWorkerRunningLongTask(worker) {
    const currentTaskId = String(worker?.currentTaskId || '').trim();
    if (!currentTaskId)
        return false;
    const startedAt = Date.parse(String(worker?.currentTaskStartedAt || ''));
    if (!Number.isFinite(startedAt))
        return false;
    const task = listResourceTasks({ statuses: ['running'], limit: 500 }).find(item => String(item.id || '') === currentTaskId);
    const timeoutMs = Number(task?.timeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return false;
    return Date.now() - startedAt < timeoutMs;
}
function isWorkerZombie(worker, previousSample = null) {
    const pidAlive = isProcessAlive(worker?.pid);
    if (!pidAlive)
        return false;
    const heartbeatLagMs = Number(worker?.heartbeatLagMs ?? Number.MAX_SAFE_INTEGER);
    const claimAttemptAt = Date.parse(String(worker?.lastClaimAttemptAt || worker?.heartbeatAt || ''));
    const claimLagMs = Number.isFinite(claimAttemptAt) ? Date.now() - claimAttemptAt : Number.MAX_SAFE_INTEGER;
    const previousLoopIterations = Number(previousSample?.loopIterations);
    const currentLoopIterations = Number(worker?.loopIterations);
    const previousLoopChangedAt = Date.parse(String(previousSample?.loopChangedAt || previousSample?.updatedAt || ''));
    const sampleWindowElapsed = Number.isFinite(previousLoopChangedAt) && Date.now() - previousLoopChangedAt >= RESOURCE_WORKER_ZOMBIE_STAGNATION_MS;
    const loopStalled = sampleWindowElapsed
        && Number.isFinite(previousLoopIterations)
        && Number.isFinite(currentLoopIterations)
        && currentLoopIterations <= previousLoopIterations;
    const progressStalled = heartbeatLagMs > WORKER_HEARTBEAT_STALE_MS || claimLagMs > RESOURCE_WORKER_ZOMBIE_STAGNATION_MS || loopStalled;
    if (!progressStalled)
        return false;
    if (worker?.parked === true)
        return false;
    if (isWorkerRunningLongTask(worker))
        return false;
    const backlog = hasWorkerBacklog(getWorkerTypeFromNameOrState(worker));
    return backlog > 0;
}
function recoverZombieWorker(worker) {
    const workerName = String(worker?.name || '');
    const pid = Number(worker?.pid || 0);
    if (!workerName || !(pid > 0))
        return false;
    const backlogCount = hasWorkerBacklog(getWorkerTypeFromNameOrState(worker));
    const result = terminateProcessTree(pid, {
        owner: workerName,
        source: 'resource_worker_supervisor',
        reason: 'worker_process_zombie_recovered',
        allowSingleProcessFallback: isOwnedWorkerProcessAlive(workerName, pid),
    });
    const killedPids = Array.isArray(result.killedPids)
        ? result.killedPids
        : [];
    if (!killedPids.length)
        return false;
    writeWorkerEvent('worker_process_zombie_recovered', {
        workerName,
        pid,
        loopIterations: Number(worker?.loopIterations || 0),
        backlogCount,
        currentTaskId: String(worker?.currentTaskId || ''),
    });
    return true;
}
// 返回 supervisor 状态文件路径。
function getSupervisorStateFile() {
    return path.join(SUPERVISOR_DIR, 'state.json');
}
// 构造独立 worker 的 Node 启动参数。
function buildWorkerLaunchSpec(type) {
    const normalized = String(type || 'daily');
    const maxOldSpaceMb = WORKER_MEMORY_LIMITS[normalized] || 512;
    return {
        type: normalized,
        name: `${normalized}-worker`,
        maxOldSpaceMb,
        command: process.execPath,
        args: [
            `--max-old-space-size=${maxOldSpaceMb}`,
            path.join(__dirname, 'worker-main.js'),
            '--type',
            normalized,
        ],
    };
}
// 写入 supervisor 当前状态，Dashboard 可直接读取。
function writeSupervisorState(state) {
    ensureDir(SUPERVISOR_DIR);
    const payload = { updatedAt: nowIso(), pid: process.pid, ...state };
    writeJsonAtomic(getSupervisorStateFile(), payload);
    return payload;
}
// 启动一个 worker 子进程；仅在调用方显式 start=true 时执行。
function startWorkerProcess(type) {
    const spec = buildWorkerLaunchSpec(type);
    const child = spawn(spec.command, spec.args, {
        cwd: process.cwd(),
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
    });
    rememberOwnedWorkerProcess(spec.name, child);
    child.unref();
    writeWorkerEvent('worker_process_started', { workerName: spec.name, type: spec.type, pid: child.pid, maxOldSpaceMb: spec.maxOldSpaceMb });
    return { ...spec, pid: child.pid };
}
// 只在同名 worker 没有活进程时补启动，避免 heartbeat 过期但 pid 仍活着时重复拉起。
function ensureWorkerProcesses(types = DEFAULT_WORKER_TYPES) {
    const workers = listWorkerStates();
    const previousSamples = getSupervisorWorkerSamples();
    const activeNames = new Set();
    for (const worker of workers) {
        const name = String(worker?.name || '');
        if (!name)
            continue;
        const pidAlive = isProcessAlive(worker?.pid);
        if (pidAlive) {
            if (isWorkerZombie(worker, previousSamples[name] || null)) {
                if (recoverZombieWorker(worker))
                    continue;
            }
            activeNames.add(name);
            if (!worker?.alive) {
                writeWorkerEvent('worker_process_suspected_blocked', {
                    workerName: name,
                    pid: worker?.pid,
                    heartbeatLagMs: worker?.heartbeatLagMs ?? null,
                    step: worker?.step || '',
                });
            }
            continue;
        }
        if (!worker?.pid && worker?.alive)
            activeNames.add(name);
    }
    const started = [];
    for (const type of types.map(item => String(item || '').trim()).filter(Boolean)) {
        const name = `${type}-worker`;
        if (activeNames.has(name))
            continue;
        try {
            started.push(startWorkerProcess(type));
        }
        catch (error) {
            writeWorkerEvent('worker_process_start_failed', {
                workerName: name,
                type,
                error: error instanceof Error ? error.message : String(error || 'start failed'),
            });
        }
    }
    return started;
}
// 检查 running 任务对应 worker 是否 stale，确认死亡时标记任务失败。
function auditStaleRunningTasks(staleMs = 30000) {
    const workers = listWorkerStates();
    const workerByName = {};
    for (const worker of workers)
        workerByName[String(worker.name || '')] = worker;
    const running = listResourceTasks({ statuses: ['running'], limit: 500 });
    let recovered = 0;
    for (const task of running) {
        const workerName = String(task.claimedBy || '');
        const worker = workerByName[workerName];
        const heartbeatAt = Date.parse(String(worker?.heartbeatAt || task.updatedAt || task.startedAt || ''));
        const stale = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleMs;
        const alive = worker && isProcessAlive(worker.pid);
        if (!stale || alive)
            continue;
        const next = failTask(task, new Error(`worker heartbeat stale: ${workerName}`), { reason: 'worker_stale' });
        if (String(next?.status || '') !== 'failed')
            continue;
        writeProcessCleanupEvent({ event: 'worker_stale_recovered', workerName, taskId: task.id, kind: task.kind, pid: worker?.pid || null });
        recovered++;
    }
    return recovered;
}
// 检查 claiming 任务对应 worker 是否 stale；仅回收无活 worker 且仍是唯一 claiming 副本的孤儿任务。
function auditStaleClaimingTasks(staleMs = 30000) {
    const workers = listWorkerStates();
    const workerByName = {};
    for (const worker of workers)
        workerByName[String(worker.name || '')] = worker;
    const claiming = listResourceTasks({ statuses: ['claiming'], limit: 500 });
    let recovered = 0;
    for (const task of claiming) {
        const workerName = String(task.claimedBy || '');
        const worker = workerByName[workerName];
        const heartbeatAt = Date.parse(String(worker?.heartbeatAt || task.updatedAt || task.claimedAt || ''));
        const stale = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleMs;
        const alive = worker && isProcessAlive(worker.pid);
        if (!stale || alive)
            continue;
        const next = failIsolatedClaimingTask(task, new Error(`worker claiming stale: ${workerName}`), { reason: 'claiming_stale' });
        if (String(next?.status || '') !== 'failed')
            continue;
        writeProcessCleanupEvent({ event: 'claiming_stale_recovered', workerName, taskId: task.id, kind: task.kind, pid: worker?.pid || null });
        recovered++;
    }
    return recovered;
}
// 复检 deferred 任务；资源恢复后搬回 pending，过期或被明确拒绝时失败落盘。
function auditDeferredTasks(limit = 500) {
    const deferred = listResourceTasks({ statuses: ['deferred'], limit });
    const restoreBudgetByKind = new Map();
    let restored = 0;
    let failed = 0;
    let kept = 0;
    for (const task of deferred) {
        if (isTaskExpired(task)) {
            const next = failTask(task, new Error('deferred task expired'), { reason: 'task_expired_while_deferred' });
            if (didDeferredTaskTransition(task, next, 'failed'))
                failed++;
            else
                kept++;
            continue;
        }
        const kind = String(task.kind || '');
        const restoreMaxActive = getDeferredRestoreMaxActive(kind);
        if (restoreMaxActive !== null) {
            let budget = restoreBudgetByKind.get(kind);
            if (!budget) {
                budget = {
                    maxActive: restoreMaxActive,
                    activeBacklog: getDeferredRestoreActiveBacklog(kind),
                };
                restoreBudgetByKind.set(kind, budget);
            }
            if (budget.activeBacklog >= budget.maxActive) {
                kept++;
                continue;
            }
        }
        const admission = decideAdmission({
            taskId: task.id,
            kind: task.kind,
            source: 'worker-supervisor-deferred-audit',
            channelKey: task.channelKey,
            userId: task.userId,
            exclusive: task.kind !== 'daily_summary',
            priority: task.priority,
            queueTimeoutMs: task.timeoutMs,
            runTimeoutMs: task.timeoutMs,
        }, readResourceSnapshot());
        if (canRestoreDeferredTask(String(admission.decision || ''))) {
            const next = requeueTask(task, `deferred restored: ${admission.reason || admission.decision}`);
            if (didDeferredTaskTransition(task, next, 'pending')) {
                restored++;
                const budget = restoreBudgetByKind.get(kind);
                if (budget)
                    budget.activeBacklog += 1;
            }
            else
                kept++;
            continue;
        }
        if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
            const next = failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision });
            if (didDeferredTaskTransition(task, next, 'failed'))
                failed++;
            else
                kept++;
            continue;
        }
        kept++;
    }
    if (restored || failed)
        writeWorkerEvent('deferred_tasks_audited', { restored, failed, kept, scanned: deferred.length });
    return { scanned: deferred.length, restored, failed, kept };
}
// 读取 supervisor 状态。
function getSupervisorStatus() {
    ensureDir(SUPERVISOR_DIR);
    let state = null;
    try {
        state = JSON.parse(fs.readFileSync(getSupervisorStateFile(), 'utf8'));
    }
    catch {
        state = null;
    }
    return {
        state,
        launchSpecs: ['daily', 'agent', 'media'].map(buildWorkerLaunchSpec),
        workers: listWorkerStates(),
    };
}
// 执行一次 supervisor 审计；start=true 时会补启动未存活 worker。
function runSupervisorOnce(options = {}) {
    const types = options.types && options.types.length ? options.types : DEFAULT_WORKER_TYPES;
    const previousSamples = getSupervisorWorkerSamples();
    const started = options.start ? ensureWorkerProcesses(types) : [];
    const staleRecovered = auditStaleRunningTasks();
    const staleClaimingRecovered = auditStaleClaimingTasks();
    const deferred = auditDeferredTasks();
    return writeSupervisorState({ started, staleRecovered, staleClaimingRecovered, deferred, workers: attachWorkerProgressSamples(listWorkerStates(), previousSamples) });
}
if (require.main === module) {
    const start = process.argv.includes('--start');
    const status = runSupervisorOnce({ start, once: true });
    console.log(JSON.stringify(status, null, 2));
}
module.exports = {
    buildWorkerLaunchSpec,
    startWorkerProcess,
    recoverZombieWorker,
    clearOwnedWorkerProcesses,
    ensureWorkerProcesses,
    auditStaleRunningTasks,
    auditStaleClaimingTasks,
    auditDeferredTasks,
    getSupervisorStatus,
    runSupervisorOnce,
};
