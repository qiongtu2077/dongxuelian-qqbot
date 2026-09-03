"use strict";
/**
 * MODULE: 受限供应商模型发现。
 * 职责: 按权威目录调用已验证的官方模型枚举协议并解析能力元数据。
 * 边界: API Key 只存在于请求内存和认证头，不写日志、不进入返回体。
 */
const { getProviderCatalogEntry, getVerifiedModelCapabilities, } = require('./ai-capability-config');
const dns = require('dns').promises;
const net = require('net');
class ModelDiscoveryError extends Error {
    // 携带稳定错误码，不包含上游响应体或认证信息。
    constructor(message, code, status = 400) {
        super(message);
        this.name = 'ModelDiscoveryError';
        this.code = code;
        this.status = status;
    }
}
const MAX_DISCOVERY_CONCURRENCY = 2;
const MAX_DISCOVERED_MODELS = 1000;
let activeDiscoveries = 0;
const discoveryWaiters = [];
const MAX_CUSTOM_REDIRECTS = 3;
const MAX_MODEL_ID_LENGTH = 256;
// 生成 CCSWITCH 风格的模型列表候选地址；完整 /models 地址保持原样。
function buildCustomDiscoveryUrls(rawBaseURL) {
    const input = String(rawBaseURL || '').trim();
    if (!input)
        return [];
    let parsed;
    try {
        parsed = new URL(input);
    }
    catch {
        return [];
    }
    const normalized = input.replace(/\/+$/, '');
    if (/\/models(?:\/)?(?:[?#].*)?$/i.test(parsed.pathname + parsed.search + parsed.hash))
        return [input];
    if (/\/v\d+(?:\.\d+)?$/i.test(parsed.pathname.replace(/\/+$/, '')))
        return [`${normalized}/models`];
    return [`${normalized}/v1/models`, `${normalized}/models`];
}
// 判断主机是否为明确的本机回环地址；HTTP 只允许这些地址。
function isLoopbackHostname(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === 'localhost.localdomain')
        return true;
    if (net.isIPv4(host))
        return host.split('.').length === 4 && Number(host.split('.')[0]) === 127;
    return net.isIPv6(host) && (host === '::1' || host === '0:0:0:0:0:0:0:1');
}
// 拒绝私网、保留、链路本地、多播和未指定地址，避免 DNS rebinding 绕过协议检查。
function isUnsafeAddress(address) {
    const value = String(address || '').trim().toLowerCase();
    if (net.isIPv4(value)) {
        const parts = value.split('.').map(Number);
        const [a, b] = parts;
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && parts[2] === 0) || (a === 192 && b === 0 && parts[2] === 2) ||
            (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && parts[2] === 100) || (a === 203 && b === 0 && parts[2] === 113) ||
            a >= 224;
    }
    if (net.isIPv6(value)) {
        if (value === '::' || value === '::1')
            return true;
        if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb'))
            return true;
        if (value.startsWith('ff'))
            return true;
        if (value.startsWith('::ffff:'))
            return isUnsafeAddress(value.slice(7));
    }
    return false;
}
// 校验自定义供应商 URL，并在域名解析后再次确认所有地址安全。
async function validateCustomDiscoveryUrl(rawURL, lookupImpl = async (hostname) => {
    const result = await dns.lookup(hostname, { all: true });
    return result;
}) {
    let url;
    try {
        url = new URL(String(rawURL || '').trim());
    }
    catch {
        throw new ModelDiscoveryError('请求地址格式无效', 'DISCOVERY_URL_INVALID', 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new ModelDiscoveryError('请求地址只允许 HTTP 或 HTTPS', 'DISCOVERY_URL_INVALID', 400);
    if (!url.hostname || url.username || url.password)
        throw new ModelDiscoveryError('请求地址不得包含用户名或密码', 'DISCOVERY_URL_INVALID', 400);
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname))
        throw new ModelDiscoveryError('公网请求地址必须使用 HTTPS；HTTP 仅允许本机回环地址', 'DISCOVERY_URL_INSECURE', 400);
    if (isUnsafeAddress(url.hostname) && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname)))
        throw new ModelDiscoveryError('请求地址命中私网或保留地址', 'DISCOVERY_SSRF_BLOCKED', 400);
    if (!net.isIP(url.hostname)) {
        let addresses;
        try {
            addresses = await lookupImpl(url.hostname);
        }
        catch {
            throw new ModelDiscoveryError('请求地址域名无法解析', 'DISCOVERY_DNS_FAILED', 400);
        }
        if (!addresses.length || (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) && addresses.some(item => isUnsafeAddress(typeof item === 'string' ? item : item.address)))
            throw new ModelDiscoveryError('请求地址解析到私网或保留地址', 'DISCOVERY_SSRF_BLOCKED', 400);
    }
    return url;
}
// --- 并发与错误边界 ---
// 在全局并发上限内执行发现请求，避免密钥失焦事件压垮上游。
async function withDiscoverySlot(task) {
    if (activeDiscoveries >= MAX_DISCOVERY_CONCURRENCY) {
        await new Promise(resolve => discoveryWaiters.push(resolve));
    }
    activeDiscoveries += 1;
    try {
        return await task();
    }
    finally {
        activeDiscoveries -= 1;
        discoveryWaiters.shift()?.();
    }
}
// 将 HTTP 状态转换为详细但不含上游正文的脱敏错误。
function throwDiscoveryHttpError(status) {
    if (status === 401 || status === 403)
        throw new ModelDiscoveryError(`供应商鉴权失败（HTTP ${status}）`, 'DISCOVERY_AUTH_FAILED', 422);
    if (status === 429)
        throw new ModelDiscoveryError('供应商限流，请稍后重试（HTTP 429）', 'DISCOVERY_RATE_LIMITED', 429);
    if (status >= 500)
        throw new ModelDiscoveryError(`供应商服务错误（HTTP ${status}）`, 'DISCOVERY_UPSTREAM_ERROR', 502);
    throw new ModelDiscoveryError(`供应商拒绝模型发现请求（HTTP ${status}）`, 'DISCOVERY_HTTP_ERROR', 422);
}
// 解析 JSON；任何原始响应内容都不会进入错误消息。
async function readDiscoveryJson(response) {
    try {
        return await response.json();
    }
    catch {
        throw new ModelDiscoveryError('供应商返回了无法解析的模型列表', 'DISCOVERY_INVALID_JSON', 502);
    }
}
// --- 协议解析 ---
// 解析 OpenAI 兼容模型列表，并仅接受精确官方能力表命中的模型。
function parseOpenAiModelList(providerId, payload) {
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.data
        : null;
    if (!Array.isArray(data))
        throw new ModelDiscoveryError('供应商模型列表缺少 data 数组', 'DISCOVERY_INVALID_RESPONSE', 502);
    return data.slice(0, MAX_DISCOVERED_MODELS).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return null;
        const id = String(item.id || '').trim();
        if (!id)
            return null;
        const capabilities = getVerifiedModelCapabilities(providerId, id);
        return {
            id,
            name: id,
            capabilities,
            importable: capabilities.length > 0,
            ...(capabilities.length ? {} : { unavailableReason: '官方枚举未提供模态，且精确能力表尚未确认该模型' }),
        };
    }).filter((model) => !!model);
}
// 解析 Anthropic 模型列表，直接使用官方 image_input 能力字段。
function parseAnthropicModelList(payload) {
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.data
        : null;
    if (!Array.isArray(data))
        throw new ModelDiscoveryError('Claude 模型列表缺少 data 数组', 'DISCOVERY_INVALID_RESPONSE', 502);
    return data.slice(0, MAX_DISCOVERED_MODELS).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return null;
        const source = item;
        const id = String(source.id || '').trim();
        if (!id)
            return null;
        const caps = source.capabilities && typeof source.capabilities === 'object' && !Array.isArray(source.capabilities)
            ? source.capabilities
            : {};
        const image = caps.image_input && typeof caps.image_input === 'object' && !Array.isArray(caps.image_input)
            ? !!caps.image_input.supported
            : false;
        return { id, name: String(source.display_name || id).trim() || id, capabilities: image ? ['text', 'vision'] : ['text'], importable: true };
    }).filter((model) => !!model);
}
// 解析 Gemini 模型列表；生成方法确认文字能力，视觉仍要求精确官方能力表。
function parseGeminiModelList(payload) {
    const models = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.models
        : null;
    if (!Array.isArray(models))
        throw new ModelDiscoveryError('Gemini 模型列表缺少 models 数组', 'DISCOVERY_INVALID_RESPONSE', 502);
    return models.slice(0, MAX_DISCOVERED_MODELS).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return null;
        const source = item;
        const resourceName = String(source.name || '').trim();
        const id = resourceName.replace(/^models\//, '');
        if (!id)
            return null;
        const methods = Array.isArray(source.supportedGenerationMethods) ? source.supportedGenerationMethods.map(String) : [];
        const verified = getVerifiedModelCapabilities('gemini', id);
        const capabilities = methods.includes('generateContent')
            ? [...new Set(['text', ...verified.filter(capability => capability === 'vision')])]
            : [];
        return {
            id,
            name: String(source.displayName || id).trim() || id,
            capabilities,
            importable: capabilities.length > 0,
            ...(capabilities.length ? {} : { unavailableReason: '该模型未声明 generateContent 能力' }),
        };
    }).filter((model) => !!model);
}
// 解析自定义 OpenAI 兼容模型列表，并把本次能力作为权威标签写入结果。
function parseCustomOpenAiModelList(payload, capability) {
    if (!['text', 'vision', 'voice-asr', 'voice-tts'].includes(String(capability)))
        throw new ModelDiscoveryError('未知能力', 'DISCOVERY_CAPABILITY_INVALID', 400);
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.data
        : null;
    if (!Array.isArray(data))
        throw new ModelDiscoveryError('供应商模型列表缺少 data 数组', 'DISCOVERY_INVALID_RESPONSE', 502);
    const result = [];
    const seen = new Set();
    for (const item of data.slice(0, MAX_DISCOVERED_MODELS)) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const id = String(item.id || '').trim();
        if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id))
            continue;
        seen.add(id);
        result.push({ id, name: id, capabilities: [String(capability)], importable: true });
    }
    return result;
}
// --- 官方请求 ---
// 构造固定官方认证头，禁止调用方传入 URL 或自定义头。
function buildDiscoveryHeaders(protocol, apiKey) {
    if (protocol === 'anthropic-models') {
        return { Accept: 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    }
    if (protocol === 'gemini-models')
        return { Accept: 'application/json', 'x-goog-api-key': apiKey };
    return { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
}
// 调用一个白名单供应商的官方模型枚举接口并返回脱敏模型元数据。
async function discoverProviderModels(providerId, apiKey, options = {}) {
    const provider = getProviderCatalogEntry(providerId);
    if (!provider)
        throw new ModelDiscoveryError('未知供应商', 'DISCOVERY_PROVIDER_INVALID', 400);
    if (provider.discoveryProtocol === 'blocked' || !provider.discoveryURL) {
        throw new ModelDiscoveryError(provider.discoveryReason || '该供应商模型发现尚未验证', 'DISCOVERY_BLOCKED', 409);
    }
    const key = String(apiKey || '').trim().replace(/[\r\n]+/g, '');
    if (!key)
        throw new ModelDiscoveryError('API Key 不能为空', 'DISCOVERY_KEY_REQUIRED', 400);
    if (key.length > 16384)
        throw new ModelDiscoveryError('API Key 长度超出限制', 'DISCOVERY_KEY_INVALID', 400);
    const fetchImpl = options.fetchImpl || fetch;
    const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || 8000));
    return withDiscoverySlot(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(provider.discoveryURL, {
                method: 'GET',
                signal: controller.signal,
                headers: buildDiscoveryHeaders(provider.discoveryProtocol, key),
            });
            if (!response.ok)
                throwDiscoveryHttpError(response.status);
            const payload = await readDiscoveryJson(response);
            if (provider.discoveryProtocol === 'anthropic-models')
                return parseAnthropicModelList(payload);
            if (provider.discoveryProtocol === 'gemini-models')
                return parseGeminiModelList(payload);
            return parseOpenAiModelList(provider.id, payload);
        }
        catch (error) {
            if (error instanceof ModelDiscoveryError)
                throw error;
            const name = error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
            if (name === 'AbortError')
                throw new ModelDiscoveryError('模型发现请求超时', 'DISCOVERY_TIMEOUT', 504);
            throw new ModelDiscoveryError('模型发现网络请求失败', 'DISCOVERY_NETWORK_ERROR', 502);
        }
        finally {
            clearTimeout(timer);
        }
    });
}
// 跟随有限次手动重定向，每一跳都重新执行 URL/DNS SSRF 校验。
async function fetchCustomDiscoveryUrl(url, apiKey, options) {
    const fetchImpl = options.fetchImpl || fetch;
    let current = url;
    for (let redirect = 0; redirect <= MAX_CUSTOM_REDIRECTS; redirect += 1) {
        const response = await fetchImpl(current.toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: options.signal,
            headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        });
        if (response.status < 300 || response.status >= 400)
            return response;
        if (redirect === MAX_CUSTOM_REDIRECTS)
            throw new ModelDiscoveryError('供应商重定向次数过多', 'DISCOVERY_REDIRECT_LIMIT', 502);
        const location = response.headers?.get?.('location');
        if (!location)
            throw new ModelDiscoveryError('供应商重定向缺少目标地址', 'DISCOVERY_REDIRECT_INVALID', 502);
        current = await validateCustomDiscoveryUrl(new URL(location, current).toString(), options.lookupImpl);
    }
    throw new ModelDiscoveryError('供应商重定向失败', 'DISCOVERY_REDIRECT_INVALID', 502);
}
// 发现自定义 OpenAI 兼容供应商模型；地址候选和当前能力由调用方明确提供。
async function discoverCustomProviderModels(baseURL, capability, apiKey, options = {}) {
    const key = String(apiKey || '').trim().replace(/[\r\n]+/g, '');
    if (!key)
        throw new ModelDiscoveryError('API Key 不能为空', 'DISCOVERY_KEY_REQUIRED', 400);
    if (key.length > 16384)
        throw new ModelDiscoveryError('API Key 长度超出限制', 'DISCOVERY_KEY_INVALID', 400);
    if (!['text', 'vision', 'voice-asr', 'voice-tts'].includes(String(capability)))
        throw new ModelDiscoveryError('未知能力', 'DISCOVERY_CAPABILITY_INVALID', 400);
    const candidates = buildCustomDiscoveryUrls(baseURL);
    if (!candidates.length)
        throw new ModelDiscoveryError('请求地址格式无效', 'DISCOVERY_URL_INVALID', 400);
    const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || 8000));
    return withDiscoverySlot(async () => {
        let lastError = null;
        for (const candidate of candidates) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const safeURL = await validateCustomDiscoveryUrl(candidate, options.lookupImpl);
                const response = await fetchCustomDiscoveryUrl(safeURL, key, { ...options, signal: controller.signal });
                if (!response.ok) {
                    if (response.status === 404) {
                        lastError = new ModelDiscoveryError('模型列表路径不存在', 'DISCOVERY_HTTP_ERROR', 422);
                        continue;
                    }
                    throwDiscoveryHttpError(response.status);
                }
                return parseCustomOpenAiModelList(await readDiscoveryJson(response), capability);
            }
            catch (error) {
                if (error instanceof ModelDiscoveryError) {
                    lastError = error;
                    if (error.code === 'DISCOVERY_HTTP_ERROR' && /不存在/.test(error.message))
                        continue;
                    throw error;
                }
                const name = error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
                lastError = name === 'AbortError' ? new ModelDiscoveryError('模型发现请求超时', 'DISCOVERY_TIMEOUT', 504) : new ModelDiscoveryError('模型发现网络请求失败', 'DISCOVERY_NETWORK_ERROR', 502);
                if (candidates.length > 1)
                    continue;
            }
            finally {
                clearTimeout(timer);
            }
        }
        throw lastError || new ModelDiscoveryError('模型发现失败', 'DISCOVERY_NETWORK_ERROR', 502);
    });
}
module.exports = {
    ModelDiscoveryError,
    parseOpenAiModelList,
    parseAnthropicModelList,
    parseGeminiModelList,
    parseCustomOpenAiModelList,
    buildCustomDiscoveryUrls,
    validateCustomDiscoveryUrl,
    isUnsafeAddress,
    discoverCustomProviderModels,
    discoverProviderModels,
};
