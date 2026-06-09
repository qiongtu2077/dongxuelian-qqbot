"use strict";
/**
 * MODULE: 运行时配置读取。
 * 职责: 提供 provider/model/baseURL/apiKey/thinking 等运行时配置的统一入口。
 * 边界: 只读配置，不含业务逻辑。业务模块通过此文件获取配置，不直接 require constants.js 中的路径常量。
 */
const { KEY_FILE, MODEL_FILE, BASE_URL_FILE, SEARCH_ENABLED_FILE, ADMIN_IDS_FILE, PROVIDER_FILE, } = require('./constants');
const fs = require('fs');
const fsp = require('fs/promises');
const { resolveProviderDefinition, resolveProviderApiKey, } = require('./provider-registry');
let configCache = null;
let adminUserIdsCache = null;
let thinkingEnabled = false;
const DEFAULT_ADMIN_USER_IDS = process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS
    ? process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
const MAX_RUNTIME_TEXT_BYTES = 64 * 1024;
const MAX_ADMIN_IDS_BYTES = 128 * 1024;
async function readRuntimeTextFile(file) {
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_RUNTIME_TEXT_BYTES)
            return '';
        return (await fsp.readFile(file, 'utf8')).trim();
    }
    catch {
        return '';
    }
}
function parseRuntimeEnabledText(value = '') {
    return /^(?:1|true|on|yes|\u5f00|\u5f00\u542f)$/i.test(String(value).trim());
}
function getRuntimeBaseHostname(baseURL = '') {
    try {
        return new URL(String(baseURL || '')).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
function isRuntimeDashScopeConfig(config = {}) {
    const hostname = getRuntimeBaseHostname(config.baseURL);
    return hostname.includes('dashscope') || hostname.endsWith('aliyuncs.com');
}
function readAdminUserIdsFile() {
    try {
        const stat = fs.statSync(ADMIN_IDS_FILE);
        if (!stat.isFile() || stat.size > MAX_ADMIN_IDS_BYTES)
            return null;
        const parsed = JSON.parse(fs.readFileSync(ADMIN_IDS_FILE, 'utf8'));
        if (!Array.isArray(parsed))
            return null;
        const ids = parsed
            .map(value => value === null || value === undefined ? '' : String(value).trim())
            .filter(Boolean);
        return ids.length ? new Set(ids) : null;
    }
    catch {
        return null;
    }
}
function getAdminUserIds(force = false) {
    if (adminUserIdsCache && !force)
        return adminUserIdsCache;
    adminUserIdsCache = readAdminUserIdsFile() || new Set(DEFAULT_ADMIN_USER_IDS);
    if (adminUserIdsCache.size === 0 && !getAdminUserIds._warned) {
        ;
        getAdminUserIds._warned = true;
        console.warn('[runtime-config] 警告：未配置管理员 ID。请创建 data/ai-admin-ids.json 或设置环境变量 DONGXUELIAN_DEFAULT_ADMIN_IDS');
    }
    return adminUserIdsCache;
}
function isAdminUserId(userId) {
    return getAdminUserIds().has(String(userId || '').trim());
}
function getThinkingArgs(config) {
    if (!thinkingEnabled) {
        if (isRuntimeDashScopeConfig(config))
            return { enable_thinking: false };
        if (/glm|mimo|kimi/i.test(config.model || ''))
            return { thinking: { type: 'disabled' } };
        if (/deepseek/i.test(config.model || ''))
            return { enable_thinking: false };
        return {};
    }
    if (isRuntimeDashScopeConfig(config))
        return { enable_thinking: true };
    if (/glm|mimo|kimi/i.test(config.model || ''))
        return { thinking: { type: 'enabled' } };
    return {};
}
function selectRuntimeModel(model, providerDef) {
    const models = Array.isArray(providerDef?.models) ? providerDef.models : [];
    const modelIds = new Set(models.map(item => String(item.id || '').trim()).filter(Boolean));
    if (providerDef?.custom && model && !modelIds.has(model))
        return models[0]?.id || 'gpt-4o-mini';
    return model || models[0]?.id || 'gpt-4o-mini';
}
async function loadConfig(force = false) {
    if (configCache && !force)
        return configCache;
    const [apiKey, model, baseURL, searchEnabledText, provider] = await Promise.all([
        readRuntimeTextFile(KEY_FILE),
        readRuntimeTextFile(MODEL_FILE),
        readRuntimeTextFile(BASE_URL_FILE),
        readRuntimeTextFile(SEARCH_ENABLED_FILE),
        readRuntimeTextFile(PROVIDER_FILE),
    ]);
    const activeProvider = provider || 'opencode';
    const providerDef = await resolveProviderDefinition(activeProvider);
    if (!providerDef)
        throw new Error(`Unknown AI provider: ${activeProvider}`);
    const resolvedBaseURL = String(providerDef?.baseURL || baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const resolvedApiKey = await resolveProviderApiKey(activeProvider, apiKey, { allowFallback: !providerDef.custom });
    configCache = {
        apiKey: resolvedApiKey,
        model: selectRuntimeModel(model, providerDef),
        baseURL: resolvedBaseURL,
        searchEnabled: parseRuntimeEnabledText(searchEnabledText),
        provider: activeProvider,
    };
    return configCache;
}
function resetConfigCache() {
    configCache = null;
    adminUserIdsCache = null;
}
function getThinkingEnabled() {
    return thinkingEnabled;
}
function setThinkingEnabled(value) {
    thinkingEnabled = !!value;
}
module.exports = {
    loadConfig,
    resetConfigCache,
    getThinkingArgs,
    getAdminUserIds,
    isAdminUserId,
    getThinkingEnabled,
    setThinkingEnabled,
};
