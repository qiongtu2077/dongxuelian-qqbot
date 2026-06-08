'use strict';
/**
 * MODULE: Dashboard 资源中心路由。
 * 职责: 读取 S0-S8 资源状态，并提供受控管理操作。
 * 边界: 不重新推理业务准入，不直接执行重任务。
 */
const fs = require('fs');
const path = require('path');
const { json, collectBody, parsePositiveInt, readFileSyncSafe, writeFileSyncSafe } = require('../utils');
const { requireAdmin } = require('../auth');
const { AI_LIB, DATA_DIR } = require('../paths');
const RESOURCE_EVENT_LIMIT = parsePositiveInt(process.env.DASHBOARD_RESOURCE_EVENT_LIMIT, 120, 20, 500);
const RESOURCE_TASK_LIMIT = parsePositiveInt(process.env.DASHBOARD_RESOURCE_TASK_LIMIT, 120, 20, 500);
const MAINTENANCE_FILE = path.join(DATA_DIR, 'ai-paused.txt');
// 动态加载 AI 资源模块，避免 Dashboard 编译期反向依赖源码。
function loadResourceModules() {
    return {
        gate: require(path.join(AI_LIB, 'resource-gate', 'gate')),
        scheduler: require(path.join(AI_LIB, 'resource-scheduler', 'resource-snapshot')),
        tasks: require(path.join(AI_LIB, 'resource-workers', 'task-store')),
        precompute: require(path.join(AI_LIB, 'daily-precompute', 'precompute-status')),
        media: require(path.join(AI_LIB, 'media', 'backpressure', 'media-queue')),
        system: require(path.join(AI_LIB, 'resource-system', 'system-protection')),
        files: require(path.join(AI_LIB, 'resource-common', 'files')),
    };
}
// 将任务 payload 从 Dashboard 响应中移除，避免泄露上下文和文件内容。
function sanitizeTask(task) {
    const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {};
    return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        source: task.source,
        channelKey: task.channelKey,
        userId: task.userId,
        priority: task.priority,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        expiresAt: task.expiresAt,
        timeoutMs: task.timeoutMs,
        step: task.step,
        claimedBy: task.claimedBy,
        claimedAt: task.claimedAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        notify: task.notify,
        error: task.error,
        payloadKeys: Object.keys(payload),
    };
}
// 读取跨 S0-S8 的最近事件，供资源中心统一显示。
function collectResourceEvents(mods, limit = RESOURCE_EVENT_LIMIT) {
    const events = [];
    const read = (dir, prefix, source) => {
        for (const event of mods.files.readRecentJsonlEvents(dir, prefix, limit)) {
            const item = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
            events.push({
                ...item,
                source,
                resourceSource: source,
                businessSource: item.source,
            });
        }
    };
    read(mods.gate.GATE_ROOT, 'events-', 'S0');
    read(mods.scheduler.SCHEDULER_ROOT, 'admissions-', 'S1');
    read(path.join(DATA_DIR, 'resource-workers'), 'events-', 'S2');
    read(mods.precompute.PRECOMPUTE_ROOT, 'events-', 'S3');
    read(mods.media.MEDIA_ROOT, 'events-', 'S6');
    read(mods.system.RESOURCE_SYSTEM_ROOT, 'memory-alerts-', 'S8');
    read(mods.system.RESOURCE_SYSTEM_ROOT, 'process-cleanup-', 'S8');
    events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return events.slice(0, limit);
}
// 合成资源中心总览状态。
function buildResourceStatus(mods) {
    const snapshot = mods.scheduler.readResourceSnapshot();
    const gate = mods.gate.getResourceGateStatus();
    const queue = mods.tasks.getTaskQueueSummary();
    const workers = mods.tasks.listWorkerStates();
    const media = mods.media.getMediaBackpressureStatus();
    const precompute = mods.precompute.getPrecomputeSummary();
    const system = mods.system.getSystemProtectionStatus();
    return {
        ok: true,
        mode: snapshot.botMode,
        resourceState: snapshot.resourceState,
        memAvailableMb: snapshot.memAvailableMb,
        memTotalMb: snapshot.memTotalMb,
        memSource: snapshot.memSource || '',
        running: gate.meta ? {
            taskId: gate.meta.taskId,
            kind: gate.meta.kind,
            step: gate.meta.step,
            owner: gate.meta.owner,
            channelKey: gate.meta.channelKey,
            userId: gate.meta.userId,
            startedAt: gate.meta.startedAt,
            heartbeatAt: gate.meta.heartbeatAt,
            memAvailableMb: gate.meta.memAvailableMb,
        } : null,
        gate,
        queue,
        queueLength: Number(queue.pending || 0),
        workers,
        media,
        precompute: {
            coverageCount: precompute.coverageCount,
            slotCount: precompute.slotCount,
            coverage: Array.isArray(precompute.coverage) ? precompute.coverage.slice(0, 12) : [],
        },
        system,
        maintenance: !!readFileSyncSafe(MAINTENANCE_FILE),
        events: collectResourceEvents(mods, 40),
    };
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || 'unknown error');
}
// GET /resource/status：返回资源中心总览。
function handleGetResourceStatus(req, res) {
    try {
        return json(res, buildResourceStatus(loadResourceModules()));
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// GET /resource/tasks：返回脱敏任务列表。
function handleGetResourceTasks(req, res, pathname, url) {
    if (!requireAdmin(req, res))
        return;
    try {
        const mods = loadResourceModules();
        const status = String(url.searchParams.get('status') || '').trim();
        const limit = parsePositiveInt(url.searchParams.get('limit'), RESOURCE_TASK_LIMIT, 1, 500);
        const statuses = status ? status.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
        const tasks = mods.tasks.listResourceTasks({ statuses, limit }).map(sanitizeTask);
        return json(res, { ok: true, tasks });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// GET /resource/events：返回最近资源事件。
function handleGetResourceEvents(req, res, pathname, url) {
    if (!requireAdmin(req, res))
        return;
    try {
        const mods = loadResourceModules();
        const limit = parsePositiveInt(url.searchParams.get('limit'), RESOURCE_EVENT_LIMIT, 1, 500);
        return json(res, { ok: true, events: collectResourceEvents(mods, limit) });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// GET /resource/workers：返回 worker 心跳。
function handleGetResourceWorkers(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        return json(res, { ok: true, workers: loadResourceModules().tasks.listWorkerStates() });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// GET /resource/media：返回媒体背压状态。
function handleGetResourceMedia(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        return json(res, { ok: true, media: loadResourceModules().media.getMediaBackpressureStatus() });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// GET /resource/precompute：返回日报预计算状态。
function handleGetResourcePrecompute(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        return json(res, { ok: true, precompute: loadResourceModules().precompute.getPrecomputeSummary() });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
// POST /resource/cancel：取消 pending/deferred 任务。
function handlePostResourceCancel(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const data = JSON.parse(body || '{}');
            const taskId = String(data.taskId || '').trim();
            if (!taskId)
                return json(res, { ok: false, message: 'taskId 不能为空' }, 400);
            const ok = loadResourceModules().tasks.cancelTask(taskId, 'dashboard', String(data.reason || 'dashboard cancel'));
            return json(res, { ok, message: ok ? '任务已取消' : '只能取消 pending/deferred 任务' }, ok ? 200 : 404);
        }
        catch (e) {
            return json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
// POST /resource/reclaim-stale：回收已确认 stale 的 S0 锁。
function handlePostResourceReclaimStale(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const data = JSON.parse(body || '{}');
            const staleMs = parsePositiveInt(data.staleMs, 30000, 5000, 10 * 60 * 1000);
            const mods = loadResourceModules();
            const reclaimed = mods.gate.reclaimStaleLock(staleMs, 'dashboard');
            return json(res, { ok: true, reclaimed, status: mods.gate.getResourceGateStatus(staleMs) });
        }
        catch (e) {
            return json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
// POST /resource/maintenance：切换同一份 ai-paused.txt 维护模式。
function handlePostResourceMaintenance(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const data = JSON.parse(body || '{}');
            if (data.enabled)
                writeFileSyncSafe(MAINTENANCE_FILE, String(data.message || '优化中，别急'));
            else
                try {
                    fs.unlinkSync(MAINTENANCE_FILE);
                }
                catch { /* non-critical: missing maintenance file is already disabled */ }
            return json(res, { ok: true, enabled: !!data.enabled, message: data.enabled ? '维护模式已开启' : '维护模式已关闭' });
        }
        catch (e) {
            return json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
const routes = {
    'GET /dashboard/api/resource/status': handleGetResourceStatus,
    'GET /dashboard/api/resource/tasks': handleGetResourceTasks,
    'GET /dashboard/api/resource/events': handleGetResourceEvents,
    'GET /dashboard/api/resource/workers': handleGetResourceWorkers,
    'GET /dashboard/api/resource/media': handleGetResourceMedia,
    'GET /dashboard/api/resource/precompute': handleGetResourcePrecompute,
    'POST /dashboard/api/resource/cancel': handlePostResourceCancel,
    'POST /dashboard/api/resource/reclaim-stale': handlePostResourceReclaimStale,
    'POST /dashboard/api/resource/maintenance': handlePostResourceMaintenance,
};
module.exports = { routes, buildResourceStatus, sanitizeTask };
