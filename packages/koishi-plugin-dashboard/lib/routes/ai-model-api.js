'use strict';
const fs = require('fs');
const path = require('path');
const { json, collectBody, getErrorMessage } = require('../utils');
const { requireAdmin } = require('../auth');
const { executeConfigTransaction, ConfigTransactionError } = require('../config-transaction');
const { DATA_DIR } = require('../paths');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const TOKEN_USAGE_FILE = path.join(DATA_DIR, 'token-usage.json');
const capabilityConfig = loadManagementModule('core.aiCapabilityConfig');
const modelDiscovery = loadManagementModule('core.modelDiscovery');
// --- 通用边界 ---
// 解析一个 JSON 对象请求体，拒绝数组和基础类型。
function parseBody(body) {
    const value = JSON.parse(body || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('请求体必须是对象');
    return value;
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
// --- 配置与发现路由 ---
// 返回八家权威目录和脱敏四能力配置。
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
// 用本次内存 Key 发现模型，成功后原子保存固定 Key 槽位、模型池和清理后的优先级。
function handleDiscoverAiModels(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, async (body) => {
        try {
            const data = parseBody(body);
            const providerId = String(data.providerId || '').trim();
            const apiKey = String(data.apiKey || '').trim().replace(/[\r\n]+/g, '');
            const provider = capabilityConfig.getProviderCatalogEntry(providerId);
            if (!provider)
                return json(res, { ok: false, message: '未知供应商', code: 'DISCOVERY_PROVIDER_INVALID' }, 400);
            const models = await modelDiscovery.discoverProviderModels(providerId, apiKey);
            const importable = models.filter(model => model.importable).map(model => ({ id: model.id, name: model.name, capabilities: model.capabilities }));
            if (!importable.length) {
                return json(res, { ok: false, message: '该密钥未返回可导入模型', code: 'DISCOVERY_EMPTY', models }, 422);
            }
            const current = ensureCapabilityConfig().config;
            const replaced = capabilityConfig.replaceProviderModels(current, providerId, importable);
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
// 把未知数值规范为非负有限数。
function usageNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? number : 0;
}
// 创建一个可累计的用量统计行。
function createUsageStat(key, label = key, provider = '') {
    return { key, label, provider, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 0 };
}
// 将一个持久化统计对象累加到目标行。
function addUsageStat(target, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return;
    const source = raw;
    for (const key of ['total', 'requests', 'input', 'output', 'cacheCreation', 'cacheRead', 'readableRequests', 'unreadableRequests']) {
        target[key] += usageNumber(source[key]);
    }
    if (typeof source.provider === 'string')
        target.provider = source.provider;
}
// 从新结构中聚合一个能力；无能力字段的历史记录会被完全忽略。
function buildCapabilityUsage(capability) {
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
    const providers = new Map();
    const models = new Map();
    let readableRequests = 0;
    let unreadableRequests = 0;
    const days = Object.keys(root).sort().slice(-30).flatMap(date => {
        const rawDay = root[date];
        if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay))
            return [];
        const capabilities = rawDay.capabilities;
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))
            return [];
        const rawCapability = capabilities[capability];
        if (!rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability))
            return [];
        const source = rawCapability;
        const total = createUsageStat(date, date);
        addUsageStat(total, source);
        readableRequests += total.readableRequests;
        unreadableRequests += total.unreadableRequests;
        const dayProviders = {};
        const providerSource = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
            ? source.providers
            : {};
        for (const [key, value] of Object.entries(providerSource)) {
            const row = providers.get(key) || createUsageStat(key, key);
            addUsageStat(row, value);
            providers.set(key, row);
            dayProviders[key] = value;
        }
        const dayModels = {};
        const modelSource = source.models && typeof source.models === 'object' && !Array.isArray(source.models)
            ? source.models
            : {};
        for (const [key, value] of Object.entries(modelSource)) {
            const row = models.get(key) || createUsageStat(key, key);
            addUsageStat(row, value);
            models.set(key, row);
            dayModels[key] = value;
        }
        return [{ date, ...total, providers: dayProviders, models: dayModels }];
    });
    return {
        capability,
        days,
        providers: [...providers.values()],
        models: [...models.values()],
        readable: readableRequests > 0,
        unavailable: unreadableRequests > 0 && readableRequests === 0,
    };
}
// 返回当前能力的独立用量，历史无能力数据不推断也不展示。
function handleGetCapabilityUsage(req, res, _pathname, url) {
    if (!requireAdmin(req, res))
        return;
    try {
        const capability = String(url.searchParams.get('capability') || '');
        json(res, buildCapabilityUsage(capability));
    }
    catch (error) {
        json(res, { ok: false, message: getErrorMessage(error) }, 400);
    }
}
const routes = {
    'GET /dashboard/api/ai-model-api/config': handleGetAiModelApiConfig,
    'POST /dashboard/api/ai-model-api/discover': handleDiscoverAiModels,
    'PUT /dashboard/api/ai-model-api/priority': handlePutAiCapabilityPriority,
    'GET /dashboard/api/keys/usage': handleGetCapabilityUsage,
};
module.exports = {
    routes,
    buildCapabilityUsage,
    handleGetAiModelApiConfig,
    handleDiscoverAiModels,
    handlePutAiCapabilityPriority,
    handleGetCapabilityUsage,
};
