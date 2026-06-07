"use strict";
/**
 * MODULE: S2 worker supervisor。
 * 职责: 生成 worker 启动配置、记录 supervisor 状态、审计 stale running 任务。
 * 边界: 不执行系统级 kill，不实现 S9 扩容迁移。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { admitTask } = require('../resource-scheduler/admission');
const { SUPERVISOR_DIR } = require('./task-paths');
const { listWorkerStates, listResourceTasks, failTask, requeueTask, writeWorkerEvent } = require('./task-store');
const { ensureDir, isProcessAlive, nowIso, writeJsonAtomic } = require('../resource-common/files');
const { writeProcessCleanupEvent } = require('../resource-system/system-protection');
const WORKER_MEMORY_LIMITS = {
    daily: Number(process.env.RESOURCE_DAILY_WORKER_OLD_SPACE_MB || 768),
    agent: Number(process.env.RESOURCE_AGENT_WORKER_OLD_SPACE_MB || 768),
    media: Number(process.env.RESOURCE_MEDIA_WORKER_OLD_SPACE_MB || 512),
};
const DEFAULT_WORKER_TYPES = ['daily', 'agent', 'media'];
// 判断 deferred 任务是否已经超过自身有效期。
function isTaskExpired(task) {
    const expiresAt = Date.parse(String(task?.expiresAt || ''));
    return Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt;
}
// 判断 S1 决策是否代表任务可以回到 S2 pending 队列等待 worker 执行。
function canRestoreDeferredTask(decision) {
    return decision === 'run_now' || decision === 'queue' || decision === 'downgrade';
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
    child.unref();
    writeWorkerEvent('worker_process_started', { workerName: spec.name, type: spec.type, pid: child.pid, maxOldSpaceMb: spec.maxOldSpaceMb });
    return { ...spec, pid: child.pid };
}
// 只在同名 worker 没有活进程时补启动，避免 heartbeat 过期但 pid 仍活着时重复拉起。
function ensureWorkerProcesses(types = DEFAULT_WORKER_TYPES) {
    const workers = listWorkerStates();
    const activeNames = new Set();
    for (const worker of workers) {
        const name = String(worker?.name || '');
        if (!name)
            continue;
        const pidAlive = isProcessAlive(worker?.pid);
        if (pidAlive) {
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
        failTask(task, new Error(`worker heartbeat stale: ${workerName}`), { reason: 'worker_stale' });
        writeProcessCleanupEvent({ event: 'worker_stale_recovered', workerName, taskId: task.id, kind: task.kind, pid: worker?.pid || null });
        recovered++;
    }
    return recovered;
}
// 复检 deferred 任务；资源恢复后搬回 pending，过期或被明确拒绝时失败落盘。
function auditDeferredTasks(limit = 500) {
    const deferred = listResourceTasks({ statuses: ['deferred'], limit });
    let restored = 0;
    let failed = 0;
    let kept = 0;
    for (const task of deferred) {
        if (isTaskExpired(task)) {
            failTask(task, new Error('deferred task expired'), { reason: 'task_expired_while_deferred' });
            failed++;
            continue;
        }
        const admission = admitTask({
            taskId: task.id,
            kind: task.kind,
            source: 'worker-supervisor-deferred-audit',
            channelKey: task.channelKey,
            userId: task.userId,
            exclusive: task.kind !== 'daily_summary',
            priority: task.priority,
            queueTimeoutMs: task.timeoutMs,
            runTimeoutMs: task.timeoutMs,
        });
        if (canRestoreDeferredTask(String(admission.decision || ''))) {
            requeueTask(task, `deferred restored: ${admission.reason || admission.decision}`);
            restored++;
            continue;
        }
        if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
            failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision });
            failed++;
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
    const started = options.start ? ensureWorkerProcesses(types) : [];
    const staleRecovered = auditStaleRunningTasks();
    const deferred = auditDeferredTasks();
    return writeSupervisorState({ started, staleRecovered, deferred, workers: listWorkerStates() });
}
if (require.main === module) {
    const start = process.argv.includes('--start');
    const status = runSupervisorOnce({ start, once: true });
    console.log(JSON.stringify(status, null, 2));
}
module.exports = {
    buildWorkerLaunchSpec,
    startWorkerProcess,
    ensureWorkerProcesses,
    auditStaleRunningTasks,
    auditDeferredTasks,
    getSupervisorStatus,
    runSupervisorOnce,
};
