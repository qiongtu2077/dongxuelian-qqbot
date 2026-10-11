'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { json, collectBody, getErrorMessage } = require('../utils');
const { requireAdmin } = require('../auth');
const { executeConfigTransaction, ConfigTransactionError } = require('../config-transaction');
const { DATA_DIR, CUSTOM_PROVIDERS_FILE } = require('../paths');
const { aggregateCapabilityUsage } = require('../capability-usage');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const TOKEN_USAGE_FILE = path.join(DATA_DIR, 'token-usage.json');
const capabilityConfig = loadManagementModule('core.aiCapabilityConfig');
const modelDiscovery = loadManagementModule('core.modelDiscovery');
const CUSTOM_ID_RE = /^custom-[a-z0-9]{8,64}$/;
const CUSTOM_KEY_RE = /^ai-custom-[a-z0-9]{8,64}-key\.txt$/;
const MAX_CUSTOM_NAME = 96;
const MAX_CUSTOM_NOTE = 256;
const MAX_CUSTOM_URL = 2048;
// --- 通用边界 ---
// 解析一个 JSON 对象请求体，拒绝数组和基础类型。
function parseBody(body) {
    const value = JSON.parse(body || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('请求体必须是对象');
    return value;
}
// 读取自定义供应商目录；格式错误直接失败，避免覆盖未知数据。
function readCustomProviders() {
    if (!fs.existsSync(CUSTOM_PROVIDERS_FILE))
        return [];
    const raw = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'));
    if (!Array.isArray(raw))
        throw new Error('自定义供应商目录必须是数组');
    return raw.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new Error(`自定义供应商第 ${index + 1} 项无效`);
        const source = item;
        const id = String(source.id || '').trim();
        const name = String(source.name || '').trim();
        const baseURL = String(source.baseURL || '').trim().replace(/\/+$/, '');
        const keyFile = String(source.keyFile || '').trim();
        if (!CUSTOM_ID_RE.test(id) || !name || !baseURL || !CUSTOM_KEY_RE.test(keyFile))
            throw new Error('自定义供应商元数据无效');
        const models = Array.isArray(source.models) ? source.models.map(model => {
            if (!model || typeof model !== 'object' || Array.isArray(model))
                return null;
            const value = model;
            const modelId = String(value.id || '').trim();
            const capabilities = Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map(String).filter(item => ['text', 'vision', 'voice-asr', 'voice-tts'].includes(item)))] : [];
            return modelId && capabilities.length ? { id: modelId, name: String(value.name || modelId).trim() || modelId, capabilities } : null;
        }).filter(Boolean) : [];
        return { id, name: name.slice(0, MAX_CUSTOM_NAME), note: String(source.note || '').trim().slice(0, MAX_CUSTOM_NOTE) || undefined, baseURL, keyFile, models };
    });
}
// 为新供应商生成不可预测且仅允许安全字符的稳定标识与 Key 文件名。
function createCustomIdentity() {
    const token = crypto.randomBytes(12).toString('hex');
    return { id: `custom-${token}`, keyFile: `ai-custom-${token}-key.txt` };
}
// 提取自定义表单字段，拒绝路径、文件名和未知嵌套字段。
function readCustomInput(data, fallback) {
    const nested = data.custom && typeof data.custom === 'object' && !Array.isArray(data.custom) ? data.custom : {};
    const name = String(data.name ?? nested.name ?? fallback?.name ?? '').trim();
    const note = String(data.note ?? nested.note ?? fallback?.note ?? '').trim();
    const baseURL = String(data.baseURL ?? nested.baseURL ?? fallback?.baseURL ?? '').trim().replace(/\/+$/, '');
    if (!name || name.length > MAX_CUSTOM_NAME)
        throw new Error('供应商名称不能为空且长度不得超过 96 个字符');
    if (note.length > MAX_CUSTOM_NOTE)
        throw new Error('供应商备注长度不得超过 256 个字符');
    if (!baseURL || baseURL.length > MAX_CUSTOM_URL)
        throw new Error('请求地址不能为空且长度不得超过 2048 个字符');
    return { name, note, baseURL };
}
// 合并自定义供应商元数据，保留未参与本次导入的其他供应商。
function upsertCustomProvider(records, next) {
    const result = records.filter(item => item.id !== next.id);
    result.push(next);
    return result;
}
// 以键排序后的 JSON 比较事务回读，避免字段顺序造成假失败。
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
// 将事务错误转换为稳定 HTTP 响应，不泄露配置内容。
function sendTransactionError(res, error) {
    if (error instanceof ConfigTransactionError) {
        const status = error.code === 'API_CONFIG_BUSY' ? 409 : (error.code === 'API_CONFIG_ROLLBACK_FAILED' ? 500 : 400);
        json(res, { ok: false, message: error.message, code: error.code, transactionId: error.transactionId, stage: error.stage, files: error.files }, status);
        return;
    }
    json(res, { ok: false, message: getErrorMessage(error) }, 400);
}
// 让 AI 主插件的旧运行时配置缓存失效，以便下一次调用读取新能力配置。
function resetAiRuntimeCache() {
    try {
        loadManagementModule('core.runtimeConfig').resetConfigCache();
    }
    catch {
        console.warn('[dashboard] ai_capability_runtime_cache_reset_failed');
    }
}
// 校验能力配置文件和可选 Key 文件均与事务目标一致。
function verifyConfigReadback(expected, providerId, keyValue) {
    const actual = capabilityConfig.loadCapabilityConfigSync().config;
    const expectedNormalized = capabilityConfig.normalizeCapabilityConfig(expected);
    if (JSON.stringify(actual) !== JSON.stringify(expectedNormalized))
        throw new Error('AI 能力配置回读不一致');
    if (providerId && keyValue !== undefined) {
        const provider = capabilityConfig.getProviderCatalogEntry(providerId);
        if (!provider)
            throw new Error('供应商回读失败');
        const stored = fs.readFileSync(path.join(DATA_DIR, provider.keyFile), 'utf8');
        if (stored !== keyValue)
            throw new Error('API Key 回读不一致');
    }
}
// 首次读取时把内存中的幂等旧链迁移结果原子写入新版本文件。
function ensureCapabilityConfig() {
    const loaded = capabilityConfig.loadCapabilityConfigSync();
    if (!loaded.migrated)
        return loaded;
    const result = executeConfigTransaction({
        dataDir: DATA_DIR,
        targets: [{ name: 'ai-capability-config', filePath: capabilityConfig.CAPABILITY_CONFIG_FILE, content: capabilityConfig.serializeCapabilityConfig(loaded.config), mode: 0o600 }],
        refresh: resetAiRuntimeCache,
        verify: () => verifyConfigReadback(loaded.config),
    });
    if (result.cleanupWarning)
        console.warn('[dashboard] ai_capability_migration_cleanup_deferred');
    return { ...loaded, migrated: true };
}
// --- 配置与供应商导入路由 ---
// 返回内置及自定义供应商目录和脱敏四能力配置。
function handleGetAiModelApiConfig(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        const loaded = ensureCapabilityConfig();
        json(res, {
            ok: true,
            catalog: capabilityConfig.getPublicProviderCatalog(),
            config: capabilityConfig.getPublicCapabilityConfig(loaded.config),
            migration: { applied: loaded.migrated, diagnostics: loaded.diagnostics },
        });
    }
    catch (error) {
        sendTransactionError(res, error);
    }
}
// 独立保存内置供应商 Key 并补充参考模型，模型发现受限时仍可完成配置。
function handlePutAiProviderKey(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, body => {
        try {
            const data = parseBody(body);
            const providerId = String(data.providerId || '').trim();
            const provider = capabilityConfig.getProviderCatalogEntry(providerId);
            if (!provider || provider.custom)
                return json(res, { ok: false, message: '请选择内置供应商', code: 'PROVIDER_KEY_INVALID_PROVIDER' }, 400);
            if (typeof data.apiKey !== 'string')
                return json(res, { ok: false, message: 'API Key 必须是字符串', code: 'PROVIDER_KEY_INVALID' }, 400);
            const apiKey = data.apiKey.trim().replace(/[\r\n]+/g, '');
            if (!apiKey)
                return json(res, { ok: false, message: 'API Key 不能为空', code: 'PROVIDER_KEY_REQUIRED' }, 400);
            if (apiKey.length > 16384)
                return json(res, { ok: false, message: 'API Key 长度超出限制', code: 'PROVIDER_KEY_INVALID' }, 400);
            const next = capabilityConfig.normalizeCapabilityConfig(ensureCapabilityConfig().config);
            const pool = next.providers[providerId].models;
            const existingIds = new Set(pool.map(model => model.id));
            // 只补充缺失的内置模型，已有模型和四项能力优先级均保留。
            pool.push(...capabilityConfig.getVerifiedProviderModels(providerId).filter(model => !existingIds.has(model.id)));
            const result = executeConfigTransaction({
                dataDir: DATA_DIR,
                targets: [
                    { name: 'ai-capability-config', filePath: capabilityConfig.CAPABILITY_CONFIG_FILE, content: capabilityConfig.serializeCapabilityConfig(next), mode: 0o600 },
                    { name: 'provider-key', filePath: path.join(DATA_DIR, provider.keyFile), content: Buffer.from(apiKey, 'utf8'), mode: 0o600 },
                ],
                refresh: resetAiRuntimeCache,
                verify: () => verifyConfigReadback(next, providerId, apiKey),
            });
            json(res, {
                ok: true,
                message: 'API Key 已保存；内置参考模型已加入模型池，尚未验证该 Key 的调用权限。',
                transactionId: result.id,
                config: capabilityConfig.getPublicCapabilityConfig(next),
                catalog: capabilityConfig.getPublicProviderCatalog(),
            });
        }
        catch (error) {
            sendTransactionError(res, error);
        }
    });
}
// 用本次内存 Key 发现模型，成功后原子保存供应商定义、Key、模型池和清理后的优先级。
function handleDiscoverAiModels(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, async (body) => {
        try {
            const data = parseBody(body);
            let providerId = String(data.providerId || '').trim();
            const apiKey = String(data.apiKey || '').trim().replace(/[\r\n]+/g, '');
            if (!apiKey)
                return json(res, { ok: false, message: 'API Key 不能为空', code: 'DISCOVERY_KEY_REQUIRED' }, 400);
            if (apiKey.length > 16384)
                return json(res, { ok: false, message: 'API Key 长度超出限制', code: 'DISCOVERY_KEY_INVALID' }, 400);
            const capability = String(data.capability || 'text').trim();
            if (!capabilityConfig.isAiCapability(capability))
                return json(res, { ok: false, message: '未知能力', code: 'DISCOVERY_CAPABILITY_INVALID' }, 400);
            const isCustom = providerId === 'custom' || providerId === 'custom-new' || CUSTOM_ID_RE.test(providerId) || (!providerId && (data.name !== undefined || data.baseURL !== undefined || data.custom !== undefined));
            let provider = capabilityConfig.getProviderCatalogEntry(providerId);
            let customRecords = [];
            let customRecord;
            if (isCustom) {
                customRecords = readCustomProviders();
                if (CUSTOM_ID_RE.test(providerId))
                    customRecord = customRecords.find(item => item.id === providerId);
                const fields = readCustomInput(data, customRecord);
                if (!customRecord && providerId && providerId !== 'custom' && providerId !== 'custom-new')
                    return json(res, { ok: false, message: '未知自定义供应商', code: 'DISCOVERY_PROVIDER_INVALID' }, 400);
                if (!customRecord) {
                    const identity = createCustomIdentity();
                    providerId = identity.id;
                    customRecord = { id: identity.id, keyFile: identity.keyFile, name: fields.name, note: fields.note || undefined, baseURL: fields.baseURL, models: [] };
                }
                else {
                    customRecord = { ...customRecord, name: fields.name || customRecord.name, note: fields.note || undefined, baseURL: fields.baseURL || customRecord.baseURL };
                }
                provider = capabilityConfig.getProviderCatalogEntry(providerId);
                const models = await modelDiscovery.discoverCustomProviderModels(customRecord.baseURL, capability, apiKey);
                const importable = models.filter(model => model.importable).map(model => ({ id: model.id, name: model.name, capabilities: model.capabilities }));
                if (!importable.length)
                    return json(res, { ok: false, message: '该密钥未返回可导入模型', code: 'DISCOVERY_EMPTY', models }, 422);
                const current = ensureCapabilityConfig().config;
                if (!current.providers[providerId])
                    current.providers[providerId] = { models: [] };
                const replaced = capabilityConfig.replaceProviderModels(current, providerId, importable, capability);
                const nextCustom = { ...customRecord, models: replaced.config.providers[providerId].models };
                const nextCustomRecords = upsertCustomProvider(customRecords, nextCustom);
                const result = executeConfigTransaction({
                    dataDir: DATA_DIR,
                    targets: [
                        { name: 'custom-providers', filePath: CUSTOM_PROVIDERS_FILE, content: Buffer.from(JSON.stringify(nextCustomRecords, null, 2), 'utf8'), mode: 0o600 },
                        { name: 'ai-capability-config', filePath: capabilityConfig.CAPABILITY_CONFIG_FILE, content: capabilityConfig.serializeCapabilityConfig(replaced.config), mode: 0o600 },
                        { name: 'provider-key', filePath: path.join(DATA_DIR, nextCustom.keyFile), content: Buffer.from(apiKey, 'utf8'), mode: 0o600 },
                    ],
                    refresh: resetAiRuntimeCache,
                    verify: () => {
                        verifyConfigReadback(replaced.config, providerId, apiKey);
                        const stored = readCustomProviders();
                        if (stableJson(stored) !== stableJson(nextCustomRecords)) {
                            throw new Error('自定义供应商回读不一致');
                        }
                    },
                });
                return json(res, {
                    ok: true,
                    message: '自定义供应商与模型池已原子保存',
                    transactionId: result.id,
                    providerId,
                    models,
                    removedModels: replaced.removedModels,
                    removedSteps: replaced.removedSteps,
                    emptyCapabilities: replaced.emptyCapabilities,
                    config: capabilityConfig.getPublicCapabilityConfig(replaced.config),
                    catalog: capabilityConfig.getPublicProviderCatalog(),
                });
            }
            provider = capabilityConfig.getProviderCatalogEntry(providerId);
            if (!provider)
                return json(res, { ok: false, message: '未知供应商', code: 'DISCOVERY_PROVIDER_INVALID' }, 400);
            const models = await modelDiscovery.discoverProviderModels(providerId, apiKey);
            const importable = models.filter(model => model.importable).map(model => ({ id: model.id, name: model.name, capabilities: model.capabilities }));
            if (!importable.length) {
                return json(res, { ok: false, message: '该密钥未返回可导入模型', code: 'DISCOVERY_EMPTY', models }, 422);
            }
            const current = ensureCapabilityConfig().config;
            const replaced = capabilityConfig.replaceProviderModels(current, providerId, importable, capability);
            const result = executeConfigTransaction({
                dataDir: DATA_DIR,
                targets: [
                    { name: 'ai-capability-config', filePath: capabilityConfig.CAPABILITY_CONFIG_FILE, content: capabilityConfig.serializeCapabilityConfig(replaced.config), mode: 0o600 },
                    { name: 'provider-key', filePath: path.join(DATA_DIR, provider.keyFile), content: Buffer.from(apiKey, 'utf8'), mode: 0o600 },
                ],
                refresh: resetAiRuntimeCache,
                verify: () => verifyConfigReadback(replaced.config, providerId, apiKey),
            });
            json(res, {
                ok: true,
                message: 'API Key 与模型池已原子保存',
                transactionId: result.id,
                models,
                removedModels: replaced.removedModels,
                removedSteps: replaced.removedSteps,
                emptyCapabilities: replaced.emptyCapabilities,
                config: capabilityConfig.getPublicCapabilityConfig(replaced.config),
                catalog: capabilityConfig.getPublicProviderCatalog(),
            });
        }
        catch (error) {
            if (error instanceof modelDiscovery.ModelDiscoveryError) {
                return json(res, { ok: false, message: error.message, code: error.code }, error.status);
            }
            sendTransactionError(res, error);
        }
    });
}
// 独立保存一个能力的有序优先级，其余三项能力保持不变。
function handlePutAiCapabilityPriority(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, body => {
        try {
            const data = parseBody(body);
            const current = ensureCapabilityConfig().config;
            const next = capabilityConfig.replaceCapabilityPriority(current, data.capability, data.steps);
            const result = executeConfigTransaction({
                dataDir: DATA_DIR,
                targets: [{ name: 'ai-capability-config', filePath: capabilityConfig.CAPABILITY_CONFIG_FILE, content: capabilityConfig.serializeCapabilityConfig(next), mode: 0o600 }],
                refresh: resetAiRuntimeCache,
                verify: () => verifyConfigReadback(next),
            });
            const capability = String(data.capability || '');
            const empty = Array.isArray(next.priorities[capability])
                && (next.priorities[capability] || []).length === 0;
            json(res, {
                ok: true,
                message: empty ? '优先级已保存；该能力未配置模型' : '模型优先级已保存',
                transactionId: result.id,
                config: capabilityConfig.getPublicCapabilityConfig(next),
            });
        }
        catch (error) {
            sendTransactionError(res, error);
        }
    });
}
// --- 按能力用量聚合 ---
// 读取能力用量文件并交给日期区间聚合器；历史无能力记录不推断归类。
function buildCapabilityUsage(capability, query = {}) {
    if (!capabilityConfig.isAiCapability(capability))
        throw new Error('未知能力');
    let root = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            root = parsed;
    }
    catch {
        root = {};
    }
    return aggregateCapabilityUsage(root, capability, query);
}
// 返回当前能力的独立用量，历史无能力数据不推断也不展示。
function handleGetCapabilityUsage(req, res, _pathname, url) {
    if (!requireAdmin(req, res))
        return;
    try {
        const capability = String(url.searchParams.get('capability') || '');
        json(res, buildCapabilityUsage(capability, { startDate: url.searchParams.get('startDate'), endDate: url.searchParams.get('endDate') }));
    }
    catch (error) {
        json(res, { ok: false, message: getErrorMessage(error) }, 400);
    }
}
const routes = {
    'GET /dashboard/api/ai-model-api/config': handleGetAiModelApiConfig,
    'PUT /dashboard/api/ai-model-api/key': handlePutAiProviderKey,
    'POST /dashboard/api/ai-model-api/discover': handleDiscoverAiModels,
    'PUT /dashboard/api/ai-model-api/priority': handlePutAiCapabilityPriority,
    'GET /dashboard/api/keys/usage': handleGetCapabilityUsage,
};
module.exports = {
    routes,
    buildCapabilityUsage,
    handleGetAiModelApiConfig,
    handlePutAiProviderKey,
    handleDiscoverAiModels,
    handlePutAiCapabilityPriority,
    handleGetCapabilityUsage,
};
