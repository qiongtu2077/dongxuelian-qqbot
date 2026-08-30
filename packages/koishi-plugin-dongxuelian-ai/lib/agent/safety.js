"use strict";
/**
 * MODULE: 工具安全校验。
 * 职责: block/confirm/auto 三档判断 + 危险工具过滤 + 模式持久化。
 * 边界: 不执行工具。
 * 状态: mode (string)，启动时从文件加载。
 */
const { toolRegistry } = require('./tools/registry');
const { getDangerousPolicy } = require('./config');
const { TOOL_MODE_FILE } = require('../core/constants');
const fs = require('fs');
const fsp = require('fs/promises');
let mode = 'config';
let modePersistenceError = '';
function isSafetyMode(value) {
    return value === 'auto' || value === 'confirm' || value === 'block' || value === 'config';
}
// 启动时从文件加载
try {
    const v = fs.readFileSync(TOOL_MODE_FILE, 'utf8').trim();
    if (isSafetyMode(v))
        mode = v;
}
catch { /* non-critical: missing tool mode file uses config policy */ }
function getMode() { return mode; }
// 返回最近一次工具模式持久化结果，供管理端诊断内存状态与磁盘状态是否一致。
function getModePersistenceStatus() {
    return { ok: !modePersistenceError, error: modePersistenceError };
}
async function setMode(m) {
    if (!isSafetyMode(m))
        return;
    mode = m;
    try {
        await fsp.writeFile(TOOL_MODE_FILE, mode, 'utf8');
        modePersistenceError = '';
    }
    catch (error) {
        modePersistenceError = error instanceof Error ? error.message : String(error || 'unknown error');
        console.warn(`[agent-safety] tool_mode_persistence_failed mode=${mode} detail=${modePersistenceError}`);
    }
}
const DANGEROUS_TOOLS = new Set(['execute_shell', 'write_file', 'edit_file', 'execute_javascript', 'browser_action', 'append_file']);
function getEffectivePolicy() {
    return mode === 'config' ? getDangerousPolicy() : mode;
}
function check(toolName) {
    const name = String(toolName || '');
    const tool = toolRegistry[name];
    if (!tool)
        return { allowed: false, error: `未知工具: ${toolName}` };
    if (!DANGEROUS_TOOLS.has(name) && !tool.dangerous)
        return { allowed: true };
    const policy = getEffectivePolicy();
    if (policy === 'block')
        return { allowed: false, action: 'block', error: `工具 '${toolName}' 已被禁用（block 模式）` };
    if (policy === 'confirm')
        return { allowed: false, action: 'confirm', error: `工具 '${toolName}' 需要确认（confirm 模式）` };
    return { allowed: true, action: 'auto' };
}
module.exports = { getMode, getModePersistenceStatus, setMode, getEffectivePolicy, check, DANGEROUS_TOOLS };
