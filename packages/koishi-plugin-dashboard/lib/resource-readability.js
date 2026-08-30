"use strict";
/**
 * MODULE: 资源中心可读状态判定。
 * 职责: 基于后端事实生成处理器健康、后台暂停和媒体队列风险状态码。
 * 边界: 不翻译界面文案，不读取文件，不改变调度状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkerType = resolveWorkerType;
exports.buildBackgroundPauseReasons = buildBackgroundPauseReasons;
exports.buildReadableWorkers = buildReadableWorkers;
exports.resolveMediaRisk = resolveMediaRisk;
exports.buildMediaRisk = buildMediaRisk;
exports.buildResourceReadability = buildResourceReadability;
const WORKER_STALL_MS = 15 * 60 * 1000;
const WORKER_KINDS = {
    agent: [
        'agent_task',
        'dashboard_agent',
        'agent_memory',
        'agent_memory_compaction',
        'conversation_summary',
        'sensitive_cache_analysis',
    ],
    daily: ['daily_report', 'daily_summary', 'emotion_render'],
};
const MEDIA_RISK_SEVERITY = {
    idle: 0,
    queued: 1,
    near_limit: 2,
    at_limit: 3,
};
// --- 基础解析 --- //
// 将未知数值收敛为非负整数计数。
function countValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
// 从 worker kind 或稳定名称解析三类已知处理器。
function resolveWorkerType(worker) {
    const explicit = String(worker.kind || '').trim().toLowerCase();
    const name = String(worker.name || '').trim().toLowerCase();
    const candidate = explicit || (name.endsWith('-worker') ? name.slice(0, -7) : name);
    return candidate === 'agent' || candidate === 'daily' || candidate === 'media' ? candidate : 'unknown';
}
// 返回全局后台当前成立的全部暂停原因。
function buildBackgroundPauseReasons(snapshot) {
    const reasons = [];
    if (snapshot.maintenance === true || String(snapshot.botMode || '') === 'maintenance')
        reasons.push('maintenance');
    if (String(snapshot.resourceState || '') === 'red')
        reasons.push('resource_critical');
    if (snapshot.backgroundAllowed === false && snapshot.toolActive === true)
        reasons.push('browser_active');
    if (snapshot.backgroundAllowed === false && snapshot.renderActive === true)
        reasons.push('daily_render_active');
    return reasons;
}
// --- 处理器状态 --- //
// 统计资源任务中可立即处理、稍后重试和正在执行的数量。
function countResourceWorkerTasks(workerType, tasks) {
    const kinds = new Set(WORKER_KINDS[workerType]);
    const owned = tasks.filter(task => kinds.has(String(task.kind || '')));
    return {
        readyCount: owned.filter(task => String(task.status || '') === 'pending').length,
        deferredCount: owned.filter(task => String(task.status || '') === 'deferred').length,
        runningCount: owned.filter(task => ['claiming', 'running'].includes(String(task.status || ''))).length,
    };
}
// 统计媒体处理器三类队列的当前数量。
function countMediaWorkerTasks(media) {
    const queues = media.queues && typeof media.queues === 'object' && !Array.isArray(media.queues)
        ? media.queues
        : {};
    const kinds = ['image', 'file', 'voice'];
    return kinds.reduce((result, kind) => {
        const queue = queues[kind] && typeof queues[kind] === 'object' && !Array.isArray(queues[kind])
            ? queues[kind]
            : {};
        result.readyCount += countValue(queue.readyCount);
        result.deferredCount += countValue(queue.deferredCount);
        result.runningCount += countValue(queue.runningCount);
        return result;
    }, { readyCount: 0, deferredCount: 0, runningCount: 0 });
}
// 查找处理器当前运行的资源任务，不向总览带出任务 payload。
function findWorkerRunningTask(worker, workerType, tasks) {
    if (workerType === 'media' || workerType === 'unknown')
        return null;
    const currentTaskId = String(worker.currentTaskId || worker.taskId || '');
    const workerName = String(worker.name || '');
    return tasks.find(task => String(task.status || '') === 'running' && ((currentTaskId && String(task.id || '') === currentTaskId)
        || (!currentTaskId && workerName && String(task.claimedBy || '') === workerName))) || null;
}
// 只保留处理器诊断详情需要的安全任务字段。
function sanitizeRunningTask(task) {
    if (!task)
        return null;
    return {
        id: task.id || '',
        kind: task.kind || '',
        status: task.status || '',
        step: task.step || '',
        claimedBy: task.claimedBy || '',
        startedAt: task.startedAt || '',
        timeoutMs: task.timeoutMs ?? null,
    };
}
// 返回某处理器自身当前成立的全部自动恢复暂停原因。
function buildWorkerPauseReasons(worker, workerType, snapshot, globalReasons) {
    const reasons = new Set(globalReasons);
    if (worker.parked === true && snapshot.toolActive === true && (workerType === 'media' || workerType === 'daily')) {
        reasons.add('browser_active');
    }
    if (worker.parked === true && snapshot.renderActive === true)
        reasons.add('daily_render_active');
    return Array.from(reasons);
}
// 按计划固定的严重程度顺序选择处理器主健康状态。
function resolveWorkerHealthCode(worker, counts, runningTask, pauseReasons, resolveTaskTimeoutMs, now) {
    const backlog = counts.readyCount + counts.deferredCount;
    const startedAt = Date.parse(String(runningTask?.startedAt || worker.currentTaskStartedAt || ''));
    if (runningTask && Number.isFinite(startedAt) && now - startedAt > resolveTaskTimeoutMs(runningTask))
        return 'task_timeout';
    if (worker.alive !== true && backlog > 0)
        return 'stopped_backlog';
    const progressAt = Date.parse(String(worker.loopChangedAt || worker.lastClaimAttemptAt || worker.heartbeatAt || ''));
    if (worker.alive === true && backlog > 0 && (!Number.isFinite(progressAt) || now - progressAt > WORKER_STALL_MS))
        return 'stalled';
    if (pauseReasons.length > 0 || worker.parked === true)
        return 'paused_auto_resume';
    if (counts.runningCount > 0 || runningTask)
        return 'working';
    return worker.alive === true ? 'idle' : 'stopped_idle';
}
// 为每个已登记处理器补充稳定健康码、暂停原因和分口径积压数量。
function buildReadableWorkers(input, globalReasons) {
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    return input.workers.map(worker => {
        const workerType = resolveWorkerType(worker);
        const counts = workerType === 'media'
            ? countMediaWorkerTasks(input.media)
            : workerType === 'agent' || workerType === 'daily'
                ? countResourceWorkerTasks(workerType, input.tasks)
                : { readyCount: 0, deferredCount: 0, runningCount: 0 };
        const runningTask = findWorkerRunningTask(worker, workerType, input.tasks);
        const workerPauseReasons = buildWorkerPauseReasons(worker, workerType, input.snapshot, globalReasons);
        const workerHealthCode = resolveWorkerHealthCode(worker, counts, runningTask, workerPauseReasons, input.resolveTaskTimeoutMs, now);
        return {
            ...worker,
            workerType,
            workerHealthCode,
            workerPauseReasons,
            readyCount: counts.readyCount,
            deferredCount: counts.deferredCount,
            backlogTotal: counts.readyCount + counts.deferredCount,
            runningCount: counts.runningCount,
            currentTask: sanitizeRunningTask(runningTask),
        };
    });
}
// --- 媒体队列风险 --- //
// 根据单类队列占用比例生成媒体风险状态码。
function resolveMediaRisk(queueTotal, queueLimit) {
    const total = countValue(queueTotal);
    const limit = countValue(queueLimit);
    if (total === 0)
        return 'idle';
    if (limit > 0 && total >= limit)
        return 'at_limit';
    if (limit > 0 && total >= Math.ceil(limit * 0.8))
        return 'near_limit';
    return 'queued';
}
// 为三类媒体队列生成各自风险与整体最严重状态。
function buildMediaRisk(media) {
    const queues = media.queues && typeof media.queues === 'object' && !Array.isArray(media.queues)
        ? media.queues
        : {};
    const mediaRiskByKind = {};
    for (const kind of ['image', 'file', 'voice']) {
        const queue = queues[kind] && typeof queues[kind] === 'object' && !Array.isArray(queues[kind])
            ? queues[kind]
            : {};
        mediaRiskByKind[kind] = resolveMediaRisk(queue.queueTotal, queue.queueLimit);
    }
    const mediaRiskCode = Object.values(mediaRiskByKind)
        .reduce((worst, code) => MEDIA_RISK_SEVERITY[code] > MEDIA_RISK_SEVERITY[worst] ? code : worst, 'idle');
    const mediaRiskKinds = Object.entries(mediaRiskByKind)
        .filter(([, code]) => code === mediaRiskCode)
        .map(([kind]) => kind);
    return { mediaRiskByKind, mediaRiskCode, mediaRiskKinds };
}
// --- 总览组装 --- //
// 构建资源总览接口需要附加的全部稳定可读状态码。
function buildResourceReadability(input) {
    const backgroundPauseReasons = buildBackgroundPauseReasons(input.snapshot);
    return {
        backgroundPauseReasons,
        workers: buildReadableWorkers(input, backgroundPauseReasons),
        ...buildMediaRisk(input.media),
    };
}
