"use strict";
/**
 * MODULE: 资源活跃租约。
 * 职责: 提供短 TTL 文件租约，协调浏览器类重任务的短时互斥。
 * 边界: 不接管 S0/S1/S2，不保存长期队列，不扩展为通用资源控制中心。
 */
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { ensureDir, isProcessAlive, nowIso, readJsonFile, removePath, sanitizeId, writeJsonAtomic, } = require('../resource-common/files');
const serverModePolicy = require('./server-mode-policy');
const ACTIVITY_ROOT = path.join(DATA_DIR, 'resource-activity');
const DEFAULT_TOOL_TTL_MS = 3 * 60 * 1000;
const DEFAULT_RENDER_TTL_MS = 10 * 60 * 1000;
const CONFLICTING_ACTIVITY_LEASES = {
    tool_active: ['render_active'],
    render_active: ['tool_active'],
};
function getResourceActivityLeaseFile(kind) {
    return path.join(ACTIVITY_ROOT, `${sanitizeId(kind)}.json`);
}
function getDefaultResourceActivityLeaseTtl(kind) {
    return kind === 'render_active' ? DEFAULT_RENDER_TTL_MS : DEFAULT_TOOL_TTL_MS;
}
function normalizeResourceActivityLeaseTtl(kind, ttlMs) {
    const fallback = getDefaultResourceActivityLeaseTtl(kind);
    const value = Number(ttlMs);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(5 * 1000, Math.min(30 * 60 * 1000, Math.round(value)));
}
function isResourceActivityLeaseExpired(meta, nowMs = Date.now()) {
    const expiresAt = Date.parse(String(meta?.expiresAt || ''));
    return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}
function cleanupStaleResourceActivityLease(kind) {
    const file = getResourceActivityLeaseFile(kind);
    const meta = readJsonFile(file, null);
    if (!meta)
        return null;
    if (!isResourceActivityLeaseExpired(meta) && isProcessAlive(meta.pid))
        return meta;
    removePath(file);
    return null;
}
function readResourceActivityLease(kind) {
    ensureDir(ACTIVITY_ROOT);
    return cleanupStaleResourceActivityLease(kind);
}
function hasActiveResourceActivityLease(kind) {
    return !!readResourceActivityLease(kind);
}
function findBlockingResourceActivityLease(kind) {
    const strictMutualExclusion = typeof serverModePolicy.readResourceActivityMutualExclusionState === 'function'
        ? !!serverModePolicy.readResourceActivityMutualExclusionState().strictActivityMutualExclusion
        : String(serverModePolicy.readServerModeConfig?.().serverMode || 'large').trim().toLowerCase() === 'small';
    if (!strictMutualExclusion)
        return null;
    const conflictKinds = CONFLICTING_ACTIVITY_LEASES[String(kind)] || [];
    for (const conflictKind of conflictKinds) {
        const blocking = readResourceActivityLease(conflictKind);
        if (blocking)
            return blocking;
    }
    return null;
}
function buildResourceActivityLeaseBlockReason(kind, blocking) {
    if (!blocking)
        return `${String(kind || 'resource_activity')} blocked`;
    return `${String(kind || 'resource_activity')} blocked by ${String(blocking.kind || 'unknown')} (${String(blocking.owner || blocking.taskId || blocking.pid || 'unknown')})`;
}
function acquireResourceActivityLease(kind, options = {}) {
    ensureDir(ACTIVITY_ROOT);
    const blocking = findBlockingResourceActivityLease(kind);
    if (blocking)
        throw new Error(buildResourceActivityLeaseBlockReason(kind, blocking));
    const file = getResourceActivityLeaseFile(kind);
    const existing = readResourceActivityLease(kind);
    if (existing)
        throw new Error(buildResourceActivityLeaseBlockReason(kind, existing));
    const ttlMs = normalizeResourceActivityLeaseTtl(kind, options.ttlMs);
    const createdAt = nowIso();
    const meta = {
        leaseId: `${sanitizeId(kind)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        owner: String(options.owner || 'unknown'),
        taskId: String(options.taskId || ''),
        pid: process.pid,
        createdAt,
        heartbeatAt: createdAt,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        ttlMs,
    };
    writeJsonAtomic(file, meta);
    let released = false;
    return (reason = 'completed') => {
        void reason;
        if (released)
            return;
        released = true;
        const current = readJsonFile(file, null);
        if (current && current.leaseId === meta.leaseId)
            removePath(file);
    };
}
module.exports = {
    ACTIVITY_ROOT,
    readResourceActivityLease,
    hasActiveResourceActivityLease,
    findBlockingResourceActivityLease,
    buildResourceActivityLeaseBlockReason,
    acquireResourceActivityLease,
};
