"use strict";
/**
 * MODULE: provider 注册表与自定义 provider 解析。
 * 职责: 统一读取内置 provider、自定义 provider，以及按 provider 解析 baseURL/models/keyFile。
 * 边界: 只读 provider 定义与 key 文件，不缓存运行时主配置。
 */
const { PROVIDERS, DATA_DIR, CUSTOM_PROVIDERS_FILE, KEY_FILE, DEEPSEEK_KEY_FILE, DASHSCOPE_KEY_FILE, GLM_KEY_FILE, MIMORIUM_KEY_FILE, } = require('./constants');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const BUILTIN_PROVIDER_KEY_FILES = {
    default: KEY_FILE,
    opencode: KEY_FILE,
    deepseek: DEEPSEEK_KEY_FILE,
    dashscope: DASHSCOPE_KEY_FILE,
    glm: GLM_KEY_FILE,
    mimorium: MIMORIUM_KEY_FILE,
};
const MAX_PROVIDER_CONFIG_BYTES = 256 * 1024;
const MAX_PROVIDER_KEY_BYTES = 64 * 1024;
function normalizeProviderModel(model) {
    if (typeof model === 'string') {
        const id = String(model).trim();
        return id ? { id, name: id, vision: false } : null;
    }
    if (!model || typeof model !== 'object')
        return null;
    const candidate = model;
    const id = String(candidate.id || '').trim();
    if (!id)
        return null;
    const name = String(candidate.name || '').trim();
    return {
        id,
        name: name || id,
        vision: !!candidate.vision,
    };
}
function normalizeCustomProvider(provider) {
    if (!provider || typeof provider !== 'object')
        return null;
    const candidate = provider;
    const id = String(candidate.id || '').trim();
    const name = String(candidate.name || '').trim();
    const baseURL = String(candidate.baseURL || '').trim().replace(/\/+$/, '');
    if (!id || !name || !baseURL)
        return null;
    const models = Array.isArray(candidate.models)
        ? candidate.models.map(normalizeProviderModel).filter(Boolean)
        : [];
    const keyFile = String(candidate.keyFile || '').trim();
    return {
        id,
        name,
        baseURL,
        keyFile: keyFile || undefined,
        models,
    };
}
async function readCustomProviders() {
    const data = await readJsonFileDirect(CUSTOM_PROVIDERS_FILE, []);
    return Array.isArray(data) ? data.map(normalizeCustomProvider).filter(Boolean) : [];
}
function readCustomProvidersSync() {
    const data = readJsonFileDirectSync(CUSTOM_PROVIDERS_FILE, []);
    return Array.isArray(data) ? data.map(normalizeCustomProvider).filter(Boolean) : [];
}
async function getMergedProviderMap() {
    const merged = buildBuiltinProviderMap();
    const customProviders = await readCustomProviders();
    for (const provider of customProviders) {
        merged[provider.id] = {
            id: provider.id,
            name: provider.name,
            baseURL: provider.baseURL,
            models: provider.models,
            keyFile: provider.keyFile,
            custom: true,
        };
    }
    return merged;
}
function getMergedProviderMapSync() {
    const merged = buildBuiltinProviderMap();
    const customProviders = readCustomProvidersSync();
    for (const provider of customProviders) {
        merged[provider.id] = {
            id: provider.id,
            name: provider.name,
            baseURL: provider.baseURL,
            models: provider.models,
            keyFile: provider.keyFile,
            custom: true,
        };
    }
    return merged;
}
function buildBuiltinProviderMap() {
    const merged = {};
    for (const [id, provider] of Object.entries(PROVIDERS)) {
        merged[id] = {
            id,
            name: provider.name,
            baseURL: String(provider.baseURL || '').replace(/\/+$/, ''),
            models: Array.isArray(provider.models) ? provider.models.map(model => ({
                id: String(model.id || '').trim(),
                name: String(model.name || model.id || '').trim(),
                vision: !!model.vision,
            })) : [],
            keyFile: getBuiltinProviderKeyFile(id),
            custom: false,
        };
    }
    return merged;
}
function getBuiltinProviderKeyFile(providerId) {
    return BUILTIN_PROVIDER_KEY_FILES[providerId] || BUILTIN_PROVIDER_KEY_FILES.default;
}
function resolveProviderKeyFile(file) {
    const value = String(file || '').trim();
    if (!value)
        return '';
    return path.isAbsolute(value) ? value : path.join(DATA_DIR, value);
}
async function resolveProviderDefinition(providerId) {
    const merged = await getMergedProviderMap();
    return merged[String(providerId || '').trim()] || null;
}
function resolveProviderDefinitionSync(providerId) {
    const merged = getMergedProviderMapSync();
    return merged[String(providerId || '').trim()] || null;
}
async function resolveProviderApiKey(providerId, fallbackKey, options = {}) {
    const provider = await resolveProviderDefinition(providerId);
    const fallback = options.allowFallback === false ? '' : String(fallbackKey || '');
    if (!provider || !provider.keyFile)
        return fallback.replace(/[\r\n]+/g, '');
    const keyFile = resolveProviderKeyFile(provider.keyFile);
    return ((await readTextFileDirect(keyFile).catch(() => '')) || fallback).replace(/[\r\n]+/g, '');
}
function resolveProviderApiKeySync(providerId, fallbackKey, options = {}) {
    const provider = resolveProviderDefinitionSync(providerId);
    const fallback = options.allowFallback === false ? '' : String(fallbackKey || '');
    if (!provider || !provider.keyFile)
        return fallback.replace(/[\r\n]+/g, '');
    const keyFile = resolveProviderKeyFile(provider.keyFile);
    return ((readTextFileDirectSync(keyFile)) || fallback).replace(/[\r\n]+/g, '');
}
async function readJsonFileDirect(file, fallback) {
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES)
            return fallback;
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function readJsonFileDirectSync(file, fallback) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES)
            return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
async function readTextFileDirect(file) {
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_PROVIDER_KEY_BYTES)
            return '';
        return String(await fsp.readFile(file, 'utf8')).trim();
    }
    catch {
        return '';
    }
}
function readTextFileDirectSync(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_PROVIDER_KEY_BYTES)
            return '';
        return String(fs.readFileSync(file, 'utf8') || '').trim();
    }
    catch {
        return '';
    }
}
module.exports = {
    readCustomProviders,
    readCustomProvidersSync,
    getMergedProviderMap,
    getMergedProviderMapSync,
    resolveProviderDefinition,
    resolveProviderDefinitionSync,
    resolveProviderApiKey,
    resolveProviderApiKeySync,
    resolveProviderKeyFile,
    getBuiltinProviderKeyFile,
};
