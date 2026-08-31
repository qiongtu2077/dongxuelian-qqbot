"use strict";
/**
 * MODULE: S0 全局资源闸门。
 * 职责: 提供跨进程 ticket、公平获取独占锁、心跳、stale 回收和可定位的存储故障。
 * 边界: 不保存长期业务队列，长期任务状态归 S2。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { isProcessAlive, nowIso, sanitizeId } = require('../resource-common/files');
const GATE_ROOT = path.join(DATA_DIR, 'resource-gate');
const LOCK_DIR = path.join(GATE_ROOT, 'lock');
const LOCK_META_FILE = path.join(LOCK_DIR, 'meta.json');
const TICKETS_DIR = path.join(GATE_ROOT, 'tickets');
const DEFAULT_STALE_MS = Number(process.env.RESOURCE_GATE_STALE_MS || 30000);
const DEFAULT_WAIT_TIMEOUT_MS = Number(process.env.RESOURCE_GATE_WAIT_TIMEOUT_MS || 600000);
const DEFAULT_POLL_MS = Number(process.env.RESOURCE_GATE_POLL_MS || 1000);
const MAX_GATE_JSON_BYTES = 2 * 1024 * 1024;
// --- 结构化错误与安全路径 ---
// 携带资源锁内部分类、系统 errno、失败步骤和脱敏相对路径。
class ResourceGateStorageError extends Error {
    // 保存调用方可稳定判断的结构化故障字段。
    constructor(failureCode, errno, stage, safePath, cause) {
        super(`${failureCode}: ${stage} (${errno || 'UNKNOWN'}) at ${safePath || '.'}`);
        this.name = 'ResourceGateStorageError';
        this.failureCode = failureCode;
        this.errno = errno || 'UNKNOWN';
        this.stage = stage || 'unknown';
        this.safePath = safePath || '.';
        if (cause !== undefined)
            Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    }
}
// 表示 S0 状态健康但在等待窗口内未取得锁的普通竞争结果。
class ResourceGateBusyTimeoutError extends Error {
    // 保存已完成票据清理的普通竞争超时证据。
    constructor(ticketId, waitTimeoutMs) {
        super(`resource gate busy timeout (${waitTimeoutMs}ms)`);
        this.code = 'gate_busy_timeout';
        this.name = 'ResourceGateBusyTimeoutError';
        this.ticketId = ticketId;
    }
}
// 将资源锁绝对路径压缩为 GATE_ROOT 下的安全相对路径。
function toSafeGatePath(target) {
    const relative = path.relative(GATE_ROOT, path.resolve(target)).replace(/\\/g, '/');
    if (!relative)
        return '.';
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        return '[outside-gate-root]';
    return relative.replace(/[^a-zA-Z0-9._/-]/g, '_').slice(0, 240);
}
// 从 Node 系统错误中提取稳定 errno，没有 errno 时使用 UNKNOWN。
function getGateErrno(error) {
    const code = error && typeof error === 'object' ? error.code : '';
    return typeof code === 'string' && code.trim() ? code.trim() : 'UNKNOWN';
}
// 按计划规定的 errno 映射生成资源锁结构化存储故障。
function classifyGateStorageError(error, stage, target, forcedCode) {
    if (error instanceof ResourceGateStorageError)
        return error;
    const errno = getGateErrno(error);
    let failureCode = forcedCode || 'gate_state_unreadable';
    if (!forcedCode) {
        if (errno === 'EACCES' || errno === 'EPERM')
            failureCode = 'gate_permission_denied';
        else if (errno === 'EROFS')
            failureCode = 'gate_readonly_filesystem';
        else if (errno === 'ENOSPC')
            failureCode = 'gate_storage_full';
        else if (errno === 'EDQUOT')
            failureCode = 'gate_quota_exceeded';
        else if (errno === 'ENOTDIR' || errno === 'EISDIR' || errno === 'EEXIST')
            failureCode = 'gate_path_invalid';
        else if (errno === 'EMFILE' || errno === 'ENFILE')
            failureCode = 'gate_fd_exhausted';
        else if (errno === 'EIO')
            failureCode = 'gate_io_error';
    }
    return new ResourceGateStorageError(failureCode, errno, stage, toSafeGatePath(target), error);
}
// 判断错误是否为调用方必须停止入队的资源锁存储故障。
function isResourceGateStorageError(error) {
    return error instanceof ResourceGateStorageError || !!(error && typeof error === 'object'
        && typeof error.failureCode === 'string'
        && String(error.failureCode).startsWith('gate_'));
}
// --- 精确文件操作 ---
// 返回当天 S0 事件日志路径。
function gateEventFile(date = new Date()) {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(GATE_ROOT, `events-${stamp}.jsonl`);
}
// 精确判断路径是否存在，仅将 ENOENT 视为不存在。
function gatePathExists(target, stage) {
    try {
        fs.lstatSync(target);
        return true;
    }
    catch (error) {
        if (getGateErrno(error) === 'ENOENT')
            return false;
        throw classifyGateStorageError(error, stage, target);
    }
}
// 创建资源锁目录，任何文件系统错误都转换为结构化故障。
function ensureGateDirectory(target, stage) {
    try {
        fs.mkdirSync(target, { recursive: true });
    }
    catch (error) {
        throw classifyGateStorageError(error, stage, target);
    }
}
// 初始化 S0 运行目录。
function ensureGateDirs() {
    ensureGateDirectory(GATE_ROOT, 'ensure_gate_root');
    ensureGateDirectory(TICKETS_DIR, 'ensure_tickets_dir');
}
// 原子写入资源锁 JSON，并在失败时清理刚创建的临时文件。
function writeGateJsonAtomic(target, data, stage) {
    ensureGateDirectory(path.dirname(target), `${stage}_ensure_parent`);
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temporary, target);
    }
    catch (error) {
        try {
            if (gatePathExists(temporary, `${stage}_temporary_exists`))
                fs.rmSync(temporary, { force: true });
        }
        catch (cleanupError) {
            throw classifyGateStorageError(cleanupError, `${stage}_temporary_cleanup`, temporary, 'gate_cleanup_failed');
        }
        throw classifyGateStorageError(error, stage, target);
    }
}
// 读取可选资源锁 JSON，仅缺失返回 null，存在但不可读或结构非法时抛错。
function readGateJson(target, stage, validate) {
    let stat;
    try {
        stat = fs.statSync(target);
    }
    catch (error) {
        if (getGateErrno(error) === 'ENOENT')
            return null;
        throw classifyGateStorageError(error, stage, target);
    }
    if (!stat.isFile() || stat.size > MAX_GATE_JSON_BYTES) {
        throw new ResourceGateStorageError('gate_state_unreadable', 'INVALID_STATE', stage, toSafeGatePath(target));
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    catch (error) {
        throw classifyGateStorageError(error, stage, target, 'gate_state_unreadable');
    }
    if (!validate(parsed))
        throw new ResourceGateStorageError('gate_state_unreadable', 'INVALID_STATE', stage, toSafeGatePath(target));
    return parsed;
}
// 删除资源锁路径并复核确实不存在，失败统一归类为残留清理失败。
function removeGatePath(target, stage) {
    if (!gatePathExists(target, `${stage}_exists`))
        return false;
    try {
        fs.rmSync(target, { recursive: true, force: true });
    }
    catch (error) {
        throw classifyGateStorageError(error, stage, target, 'gate_cleanup_failed');
    }
    if (gatePathExists(target, `${stage}_verify`)) {
        throw new ResourceGateStorageError('gate_cleanup_failed', 'TARGET_REMAINS', stage, toSafeGatePath(target));
    }
    return true;
}
// 写入 S0 事件，事件文件故障单独归类，避免被误判为普通锁忙。
function writeGateEvent(event, data = {}) {
    const target = gateEventFile();
    try {
        ensureGateDirectory(path.dirname(target), 'gate_event_ensure_dir');
        const payload = { createdAt: nowIso(), event, ...data };
        fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, 'utf8');
    }
    catch (error) {
        throw classifyGateStorageError(error, 'gate_event_write', target, 'gate_event_write_failed');
    }
}
// --- Ticket 与锁状态 ---
// 生成 ticket 文件路径。
function getTicketFile(ticketId) {
    return path.join(TICKETS_DIR, `${sanitizeId(ticketId)}.json`);
}
// 验证从磁盘读取的 ticket 具备队列排序和归属所需字段。
function isResourceGateTicket(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const ticket = value;
    return typeof ticket.ticketId === 'string' && !!ticket.ticketId
        && typeof ticket.taskId === 'string' && !!ticket.taskId
        && typeof ticket.kind === 'string' && !!ticket.kind
        && typeof ticket.pid === 'number' && Number.isFinite(ticket.pid)
        && typeof ticket.createdAt === 'string' && !!ticket.createdAt;
}
// 验证从磁盘读取的锁元数据具备所有权和 stale 判断所需字段。
function isResourceGateLockMeta(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const meta = value;
    return typeof meta.taskId === 'string' && !!meta.taskId
        && typeof meta.kind === 'string' && !!meta.kind
        && typeof meta.ticketId === 'string' && !!meta.ticketId
        && typeof meta.pid === 'number' && Number.isFinite(meta.pid)
        && typeof meta.startedAt === 'string' && typeof meta.heartbeatAt === 'string';
}
// 创建短生命周期 ticket；事件写入失败时立即回滚票据文件。
function createTicket(input) {
    ensureGateDirs();
    const ticket = {
        ticketId: `${sanitizeId(input.kind)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: sanitizeId(input.taskId),
        kind: input.kind,
        owner: String(input.owner || 'unknown'),
        channelKey: String(input.channelKey || ''),
        userId: String(input.userId || ''),
        priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
        timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : DEFAULT_WAIT_TIMEOUT_MS,
        pid: process.pid,
        createdAt: nowIso(),
    };
    const ticketFile = getTicketFile(ticket.ticketId);
    writeGateJsonAtomic(ticketFile, ticket, 'ticket_write');
    try {
        writeGateEvent('ticket_created', { ticketId: ticket.ticketId, taskId: ticket.taskId, kind: ticket.kind, priority: ticket.priority });
    }
    catch (error) {
        removeGatePath(ticketFile, 'ticket_event_rollback');
        throw error;
    }
    return ticket;
}
// 读取全部 ticket 并按优先级、创建时间排序；非法记录视为存储状态故障。
function listTickets() {
    ensureGateDirs();
    let names;
    try {
        names = fs.readdirSync(TICKETS_DIR).filter(name => name.endsWith('.json')).sort();
    }
    catch (error) {
        throw classifyGateStorageError(error, 'ticket_list', TICKETS_DIR);
    }
    const tickets = names.map(name => readGateJson(path.join(TICKETS_DIR, name), 'ticket_read', isResourceGateTicket))
        .filter((ticket) => ticket !== null);
    tickets.sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50) || String(a.createdAt).localeCompare(String(b.createdAt)));
    return tickets;
}
// 删除指定 ticket 并复核无残留。
function removeTicket(ticketId) {
    removeGatePath(getTicketFile(ticketId), 'ticket_cleanup');
}
// 读取当前锁元数据；仅锁文件不存在时返回 null。
function readLockMeta() {
    const meta = readGateJson(LOCK_META_FILE, 'lock_meta_read', isResourceGateLockMeta);
    if (!meta && gatePathExists(LOCK_DIR, 'lock_dir_without_meta_check')) {
        throw new ResourceGateStorageError('gate_state_unreadable', 'MISSING_LOCK_META', 'lock_meta_read', toSafeGatePath(LOCK_META_FILE));
    }
    return meta;
}
// 判断当前 ticket 是否排在队头。
function isTicketHead(ticketId) {
    const head = listTickets()[0];
    return !!head && head.ticketId === ticketId;
}
// 先在同级候选目录完整写入元数据，再原子发布正式锁目录，避免暴露无 meta 的正常建锁窗口。
function tryCreateLock(ticket, input) {
    const candidateDir = path.join(GATE_ROOT, `.lock-candidate-${sanitizeId(ticket.ticketId)}-${Math.random().toString(36).slice(2, 8)}`);
    try {
        fs.mkdirSync(candidateDir);
    }
    catch (error) {
        throw classifyGateStorageError(error, 'lock_candidate_create', candidateDir);
    }
    const meta = {
        taskId: ticket.taskId,
        kind: ticket.kind,
        owner: String(ticket.owner || input.owner || 'unknown'),
        pid: process.pid,
        channelKey: String(ticket.channelKey || input.channelKey || ''),
        userId: String(ticket.userId || input.userId || ''),
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
        step: String(input.step || 'starting'),
        memAvailableMb: input.memAvailableMb === undefined ? null : Number(input.memAvailableMb),
        timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : DEFAULT_WAIT_TIMEOUT_MS,
        ticketId: ticket.ticketId,
    };
    let published = false;
    try {
        writeGateJsonAtomic(path.join(candidateDir, 'meta.json'), meta, 'lock_meta_write');
        if (gatePathExists(LOCK_DIR, 'lock_publish_precheck')) {
            readLockMeta();
            removeGatePath(candidateDir, 'lock_candidate_competition_cleanup');
            return null;
        }
        try {
            fs.renameSync(candidateDir, LOCK_DIR);
            published = true;
        }
        catch (error) {
            const lockExists = gatePathExists(LOCK_DIR, 'lock_publish_existing_check');
            if (lockExists) {
                let stat;
                try {
                    stat = fs.statSync(LOCK_DIR);
                }
                catch (statError) {
                    throw classifyGateStorageError(statError, 'lock_existing_state', LOCK_DIR);
                }
                if (!stat.isDirectory()) {
                    throw new ResourceGateStorageError('gate_path_invalid', getGateErrno(error), 'lock_existing_state', toSafeGatePath(LOCK_DIR), error);
                }
                removeGatePath(candidateDir, 'lock_candidate_competition_cleanup');
                return null;
            }
            throw classifyGateStorageError(error, 'lock_publish', LOCK_DIR);
        }
        writeGateEvent('lock_acquired', { taskId: meta.taskId, kind: meta.kind, ticketId: meta.ticketId, owner: meta.owner });
        return meta;
    }
    catch (error) {
        removeGatePath(published ? LOCK_DIR : candidateDir, 'lock_acquire_rollback');
        throw error;
    }
}
// 检查并回收可确认死亡的 stale lock。
function reclaimStaleLock(staleMs = DEFAULT_STALE_MS, actor = 'system') {
    const meta = readLockMeta();
    if (!meta)
        return false;
    const heartbeatAt = Date.parse(String(meta.heartbeatAt || meta.startedAt || ''));
    const stale = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleMs;
    if (!stale)
        return false;
    if (isProcessAlive(meta.pid)) {
        writeGateEvent('stale_suspected', { taskId: meta.taskId, kind: meta.kind, pid: meta.pid, actor });
        return false;
    }
    const removed = removeGatePath(LOCK_DIR, 'stale_lock_cleanup');
    if (removed)
        writeGateEvent('stale_reclaimed', { taskId: meta.taskId, kind: meta.kind, pid: meta.pid, actor });
    return removed;
}
// Bot 启动时丢弃上一次进程遗留的独占锁和全部短期 ticket。
function discardInterruptedResourceGateState(reason = 'restart_discarded') {
    const meta = readLockMeta();
    const lockExisted = gatePathExists(LOCK_DIR, 'startup_lock_exists');
    let ticketsRemoved = 0;
    if (gatePathExists(TICKETS_DIR, 'startup_tickets_exists')) {
        try {
            ticketsRemoved = fs.readdirSync(TICKETS_DIR).length;
        }
        catch (error) {
            throw classifyGateStorageError(error, 'startup_ticket_list', TICKETS_DIR);
        }
    }
    const lockRemoved = lockExisted ? removeGatePath(LOCK_DIR, 'startup_lock_cleanup') : false;
    if (ticketsRemoved > 0)
        removeGatePath(TICKETS_DIR, 'startup_ticket_cleanup');
    ensureGateDirs();
    if (lockExisted || ticketsRemoved > 0) {
        writeGateEvent('startup_runtime_discarded', { reason, lockRemoved, ticketsRemoved, taskId: meta?.taskId || '', kind: meta?.kind || '' });
    }
    return { lockRemoved, ticketsRemoved };
}
// 更新当前锁心跳和执行步骤；旧状态存在但不可读时向调用方抛出结构化故障。
function updateLockMeta(ticketId, step, memAvailableMb) {
    const meta = readLockMeta();
    if (!meta || meta.ticketId !== ticketId)
        return;
    const next = {
        ...meta,
        heartbeatAt: nowIso(),
        step: step || meta.step,
        memAvailableMb: memAvailableMb === undefined ? meta.memAvailableMb : memAvailableMb,
    };
    writeGateJsonAtomic(LOCK_META_FILE, next, 'lock_meta_update');
}
// --- 获取、释放与只读状态 ---
// 尝试获取 S0 独占运行槽，普通竞争超时与存储故障使用不同错误类型。
async function acquireResourceGate(input) {
    const ticket = createTicket(input);
    const waitTimeoutMs = Number.isFinite(Number(input.waitTimeoutMs)) ? Number(input.waitTimeoutMs) : DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = Math.max(200, Math.min(5000, Number(input.pollMs || DEFAULT_POLL_MS)));
    const staleMs = Number.isFinite(Number(input.staleMs)) ? Number(input.staleMs) : DEFAULT_STALE_MS;
    const deadline = Date.now() + waitTimeoutMs;
    let heartbeatTimer = null;
    let heartbeatFailure = null;
    try {
        while (Date.now() <= deadline) {
            reclaimStaleLock(staleMs, `ticket:${ticket.ticketId}`);
            if (isTicketHead(ticket.ticketId)) {
                const meta = tryCreateLock(ticket, input);
                if (meta) {
                    heartbeatTimer = setInterval(() => {
                        try {
                            updateLockMeta(ticket.ticketId);
                        }
                        catch (error) {
                            heartbeatFailure = classifyGateStorageError(error, 'lock_heartbeat', LOCK_META_FILE);
                        }
                    }, 2000);
                    heartbeatTimer.unref?.();
                    return {
                        ticketId: ticket.ticketId,
                        meta,
                        updateStep(step, memAvailableMb) {
                            if (heartbeatFailure)
                                throw heartbeatFailure;
                            updateLockMeta(ticket.ticketId, step, memAvailableMb);
                        },
                        release(reason = 'completed') {
                            if (heartbeatTimer)
                                clearInterval(heartbeatTimer);
                            heartbeatTimer = null;
                            const pendingHeartbeatFailure = heartbeatFailure;
                            heartbeatFailure = null;
                            releaseResourceGate(ticket.ticketId, reason);
                            if (pendingHeartbeatFailure)
                                throw pendingHeartbeatFailure;
                        },
                    };
                }
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
        throw new ResourceGateBusyTimeoutError(ticket.ticketId, waitTimeoutMs);
    }
    catch (error) {
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        removeTicket(ticket.ticketId);
        if (error instanceof ResourceGateBusyTimeoutError) {
            writeGateEvent('lock_wait_failed', { ticketId: ticket.ticketId, taskId: ticket.taskId, kind: ticket.kind, failureCode: error.code });
        }
        throw error;
    }
}
// 释放 S0 独占运行槽和对应 ticket，清理失败会明确抛出 gate_cleanup_failed。
function releaseResourceGate(ticketId, reason = 'completed') {
    const meta = readLockMeta();
    if (meta && meta.ticketId === ticketId)
        removeGatePath(LOCK_DIR, 'lock_release_cleanup');
    removeTicket(ticketId);
    if (meta && meta.ticketId === ticketId)
        writeGateEvent('lock_released', { ticketId, taskId: meta.taskId, kind: meta.kind, reason });
}
// 读取 S0 当前状态，Dashboard 展示当前 running 以此为准。
function getResourceGateStatus(staleMs = DEFAULT_STALE_MS) {
    const meta = readLockMeta();
    const tickets = listTickets();
    let suspectedBlocked = false;
    if (meta) {
        const heartbeatAt = Date.parse(String(meta.heartbeatAt || meta.startedAt || ''));
        suspectedBlocked = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleMs;
    }
    return { locked: !!meta, meta, tickets, suspectedBlocked };
}
// 用于普通入口的只读判断：当前是否正在执行日报。
function isDailyReportRunning() {
    const meta = readLockMeta();
    return !!meta && meta.kind === 'daily_report';
}
module.exports = {
    GATE_ROOT,
    LOCK_DIR,
    LOCK_META_FILE,
    TICKETS_DIR,
    ResourceGateStorageError,
    ResourceGateBusyTimeoutError,
    classifyGateStorageError,
    isResourceGateStorageError,
    createTicket,
    listTickets,
    readLockMeta,
    acquireResourceGate,
    releaseResourceGate,
    reclaimStaleLock,
    discardInterruptedResourceGateState,
    getResourceGateStatus,
    isDailyReportRunning,
    writeGateEvent,
};
