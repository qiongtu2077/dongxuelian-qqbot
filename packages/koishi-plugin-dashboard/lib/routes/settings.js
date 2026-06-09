'use strict';
const fs = require('fs');
const path = require('path');
const { json, collectBody, readFileSyncSafe, writeFileSyncSafe } = require('../utils');
const { requireAdmin } = require('../auth');
const { DATA_DIR, AI_LIB, CUSTOM_PROVIDERS_FILE, FALLBACK_CHAINS_FILE } = require('../paths');
const DEFAULT_FALLBACK_CHAINS = {
    chat: [
        { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
        { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
    ],
    vision: [
        { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
        { provider: 'mimorium', model: 'mimo-v2-omni', keyFile: 'ai-mimorium-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
    ],
    lightweight: [
        { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
        { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
        { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
    ],
};
const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json');
const WHITELIST_TYPES = ['summary', 'random', 'userBlacklist', 'videoBlacklist'];
const whitelistFiles = {
    summary: { file: 'summary-whitelist.json', label: '解除上限群白名单', type: 'array' },
    random: { file: 'ai-random-whitelist.json', label: '群聊AI白名单', type: 'array' },
    userBlacklist: { file: 'ai-user-blacklist.json', label: '用户黑名单', type: 'array' },
    videoBlacklist: { file: 'video-blacklist.json', label: '视频黑名单', type: 'object', default: { groups: [], users: [] } },
};
function requireToolDefinition(tool) {
    if (!tool.definition)
        throw new TypeError("Cannot read properties of undefined (reading 'name')");
    return tool.definition;
}
function getErrorMessage(error) {
    if (error && typeof error === 'object' && 'message' in error)
        return String(error.message || '');
    return String(error || '');
}
function getLegacyErrorMessage(error) {
    return error && typeof error === 'object' && 'message' in error ? error.message : undefined;
}
function parseJsonObject(body) {
    const data = JSON.parse(body || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function isWhitelistType(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(whitelistFiles, value);
}
function isWritableKeyFile(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+-key\.txt$/.test(value);
}
function isSafeProviderId(value) {
    return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
}
function isValidProviderBaseURL(value) {
    if (typeof value !== 'string' || !value.trim())
        return false;
    try {
        const url = new URL(value.trim());
        return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
function readBuiltinProviders() {
    try {
        const { PROVIDERS } = require(path.join(AI_LIB, 'core', 'constants'));
        return PROVIDERS || {};
    }
    catch {
        return {};
    }
}
function normalizeProviderModel(value) {
    if (typeof value === 'string') {
        const id = value.trim();
        return id ? { id } : null;
    }
    if (!isRecord(value))
        return null;
    const id = String(value.id || '').trim();
    if (!id)
        return null;
    const name = String(value.name || '').trim();
    return {
        id,
        ...(name ? { name } : {}),
        vision: !!value.vision,
    };
}
function normalizeCustomProvider(value, builtinProviders) {
    if (!isRecord(value))
        throw new Error('供应商配置必须是对象');
    const id = String(value.id || '').trim();
    if (!isSafeProviderId(id))
        throw new Error('供应商 ID 只能包含小写字母、数字、短横线和下划线');
    if (Object.prototype.hasOwnProperty.call(builtinProviders, id))
        throw new Error(`供应商 ID 已被内置供应商占用: ${id}`);
    const name = String(value.name || '').trim();
    if (!name)
        throw new Error('供应商名称不能为空');
    const baseURL = String(value.baseURL || '').trim().replace(/\/+$/, '');
    if (!isValidProviderBaseURL(baseURL))
        throw new Error('Base URL 必须是 http 或 https 地址');
    const rawKeyFile = String(value.keyFile || '').trim();
    if (rawKeyFile && !isWritableKeyFile(rawKeyFile))
        throw new Error('Key 文件名必须是不含路径的 *-key.txt');
    const models = Array.isArray(value.models)
        ? value.models.map(normalizeProviderModel).filter((item) => !!item)
        : [];
    if (!models.length)
        throw new Error('至少需要保留一个有效模型 ID');
    return { id, name, baseURL, keyFile: rawKeyFile, models };
}
function readCustomProviderConfigs(strict = false) {
    try {
        const raw = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'));
        if (!Array.isArray(raw))
            return [];
        const builtinProviders = readBuiltinProviders();
        const result = [];
        for (const item of raw) {
            try {
                result.push(normalizeCustomProvider(item, builtinProviders));
            }
            catch (error) {
                if (strict)
                    throw error;
            }
        }
        return result;
    }
    catch (error) {
        if (strict)
            throw error;
        return [];
    }
}
function normalizeCustomProviderList(data) {
    if (!Array.isArray(data))
        throw new Error('参数错误');
    const builtinProviders = readBuiltinProviders();
    const seenIds = new Set();
    const cleaned = data.map(item => normalizeCustomProvider(item, builtinProviders));
    for (const provider of cleaned) {
        if (seenIds.has(provider.id))
            throw new Error(`供应商 ID 重复: ${provider.id}`);
        seenIds.add(provider.id);
    }
    return cleaned;
}
function resetRuntimeConfigCache() {
    try {
        require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache();
    }
    catch { /* non-critical: cache reset best effort */ }
}
function providerIdFromKeyFile(file) {
    const map = {
        'ai-openai-key.txt': 'opencode',
        'ai-deepseek-key.txt': 'deepseek',
        'ai-dashscope-key.txt': 'dashscope',
        'ai-glm-key.txt': 'glm',
        'ai-mimorium-key.txt': 'mimorium',
    };
    return map[file] || file.replace(/^ai-/, '').replace(/-key\.txt$/, '');
}
function normalizeToolChannel(value) {
    return value === 'qq' || value === 'dashboard' ? value : 'dashboard';
}
function handleGetWhitelist(req, res) {
    if (!requireAdmin(req, res))
        return;
    const result = {};
    for (const key of WHITELIST_TYPES) {
        const cfg = whitelistFiles[key];
        try {
            result[key] = { label: cfg.label, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.file), 'utf8')) };
        }
        catch {
            result[key] = { label: cfg.label, data: cfg.default || [] };
        }
    }
    return json(res, result);
}
function handlePutWhitelist(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { type, data } = parseJsonObject(body);
            if (!isWhitelistType(type))
                return json(res, { ok: false, message: '无效类型' }, 400);
            const cfg = whitelistFiles[type];
            writeFileSyncSafe(path.join(DATA_DIR, cfg.file), JSON.stringify(data, null, 2));
            resetRuntimeConfigCache();
            json(res, { ok: true, message: cfg.label + ' 已更新' });
        }
        catch (e) {
            json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
function handleGetKeys(req, res) {
    if (!requireAdmin(req, res))
        return;
    const keyFiles = [
        { name: 'OpenAI/OpenCode', file: 'ai-openai-key.txt' },
        { name: 'DeepSeek 官方', file: 'ai-deepseek-key.txt' },
        { name: '阿里云 DashScope', file: 'ai-dashscope-key.txt' },
        { name: '智谱 GLM', file: 'ai-glm-key.txt' },
        { name: '小米 MiMo', file: 'ai-mimorium-key.txt' },
    ];
    const builtinSummaries = keyFiles.map((k) => {
        const content = readFileSyncSafe(path.join(DATA_DIR, k.file));
        return {
            label: k.name,
            file: k.file,
            exists: !!content,
            prefix: content ? content.slice(0, 8) + '****' : '',
            source: 'builtin',
            providerId: k.providerId || providerIdFromKeyFile(k.file),
        };
    });
    const customSummaries = readCustomProviderConfigs().map((provider) => {
        if (!provider.keyFile)
            return null;
        const content = readFileSyncSafe(path.join(DATA_DIR, provider.keyFile));
        return {
            label: provider.name,
            file: provider.keyFile,
            exists: !!content,
            prefix: content ? content.slice(0, 8) + '****' : '',
            source: 'custom',
            providerId: provider.id,
            baseURL: provider.baseURL,
            models: provider.models,
        };
    }).filter((item) => !!item);
    return json(res, [...builtinSummaries, ...customSummaries]);
}
function isRecord(value) {
    return !!value && typeof value === 'object';
}
function handleGetKeysUsage(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        const usageFile = path.join(DATA_DIR, 'token-usage.json');
        if (!fs.existsSync(usageFile))
            return json(res, { days: [], providers: [], models: [] });
        const raw = fs.readFileSync(usageFile, 'utf8');
        const parsed = JSON.parse(raw);
        const data = isRecord(parsed) ? parsed : {};
        const providers = new Map();
        const models = new Map();
        const toNum = (value) => {
            const n = Number(value || 0);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        const addStat = (map, key, patch = {}) => {
            if (!key)
                return;
            const current = map.get(key) || { key, label: key, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
            current.label = patch.label || current.label || key;
            current.provider = patch.provider || current.provider || '';
            current.total += toNum(patch.total);
            current.requests += toNum(patch.requests);
            current.input += toNum(patch.input);
            current.output += toNum(patch.output);
            current.cacheCreation += toNum(patch.cacheCreation);
            current.cacheRead += toNum(patch.cacheRead);
            map.set(key, current);
        };
        const unknownModelKey = (provider) => `${provider || 'unknown'}:unknown`;
        const normalizeModelKey = (model, provider = '') => {
            const raw = String(model || '').trim();
            const prov = String(provider || '').trim() || raw.split(':')[0];
            if (!raw)
                return unknownModelKey(prov);
            if (/:(?:legacy|unknown)$/i.test(raw))
                return unknownModelKey(prov);
            return raw;
        };
        const addDayModelStat = (dayModels, key, patch = {}) => {
            if (!key)
                return;
            const current = dayModels[key] || { provider: patch.provider || '', total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
            current.provider = patch.provider || current.provider || '';
            current.total += toNum(patch.total);
            current.requests += toNum(patch.requests);
            current.input += toNum(patch.input);
            current.output += toNum(patch.output);
            current.cacheCreation += toNum(patch.cacheCreation);
            current.cacheRead += toNum(patch.cacheRead);
            dayModels[key] = current;
        };
        const addMetric = (target, provider, patch = {}) => {
            if (!provider)
                return;
            const current = target[provider] || { total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
            current.total += toNum(patch.total);
            current.requests += toNum(patch.requests);
            current.input += toNum(patch.input);
            current.output += toNum(patch.output);
            current.cacheCreation += toNum(patch.cacheCreation);
            current.cacheRead += toNum(patch.cacheRead);
            target[provider] = current;
        };
        const reservedDayKeys = new Set(['date', 'total', 'input', 'output', 'cacheCreation', 'cacheRead', 'requests', 'models']);
        const providerLabel = (p) => p === 'opencode' ? 'OpenCode' : p === 'glm' ? 'GLM' : p === 'dashscope' ? '阿里云' : p === 'deepseek' ? 'DeepSeek' : p === 'mimorium' ? 'MiMo' : p;
        const days = Object.keys(data).sort().slice(-30).map((date) => {
            const rawSource = data[date];
            const source = isRecord(rawSource) ? rawSource : {};
            const day = { date, total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, models: {} };
            const sourceProviders = isRecord(source.providers) ? source.providers : null;
            if (sourceProviders) {
                const providerTotals = {};
                const modelTotalsByProvider = {};
                for (const [prov, stat] of Object.entries(sourceProviders)) {
                    const statObj = isRecord(stat) ? stat : {};
                    const value = isRecord(stat) ? toNum(statObj.total) : toNum(stat);
                    providerTotals[prov] = value;
                    day[prov] = value;
                    addStat(providers, prov, {
                        label: providerLabel(prov),
                        total: value,
                        requests: statObj.requests,
                        input: statObj.input,
                        output: statObj.output,
                        cacheCreation: statObj.cacheCreation,
                        cacheRead: statObj.cacheRead,
                    });
                }
                const sourceModels = isRecord(source.models) ? source.models : {};
                for (const [model, stat] of Object.entries(sourceModels)) {
                    const statObj = isRecord(stat) ? stat : {};
                    const provider = statObj.provider || String(model || '').split(':')[0];
                    const modelKey = normalizeModelKey(model, provider);
                    const modelTotal = toNum(statObj.total);
                    if (provider)
                        addMetric(modelTotalsByProvider, provider, {
                            total: modelTotal,
                            requests: statObj.requests,
                            input: statObj.input,
                            output: statObj.output,
                            cacheCreation: statObj.cacheCreation,
                            cacheRead: statObj.cacheRead,
                        });
                    addDayModelStat(day.models, modelKey, {
                        provider,
                        total: modelTotal,
                        requests: toNum(statObj.requests),
                        input: toNum(statObj.input),
                        output: toNum(statObj.output),
                        cacheCreation: toNum(statObj.cacheCreation),
                        cacheRead: toNum(statObj.cacheRead),
                    });
                    addStat(models, modelKey, {
                        label: /:(?:legacy|unknown)$/i.test(String(model || '')) ? `${providerLabel(provider)} 未分模型` : modelKey,
                        provider,
                        total: modelTotal,
                        requests: statObj.requests,
                        input: statObj.input,
                        output: statObj.output,
                        cacheCreation: statObj.cacheCreation,
                        cacheRead: statObj.cacheRead,
                    });
                }
                for (const [prov, total] of Object.entries(providerTotals)) {
                    const modelStat = modelTotalsByProvider[prov] || { total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
                    const residual = total - toNum(modelStat.total);
                    if (residual > 0) {
                        const providerSource = sourceProviders[prov];
                        const providerStat = isRecord(providerSource) ? providerSource : {};
                        const residualKey = unknownModelKey(prov);
                        const residualPatch = {
                            provider: prov,
                            total: residual,
                            requests: Math.max(0, toNum(providerStat.requests) - toNum(modelStat.requests)),
                            input: Math.max(0, toNum(providerStat.input) - toNum(modelStat.input)),
                            output: Math.max(0, toNum(providerStat.output) - toNum(modelStat.output)),
                            cacheCreation: Math.max(0, toNum(providerStat.cacheCreation) - toNum(modelStat.cacheCreation)),
                            cacheRead: Math.max(0, toNum(providerStat.cacheRead) - toNum(modelStat.cacheRead)),
                        };
                        addDayModelStat(day.models, residualKey, residualPatch);
                        addStat(models, residualKey, {
                            label: `${providerLabel(prov)} 未分模型`,
                            ...residualPatch,
                        });
                    }
                }
                day.total = toNum(source.total) || Object.keys(day).reduce((sum, key) => sum + (reservedDayKeys.has(key) ? 0 : toNum(day[key])), 0);
                day.requests = toNum(source.requests);
                day.input = toNum(source.input);
                day.output = toNum(source.output);
                day.cacheCreation = toNum(source.cacheCreation);
                day.cacheRead = toNum(source.cacheRead);
            }
            else {
                for (const [prov, count] of Object.entries(source)) {
                    const value = toNum(count);
                    day[prov] = value;
                    day.total += value;
                    addStat(providers, prov, { label: providerLabel(prov), total: value });
                    if (!reservedDayKeys.has(prov)) {
                        const legacyKey = unknownModelKey(prov);
                        addDayModelStat(day.models, legacyKey, { provider: prov, total: value });
                        addStat(models, legacyKey, {
                            label: `${providerLabel(prov)} 未分模型`,
                            provider: prov,
                            total: value,
                        });
                    }
                }
            }
            return day;
        });
        return json(res, { days, providers: [...providers.values()], models: [...models.values()] });
    }
    catch {
        return json(res, { days: [], providers: [], models: [] });
    }
}
function handlePutKeys(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const data = parseJsonObject(body);
            const file = data.file;
            if (!isWritableKeyFile(file))
                return json(res, { ok: false, message: '无效文件名' }, 400);
            writeFileSyncSafe(path.join(DATA_DIR, file), data.value);
            resetRuntimeConfigCache();
            json(res, { ok: true, message: 'Key 已更新' });
        }
        catch (e) {
            json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
function handleGetCustomProviders(req, res) {
    if (!requireAdmin(req, res))
        return;
    return json(res, readCustomProviderConfigs());
}
function handlePutCustomProviders(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const data = JSON.parse(body);
            if (!Array.isArray(data))
                return json(res, { ok: false, message: '参数错误' }, 400);
            fs.writeFileSync(CUSTOM_PROVIDERS_FILE + '.tmp', JSON.stringify(normalizeCustomProviderList(data), null, 2), 'utf8');
            fs.renameSync(CUSTOM_PROVIDERS_FILE + '.tmp', CUSTOM_PROVIDERS_FILE);
            resetRuntimeConfigCache();
            json(res, { ok: true, message: '自定义供应商已更新' });
        }
        catch (e) {
            json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
function handleGetFallback(req, res) {
    if (!requireAdmin(req, res))
        return;
    function buildProviderMap() {
        try {
            const registry = require(path.join(AI_LIB, 'core', 'provider-registry'));
            const merged = registry.getMergedProviderMapSync();
            const publicMap = {};
            for (const [id, provider] of Object.entries(merged)) {
                publicMap[id] = {
                    name: provider.name,
                    baseURL: provider.baseURL,
                    models: Array.isArray(provider.models) ? provider.models : [],
                    keyFile: provider.keyFile,
                };
            }
            return publicMap;
        }
        catch {
            const ps = {};
            const { PROVIDERS: pDefs } = require(path.join(AI_LIB, 'core', 'constants'));
            for (const key of Object.keys(pDefs))
                ps[key] = pDefs[key];
            return ps;
        }
    }
    try {
        const raw = fs.readFileSync(FALLBACK_CHAINS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return json(res, { chains: data, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() });
    }
    catch {
        return json(res, { chains: DEFAULT_FALLBACK_CHAINS, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() });
    }
}
function handlePutFallback(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { chains } = parseJsonObject(body);
            if (!isRecord(chains))
                return json(res, { ok: false, message: '参数错误' }, 400);
            const tmp = FALLBACK_CHAINS_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), 'utf8');
            fs.renameSync(tmp, FALLBACK_CHAINS_FILE);
            resetRuntimeConfigCache();
            json(res, { ok: true, message: 'Fallback 链已更新' });
        }
        catch (e) {
            json(res, { ok: false, message: getErrorMessage(e) }, 400);
        }
    });
}
function handleGetFeatures(req, res) {
    const root = require('../..');
    return json(res, root.FEATURES_DATA || []);
}
function handleGetCommands(req, res) {
    const root = require('../..');
    return json(res, root.COMMANDS_DATA || []);
}
function handleGetAdminIds(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        const raw = fs.readFileSync(ADMIN_IDS_FILE, 'utf8');
        const ids = JSON.parse(raw);
        return json(res, { ids: Array.isArray(ids) ? ids : [] });
    }
    catch {
        return json(res, { ids: [] });
    }
}
function handlePutAdminIds(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { ids } = parseJsonObject(body);
            if (!Array.isArray(ids))
                return json(res, { ok: false, message: '参数错误' }, 400);
            const cleaned = ids.map(String).filter(Boolean);
            const tmp = ADMIN_IDS_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2), 'utf8');
            fs.renameSync(tmp, ADMIN_IDS_FILE);
            try {
                require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache();
            }
            catch { /* non-critical: cache reset best effort */ }
            return json(res, { ok: true, message: '管理员列表已更新' });
        }
        catch {
            return json(res, { ok: false, message: '无效请求' }, 400);
        }
    });
}
function handleGetTools(req, res) {
    try {
        const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry'));
        const agentConfig = require(path.join(AI_LIB, 'agent', 'config')).getAgentConfig(true);
        const tools = Object.values(registry.toolRegistry).map(tool => {
            const definition = requireToolDefinition(tool);
            const name = definition.name;
            return {
                name,
                description: definition.description || '',
                dangerous: !!tool.dangerous,
                external: name === 'web_search',
                defaultChannels: tool.defaultChannels || ['dashboard', 'qq'],
                channels: {
                    qq: !!agentConfig.channels?.qq?.tools?.[String(name)],
                    dashboard: !!agentConfig.channels?.dashboard?.tools?.[String(name)],
                },
            };
        });
        return json(res, { ok: true, tools });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
function handleGetToolsPending(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        const pendingModule = require(path.join(AI_LIB, 'agent', 'pending'));
        const p = pendingModule.getPendingTool('dashboard', 'dashboard');
        const pending = pendingModule.listPendingTools ? pendingModule.listPendingTools() : [];
        return json(res, { ok: true, pending: pending.length ? pending : (p ? [{ id: p.id, toolName: p.toolName, expireAt: p.expireAt }] : []) });
    }
    catch (e) {
        return json(res, { ok: false, message: getErrorMessage(e) }, 500);
    }
}
const routes = {
    'GET /dashboard/api/whitelist': handleGetWhitelist,
    'PUT /dashboard/api/whitelist': handlePutWhitelist,
    'GET /dashboard/api/keys': handleGetKeys,
    'GET /dashboard/api/keys/usage': handleGetKeysUsage,
    'PUT /dashboard/api/keys': handlePutKeys,
    'GET /dashboard/api/providers/custom': handleGetCustomProviders,
    'PUT /dashboard/api/providers/custom': handlePutCustomProviders,
    'GET /dashboard/api/fallback': handleGetFallback,
    'PUT /dashboard/api/fallback': handlePutFallback,
    'GET /dashboard/api/features': handleGetFeatures,
    'GET /dashboard/api/commands': handleGetCommands,
    'GET /dashboard/api/admin-ids': handleGetAdminIds,
    'PUT /dashboard/api/admin-ids': handlePutAdminIds,
    'GET /dashboard/api/tools': handleGetTools,
    'GET /dashboard/api/tools/pending': handleGetToolsPending,
};
const regexRoutes = [
    { pattern: /^\/dashboard\/api\/tools\/([^/]+)\/enabled$/, method: 'PUT', handler: (req, res, match) => {
            if (!requireAdmin(req, res))
                return;
            collectBody(req, res, async (body) => {
                try {
                    const data = JSON.parse(body || '{}');
                    const toolName = decodeURIComponent(match[1]);
                    const channel = normalizeToolChannel(data.channel);
                    const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry'));
                    if (!registry.toolRegistry[toolName])
                        return json(res, { ok: false, message: '未知工具' }, 404);
                    const saved = await require(path.join(AI_LIB, 'agent', 'config')).setToolEnabled(channel, toolName, !!data.enabled);
                    return json(res, { ok: true, config: saved });
                }
                catch (e) {
                    return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
                }
            });
        } },
    { pattern: /^\/dashboard\/api\/tools\/pending\/([^/]+)\/approve$/, method: 'POST', handler: async (req, res, match) => {
            if (!requireAdmin(req, res))
                return;
            try {
                const pending = require(path.join(AI_LIB, 'agent', 'pending'));
                const pendingId = decodeURIComponent(match[1]);
                const findPendingById = pending.findPendingToolById || pending.getPendingToolById || ((id) => (pending.listPendingTools && pending.listPendingTools().find(item => item.id === id)) || null);
                const p = findPendingById(pendingId);
                if (!p)
                    return json(res, { ok: false, message: '没有匹配的待确认工具' }, 404);
                const workerSubmission = require(path.join(AI_LIB, 'agent', 'worker-submission'));
                const agentPayload = require(path.join(AI_LIB, 'resource-workers', 'agent-payload'));
                const agentConfig = require(path.join(AI_LIB, 'agent', 'config')).getAgentConfig();
                const resumeInput = { channelKey: p.channelKey, userId: p.userId, channel: p.channel || 'dashboard', expectedId: pendingId };
                const submission = workerSubmission.submitAgentWorkerTask({
                    channel: p.channel || 'dashboard',
                    channelKey: p.channelKey,
                    userId: p.userId,
                    timeoutMs: agentConfig.queue?.timeoutMs,
                    maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
                    source: 'dashboard-standalone',
                    payload: { entry: 'settings-pending-approve', pendingId, agentWorker: agentPayload.createAgentResumeWorkerPayload('settings-pending-approve', resumeInput, p) },
                });
                return json(res, {
                    ok: submission.accepted,
                    async: true,
                    toolName: p.toolName,
                    taskId: submission.taskId || '',
                    status: submission.accepted ? 'accepted' : 'blocked',
                    message: submission.message,
                }, submission.status || 202);
            }
            catch (e) {
                return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500);
            }
        } },
];
module.exports = { routes, regexRoutes };
