"use strict";
/**
 * MODULE: Agent 待确认管理。
 * 职责: 存储/查询/清理 confirm 模式下的待确认工具请求。
 * 边界: 不执行工具，不做安全检查。
 * 状态: pending (Map)。
 */
const crypto = require('crypto');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { ensureDir, listJsonFiles, readJsonFile, removePath, sanitizeId, writeJsonAtomic, } = require('../resource-common/files');
const pending = new Map();
const PENDING_DIR = path.join(DATA_DIR, 'agent-pending');
// Return the persisted pending record path for one pending id.
function getPendingFile(id) {
    return path.join(PENDING_DIR, `${sanitizeId(id)}.json`);
}
function pendingKey(channelKey, userId) {
    return String(channelKey) + ':' + String(userId);
}
function pendingRecordFromValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function pendingText(value) {
    return String(value || '');
}
// Normalize raw JSON into a valid pending tool record.
function normalizePendingTool(value) {
    const record = pendingRecordFromValue(value);
    const id = pendingText(record.id);
    const toolName = pendingText(record.toolName);
    const userId = pendingText(record.userId);
    const channelKey = pendingText(record.channelKey);
    if (!id || !toolName || !userId || !channelKey)
        return null;
    return {
        id,
        toolName,
        args: record.args,
        userId,
        channelKey,
        channel: pendingText(record.channel) || 'unknown',
        expireAt: Number(record.expireAt) || 0,
        resume: record.resume || null,
    };
}
// Cache one pending tool in the in-process map.
function cachePendingTool(tool) {
    pending.set(pendingKey(tool.channelKey, tool.userId), tool);
    return tool;
}
// Persist and cache one pending tool record.
function writePendingTool(tool) {
    ensureDir(PENDING_DIR);
    writeJsonAtomic(getPendingFile(tool.id), tool);
    return cachePendingTool(tool);
}
// Read one pending tool file and discard it when expired.
function readPendingToolByFile(file, now = Date.now()) {
    const tool = normalizePendingTool(readJsonFile(file, null));
    if (!tool)
        return null;
    if (now > tool.expireAt) {
        removePath(file);
        pending.delete(pendingKey(tool.channelKey, tool.userId));
        return null;
    }
    return cachePendingTool(tool);
}
// Scan persisted pending tools and return the first matching record.
function findPendingToolFromDisk(predicate) {
    ensureDir(PENDING_DIR);
    for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
        const tool = readPendingToolByFile(file);
        if (tool && predicate(tool))
            return tool;
    }
    return null;
}
// Remove one pending tool from both memory and disk.
function removePendingTool(tool) {
    pending.delete(pendingKey(tool.channelKey, tool.userId));
    removePath(getPendingFile(tool.id));
}
// Remove every pending tool belonging to one channel/user pair.
function removePendingToolsByKey(channelKey, userId) {
    const key = pendingKey(channelKey, userId);
    const cached = pending.get(key);
    if (cached)
        removePendingTool(cached);
    ensureDir(PENDING_DIR);
    for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
        const tool = readPendingToolByFile(file);
        if (tool && pendingKey(tool.channelKey, tool.userId) === key)
            removePendingTool(tool);
    }
}
/** @returns {{ id, toolName, args, userId, channelKey, channel, expireAt, resume } | null } */
function getPendingTool(channelKey, userId) {
    const key = pendingKey(channelKey, userId);
    trimPendingTools();
    const p = pending.get(key);
    if (!p)
        return findPendingToolFromDisk(tool => pendingKey(tool.channelKey, tool.userId) === key);
    if (Date.now() > p.expireAt) {
        pending.delete(key);
        return null;
    }
    return p;
}
function setPendingTool(channelKey, userId, { toolName, args, channel, resume }) {
    const id = 'pnd' + crypto.randomBytes(8).toString('hex');
    removePendingToolsByKey(channelKey, userId);
    writePendingTool({ id, toolName: pendingText(toolName), args, userId, channelKey, channel: pendingText(channel) || 'unknown', resume: resume || null, expireAt: Date.now() + 60000 });
    return id;
}
function clearPendingTool(channelKey, userId) {
    removePendingToolsByKey(channelKey, userId);
}
function clearPendingToolById(id) {
    const target = String(id || '');
    if (!target)
        return false;
    trimPendingTools();
    for (const [key, value] of pending) {
        if (value.id === target) {
            pending.delete(key);
            removePath(getPendingFile(value.id));
            return true;
        }
    }
    const found = findPendingToolFromDisk(tool => tool.id === target);
    if (found) {
        removePendingTool(found);
        return true;
    }
    return false;
}
/** 清理过期 */
function trimPendingTools(now = Date.now()) {
    for (const [k, v] of pending) {
        if (now > v.expireAt) {
            pending.delete(k);
            removePath(getPendingFile(v.id));
        }
    }
    ensureDir(PENDING_DIR);
    for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
        readPendingToolByFile(file, now);
    }
}
const cleanupTimer = setInterval(() => trimPendingTools(), 60000);
if (cleanupTimer.unref)
    cleanupTimer.unref();
