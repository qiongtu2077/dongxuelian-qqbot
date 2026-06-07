"use strict";
/**
 * MODULE: S0 全局资源闸门。
 * 职责: 提供跨进程 ticket、公平获取独占锁、心跳和 stale 回收。
 * 边界: 不保存长期业务队列，长期任务状态归 S2。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { appendJsonlEvent, ensureDir, isProcessAlive, nowIso, readJsonFile, removePath, sanitizeId, writeJsonAtomic, } = require('../resource-common/files');
const GATE_ROOT = path.join(DATA_DIR, 'resource-gate');
const LOCK_DIR = path.join(GATE_ROOT, 'lock');
const LOCK_META_FILE = path.join(LOCK_DIR, 'meta.json');
const TICKETS_DIR = path.join(GATE_ROOT, 'tickets');
const DEFAULT_STALE_MS = Number(process.env.RESOURCE_GATE_STALE_MS || 30000);
const DEFAULT_WAIT_TIMEOUT_MS = Number(process.env.RESOURCE_GATE_WAIT_TIMEOUT_MS || 600000);
const DEFAULT_POLL_MS = Number(process.env.RESOURCE_GATE_POLL_MS || 1000);
// 返回当天 S0 事件日志路径。
function gateEventFile(date = new Date()) {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(GATE_ROOT, `events-${stamp}.jsonl`);
}
// 初始化 S0 运行目录。
function ensureGateDirs() {
    ensureDir(GATE_ROOT);
    ensureDir(TICKETS_DIR);
}
// 写入 S0 事件，供 Dashboard 和排障读取。
function writeGateEvent(event, data = {}) {
    appendJsonlEvent(gateEventFile(), { event, ...data });
}
// 生成 ticket 文件路径。
function getTicketFile(ticketId) {
    return path.join(TICKETS_DIR, `${sanitizeId(ticketId)}.json`);
}
// 创建短生命周期 ticket。
function createTicket(input) {
    ensureGateDirs();
    const createdAt = nowIso();
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
        createdAt,
    };
    writeJsonAtomic(getTicketFile(ticket.ticketId), ticket);
    writeGateEvent('ticket_created', { ticketId: ticket.ticketId, taskId: ticket.taskId, kind: ticket.kind, priority: ticket.priority });
    return ticket;
}
// 读取全部 ticket 并按优先级、创建时间排序。
function listTickets() {
    ensureGateDirs();
    let names = [];
    try {
        names = fs.readdirSync(TICKETS_DIR).filter(name => name.endsWith('.json')).sort();
    }
    catch {
        return [];
    }
    const tickets = [];
    for (const name of names) {
        const file = path.join(TICKETS_DIR, name);
        const ticket = readJsonFile(file, null);
        if (!ticket || !ticket.ticketId || !ticket.taskId) {
            writeGateEvent('ticket_invalid', { file });
            continue;
        }
        tickets.push(ticket);
    }
    tickets.sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50) || String(a.createdAt).localeCompare(String(b.createdAt)));
    return tickets;
}
// 删除 ticket 文件。
function removeTicket(ticketId) {
    removePath(getTicketFile(ticketId));
}
// 读取当前锁元数据。
function readLockMeta() {
    return readJsonFile(LOCK_META_FILE, null);
}
// 判断当前 ticket 是否排在队头。
function isTicketHead(ticketId) {
    const head = listTickets()[0];
    return !!head && head.ticketId === ticketId;
}
// 尝试创建 lock 目录并写入 meta。
function tryCreateLock(ticket, input) {
    try {
        fs.mkdirSync(LOCK_DIR);
    }
    catch (error) {
        if (String(error?.code || '') === 'EEXIST')
            return null;
        throw error;
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
    writeJsonAtomic(LOCK_META_FILE, meta);
    writeGateEvent('lock_acquired', { taskId: meta.taskId, kind: meta.kind, ticketId: meta.ticketId, owner: meta.owner });
    return meta;
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
    const removed = removePath(LOCK_DIR);
    if (removed)
        writeGateEvent('stale_reclaimed', { taskId: meta.taskId, kind: meta.kind, pid: meta.pid, actor });
    return removed;
}
// 更新当前锁心跳和执行步骤。
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
    writeJsonAtomic(LOCK_META_FILE, next);
}
// 尝试获取 S0 独占运行槽，直到成功或超时。
async function acquireResourceGate(input) {
    const ticket = createTicket(input);
    const waitTimeoutMs = Number.isFinite(Number(input.waitTimeoutMs)) ? Number(input.waitTimeoutMs) : DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = Math.max(200, Math.min(5000, Number(input.pollMs || DEFAULT_POLL_MS)));
    const staleMs = Number.isFinite(Number(input.staleMs)) ? Number(input.staleMs) : DEFAULT_STALE_MS;
    const deadline = Date.now() + waitTimeoutMs;
    let heartbeatTimer = null;
    try {
        while (Date.now() <= deadline) {
            reclaimStaleLock(staleMs, `ticket:${ticket.ticketId}`);
            if (isTicketHead(ticket.ticketId)) {
                const meta = tryCreateLock(ticket, input);
                if (meta) {
                    heartbeatTimer = setInterval(() => updateLockMeta(ticket.ticketId), 2000);
                    if (heartbeatTimer.unref)
                        heartbeatTimer.unref();
                    return {
                        ticketId: ticket.ticketId,
                        meta,
                        updateStep(step, memAvailableMb) {
                            updateLockMeta(ticket.ticketId, step, memAvailableMb);
                        },
                        release(reason = 'completed') {
                            if (heartbeatTimer)
                                clearInterval(heartbeatTimer);
                            heartbeatTimer = null;
                            releaseResourceGate(ticket.ticketId, reason);
                        },
                    };
                }
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
        throw new Error(`resource gate wait timeout (${waitTimeoutMs}ms)`);
    }
    catch (error) {
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        removeTicket(ticket.ticketId);
        writeGateEvent('lock_wait_failed', { ticketId: ticket.ticketId, taskId: ticket.taskId, kind: ticket.kind, error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
}
// 释放 S0 独占运行槽和对应 ticket。
function releaseResourceGate(ticketId, reason = 'completed') {
    const meta = readLockMeta();
    if (meta && meta.ticketId === ticketId) {
        removePath(LOCK_DIR);
        writeGateEvent('lock_released', { ticketId, taskId: meta.taskId, kind: meta.kind, reason });
    }
    removeTicket(ticketId);
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
    createTicket,
    listTickets,
    readLockMeta,
    acquireResourceGate,
    releaseResourceGate,
    reclaimStaleLock,
    getResourceGateStatus,
    isDailyReportRunning,
    writeGateEvent,
};
