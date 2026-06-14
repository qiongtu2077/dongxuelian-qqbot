"use strict";
/**
 * MODULE: 服务器资源模式策略。
 * 职责: 读取 / 写入 serverMode 配置，并把资源档位与活跃租约解释成可审计的后台可用状态。
 * 边界: 不接管任务准入，不替代 mode-policy，不写 worker 状态机。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { ensureDir, nowIso, readJsonFile, writeJsonAtomic } = require('../resource-common/files');
const SERVER_MODE_CONTROL_DIR = path.join(DATA_DIR, 'resource-control');
const SERVER_MODE_CONFIG_FILE = path.join(SERVER_MODE_CONTROL_DIR, 'config.json');
const DEFAULT_SERVER_MODE = 'large';
// 归一化 serverMode，未知值默认落回 large，避免配置损坏时误伤功能。
function normalizeServerMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'small' ? 'small' : DEFAULT_SERVER_MODE;
}
// 读取当前 serverMode 配置；缺失或损坏时默认 large。
function readServerModeConfig() {
    const file = readJsonFile(SERVER_MODE_CONFIG_FILE, null);
    if (!file) {
        return {
            serverMode: DEFAULT_SERVER_MODE,
            serverModeSource: 'default',
        };
    }
    return {
        serverMode: normalizeServerMode(file.serverMode ?? file.mode),
        serverModeSource: 'resource-control/config.json',
    };
}
// 写入当前 serverMode 配置，供 Dashboard 控制面持久化。
function writeServerModeConfig(serverMode, meta = {}) {
    ensureDir(SERVER_MODE_CONTROL_DIR);
    const normalized = normalizeServerMode(serverMode);
    writeJsonAtomic(SERVER_MODE_CONFIG_FILE, {
        serverMode: normalized,
        updatedAt: nowIso(),
        ...meta,
    });
    return {
        serverMode: normalized,
        serverModeSource: 'resource-control/config.json',
    };
}
// 计算后台是否允许运行：维护、红黑档和 small 模式下的 tool/render 活跃都会关闸。
function resolveBackgroundAllowed(input = {}) {
    const serverMode = normalizeServerMode(input.serverMode);
    const resourceState = String(input.resourceState || 'yellow');
    const maintenance = !!input.maintenance;
    const toolActive = !!input.toolActive;
    const renderActive = !!input.renderActive;
    if (maintenance)
        return false;
    if (resourceState === 'red' || resourceState === 'black')
        return false;
    if (serverMode === 'small' && (toolActive || renderActive))
        return false;
    return true;
}
// 读取 serverMode 与后台门禁的组合状态，供 snapshot / Dashboard 复用。
function readServerModeState(input = {}) {
    const config = readServerModeConfig();
    return {
        ...config,
        backgroundAllowed: resolveBackgroundAllowed({
            ...input,
            serverMode: config.serverMode,
        }),
    };
}
// 判断当前是否需要对 Chromium 级 tool/render 活跃租约执行严格互斥。
function readResourceActivityMutualExclusionState(serverMode = undefined) {
    const config = serverMode === undefined
        ? readServerModeConfig()
        : {
            serverMode: normalizeServerMode(serverMode),
            serverModeSource: 'override',
        };
    return {
        ...config,
        strictActivityMutualExclusion: config.serverMode === 'small',
    };
}
module.exports = {
    SERVER_MODE_CONTROL_DIR,
    SERVER_MODE_CONFIG_FILE,
    DEFAULT_SERVER_MODE,
    normalizeServerMode,
    readServerModeConfig,
    writeServerModeConfig,
    resolveBackgroundAllowed,
    readServerModeState,
    readResourceActivityMutualExclusionState,
};