function findPendingToolById(id) {
    trimPendingTools();
    const target = String(id || '');
    if (!target)
        return null;
    for (const p of pending.values()) {
        if (p.id === target)
            return p;
    }
    return findPendingToolFromDisk(tool => tool.id === target);
}
function getPendingToolById(id) {
    return findPendingToolById(id);
}
function summarizePendingArgs(toolName, args = {}) {
    const src = pendingRecordFromValue(args);
    const fields = [];
    for (const key of ['path', 'cwd', 'command', 'url', 'selector', 'expression', 'query', 'action']) {
        if (src[key] !== undefined)
            fields.push(`${key}=${String(src[key]).slice(0, 160)}`);
    }
    if (src.content !== undefined)
        fields.push(`content=${Buffer.byteLength(String(src.content), 'utf8')} bytes`);
    if (src.text !== undefined)
        fields.push(`text=${String(src.text).slice(0, 80)}`);
    return fields.length ? fields.join('; ') : `${toolName} 参数 ${JSON.stringify(src).slice(0, 200)}`;
}
function listPendingTools() {
    trimPendingTools();
    const unique = new Map();
    for (const p of pending.values())
        unique.set(p.id, p);
    return Array.from(unique.values()).map(p => ({
        id: p.id,
        toolName: p.toolName,
        userId: p.userId,
        channelKey: p.channelKey,
        channel: p.channel || 'unknown',
        argsSummary: summarizePendingArgs(p.toolName, p.args),
        expireAt: p.expireAt,
    }));
}
// Persist a pending snapshot created in another process.
function upsertPendingToolSnapshot(snapshot) {
    const tool = normalizePendingTool(snapshot);
    if (!tool || Date.now() > tool.expireAt)
        return null;
    return writePendingTool(tool);
}
async function executePendingTool(channelKey, userId, channel = 'unknown', expectedId = '', context = {}) {
    const p = getPendingTool(channelKey, userId);
    if (!p)
        return { ok: false, status: 404, message: '没有待确认工具' };
    if (expectedId && p.id !== expectedId)
        return { ok: false, status: 404, message: '没有匹配的待确认工具' };
    const { isToolEnabled } = require('./config');
    const safety = require('./safety');
    if (!isToolEnabled(channel, p.toolName))
        return { ok: false, status: 403, message: `工具 '${p.toolName}' 当前渠道未启用，拒绝执行。` };
    const safeResult = safety.check(p.toolName);
    if (safeResult.action === 'block')
        return { ok: false, status: 403, message: safeResult.error || '' };
    if (!safeResult.allowed && safeResult.action !== 'confirm')
        return { ok: false, status: 403, message: safeResult.error || `工具 '${p.toolName}' 未通过安全检查` };
    clearPendingTool(channelKey, userId);
    const registry = require('./tools/registry');
    const resume = pendingRecordFromValue(p.resume);
    const result = await registry.executeTool(p.toolName, pendingRecordFromValue(p.args), {
        channel,
        channelKey,
        userId,
        userName: resume.userName || context.userName || '',
        userMessage: resume.userMessage || context.userMessage || '',
        bot: context.bot,
        isAdmin: !!context.isAdmin,
        resourceTaskId: String(context.resourceTaskId || ''),
        taskId: String(context.resourceTaskId || ''),
    });
    return { ok: result.ok, pending: p, toolName: p.toolName, result: result.text, error: result.error || '', message: result.ok ? '' : result.text };
}
async function confirmPendingTool(channelKey, userId, channel = 'unknown', expectedId = '', context = {}) {
    const executed = await executePendingTool(channelKey, userId, channel, expectedId, context);
    if (!executed.ok && !executed.pending)
        return executed;
    const { recordCall } = require('./stats');
    if (executed.ok)
        recordCall(executed.toolName, channel);
    return { ok: executed.ok, toolName: executed.toolName, result: executed.result, error: executed.error || '', message: executed.ok ? '' : executed.result };
}
module.exports = { getPendingTool, findPendingToolById, getPendingToolById, setPendingTool, clearPendingTool, clearPendingToolById, trimPendingTools, summarizePendingArgs, listPendingTools, upsertPendingToolSnapshot, executePendingTool, confirmPendingTool };
