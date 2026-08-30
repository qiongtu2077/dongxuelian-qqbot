"use strict";
/**
 * MODULE: AI API 调用。
 * 职责: requestChatCompletions + fallback 链 + 图片/转发拉取。
 * 边界: 不存 conversation，不做业务判断。结果返回给调用方（chat.js）处理。
 */
const { PROVIDERS, REQUEST_TIMEOUT, GLM_KEY_FILE, DASHSCOPE_KEY_FILE, MIMORIUM_KEY_FILE, FALLBACK_CHAINS_FILE, DATA_DIR } = require('./constants');
const { readTextFile, isDashScopeConfig, todayCst, validatePublicHttpUrl, resolveAndValidateHostname, errorMessage } = require('./utils');
const { readCustomProvidersSync, resolveProviderDefinitionSync, resolveProviderApiKeySync, resolveProviderKeyFile, } = require('./provider-registry');
const { resolveOneBotWsUrl } = require('./onebot-endpoint');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const MAX_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_IMAGE_BYTES, 4 * 1024 * 1024, 128 * 1024, 16 * 1024 * 1024);
const MAX_REMOTE_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_REMOTE_IMAGE_BYTES, MAX_IMAGE_BYTES, 128 * 1024, 16 * 1024 * 1024);
const MAX_API_CONFIG_FILE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_API_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024);
const MAX_API_KEY_FILE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_API_KEY_MAX_BYTES, 64 * 1024, 1 * 1024, 256 * 1024);
const REQUEST_TIMEOUT_CAP = parseApiPositiveInt(process.env.AI_REQUEST_TIMEOUT_CAP_MS, 300000, 5000, 600000);
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function parseApiPositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
const TOKEN_USAGE_FILE = path.join(DATA_DIR, 'token-usage.json');
const TOKEN_USAGE_EXIT_HOOK = Symbol.for('dongxuelian.ai.tokenUsageExitHook');
const TOKEN_USAGE_EXIT_FLUSH = Symbol.for('dongxuelian.ai.tokenUsageExitFlush');
const tokenUsageGlobal = globalThis;
let _tokenUsageCache = null;
let _tokenUsageFlushTimer = null;
// 记录不会阻断请求、但会导致 token 用量磁盘状态滞后的写入失败。
function warnTokenUsagePersistence(stage, error) {
    console.warn(`[ai-api] token_usage_persistence_failed stage=${stage} detail=${errorMessage(error)}`);
}
function usageNumber(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function normalizeTokenUsageDay(day) {
    if (!day || typeof day !== 'object' || Array.isArray(day))
        return { providers: {}, models: {}, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    const source = day;
    if (isRecord(source.providers)) {
        return {
            providers: source.providers,
            models: isRecord(source.models) ? source.models : {},
            total: usageNumber(source.total),
            requests: usageNumber(source.requests),
            input: usageNumber(source.input),
            output: usageNumber(source.output),
            cacheCreation: usageNumber(source.cacheCreation),
            cacheRead: usageNumber(source.cacheRead),
        };
    }
    const providers = {};
    let total = 0;
    for (const [key, value] of Object.entries(day)) {
        const amount = usageNumber(value);
        if (!key || amount <= 0)
            continue;
        providers[key] = { total: amount, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        total += amount;
    }
    return { providers, models: {}, total, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}
function readUsageDetails(usage = {}) {
    const input = usageNumber(usage.prompt_tokens || usage.input_tokens || usage.inputTokens);
    const output = usageNumber(usage.completion_tokens || usage.output_tokens || usage.completionTokens || usage.outputTokens);
    const cacheRead = usageNumber(usage.cache_read_tokens
        || usage.cache_read_input_tokens
        || usage.cached_tokens
        || usage.prompt_tokens_details?.cached_tokens
        || usage.input_tokens_details?.cached_tokens);
    const cacheCreation = usageNumber(usage.cache_creation_tokens
        || usage.cache_creation_input_tokens
        || usage.prompt_tokens_details?.cache_creation_tokens
        || usage.input_tokens_details?.cache_creation_tokens);
    return { input, output, cacheCreation, cacheRead };
}
function bumpUsageStat(target, delta) {
    target.total = usageNumber(target.total) + usageNumber(delta.total);
    target.requests = usageNumber(target.requests) + 1;
    target.input = usageNumber(target.input) + usageNumber(delta.input);
    target.output = usageNumber(target.output) + usageNumber(delta.output);
    target.cacheCreation = usageNumber(target.cacheCreation) + usageNumber(delta.cacheCreation);
    target.cacheRead = usageNumber(target.cacheRead) + usageNumber(delta.cacheRead);
}
function recordTokenUsage(provider, tokens, details = {}) {
    if (!provider || !tokens || tokens <= 0)
        return;
    const date = todayCst();
    if (!_tokenUsageCache) {
        try {
            const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            _tokenUsageCache = isRecord(parsed) ? parsed : {};
        }
        catch {
            _tokenUsageCache = {};
        }
    }
    const usageCache = _tokenUsageCache;
    const day = normalizeTokenUsageDay(usageCache[date]);
    usageCache[date] = day;
    const usage = readUsageDetails(details.usage || {});
    const delta = {
        total: usageNumber(tokens),
        input: usage.input,
        output: usage.output,
        cacheCreation: usage.cacheCreation,
        cacheRead: usage.cacheRead,
    };
    const providerKey = String(provider || 'unknown');
    if (!day.providers[providerKey] || typeof day.providers[providerKey] !== 'object') {
        day.providers[providerKey] = { total: usageNumber(day.providers[providerKey]), requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    }
    bumpUsageStat(day.providers[providerKey], delta);
    const modelKey = String(details.model || '').trim();
    if (modelKey) {
        if (!day.models[modelKey] || typeof day.models[modelKey] !== 'object')
            day.models[modelKey] = { provider: providerKey, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        day.models[modelKey].provider = providerKey;
        bumpUsageStat(day.models[modelKey], delta);
    }
    bumpUsageStat(day, delta);
    if (!_tokenUsageFlushTimer) {
        _tokenUsageFlushTimer = setTimeout(() => {
            _tokenUsageFlushTimer = null;
            try {
                fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(_tokenUsageCache, null, 2));
            }
            catch (error) {
                warnTokenUsagePersistence('delayed_flush', error);
            }
        }, 5000);
    }
}
function flushTokenUsage() {
    if (_tokenUsageCache && _tokenUsageFlushTimer) {
        clearTimeout(_tokenUsageFlushTimer);
        _tokenUsageFlushTimer = null;
        try {
            fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(_tokenUsageCache, null, 2));
        }
        catch (error) {
            warnTokenUsagePersistence('exit_flush', error);
        }
    }
}
tokenUsageGlobal[TOKEN_USAGE_EXIT_FLUSH] = flushTokenUsage;
if (!tokenUsageGlobal[TOKEN_USAGE_EXIT_HOOK]) {
    tokenUsageGlobal[TOKEN_USAGE_EXIT_HOOK] = true;
    process.on('exit', () => {
        const handler = tokenUsageGlobal[TOKEN_USAGE_EXIT_FLUSH];
        if (typeof handler === 'function')
            handler();
    });
}
function mimeFromImagePath(filePath = '') {
    const ext = String(filePath || '').split('.').pop() || '';
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/jpeg';
}
function readApiTextFileSync(file, maxBytes = MAX_API_KEY_FILE_BYTES) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > maxBytes)
            return '';
        return String(fs.readFileSync(file, 'utf8')).trim();
    }
    catch {
        return '';
    }
}
function readApiJsonFileSync(file, fallback, maxBytes = MAX_API_CONFIG_FILE_BYTES) {
    try {
        const text = readApiTextFileSync(file, maxBytes);
        return text ? JSON.parse(text) : fallback;
    }
    catch {
        return fallback;
    }
}
function isFallbackChainMap(value) {
    return isRecord(value) && Object.values(value).every(item => Array.isArray(item));
}
function buildResponsesInput(messages = []) {
    return messages.filter(item => item && item.content).map(item => ({
        role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
        content: [{ type: 'input_text', text: String(item.content) }],
    }));
}
function extractResponsesText(data = {}) {
    if (typeof data.output_text === 'string' && data.output_text.trim())
        return data.output_text.trim();
    const parts = [];
    for (const item of Array.isArray(data.output) ? data.output : []) {
        if (item?.type !== 'message')
            continue;
        for (const content of Array.isArray(item.content) ? item.content : []) {
            if ((content?.type === 'output_text' || content?.type === 'text') && content.text)
                parts.push(String(content.text));
        }
    }
    const joined = String(parts.join(' ')).replace(/\s+/g, ' ').trim();
    if (!joined)
        throw new Error('Empty model response.');
    return joined;
}
function buildManagedThinkingArgs(config = {}, enabled = false) {
    const model = String(config.model || '');
    if (!enabled) {
        if (isDashScopeConfig(config))
            return { enable_thinking: false };
        if (/deepseek/i.test(model))
            return { enable_thinking: false };
        return {};
    }
    if (isDashScopeConfig(config))
        return { enable_thinking: true };
    if (/glm|mimo|kimi/i.test(model))
        return { thinking: { type: 'enabled' } };
    return {};
}
function rebuildFallbackExtraBody(extraBody = {}, config) {
    if (!extraBody._thinkingManaged)
        return extraBody;
    const next = { ...extraBody };
    const explicit = new Set(Array.isArray(extraBody._explicitThinkingKeys) ? extraBody._explicitThinkingKeys : []);
    if (!explicit.has('enable_thinking'))
        delete next.enable_thinking;
    if (!explicit.has('thinking'))
        delete next.thinking;
    const managed = buildManagedThinkingArgs(config, !!extraBody._thinkingEnabled);
    for (const [key, value] of Object.entries(managed)) {
        if (!explicit.has(key))
            next[key] = value;
    }
    return next;
}
function normalizeMessagesForProvider(messages = [], config = {}) {
    if (!isDashScopeConfig(config))
        return messages;
    const result = [];
    let firstSystem = null;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || !message.content)
            continue;
        if (message.role === 'system') {
            if (!firstSystem) {
                firstSystem = { ...message, content: String(message.content) };
                result.push(firstSystem);
            }
            else {
                firstSystem.content += '\n\n' + String(message.content);
            }
        }
        else {
            result.push(message);
        }
    }
    return result;
}
async function requestChatCompletions(messages, config, extraBody = {}, tools = null) {
    const fallbackSet = extraBody._fallbackSet || 'chat';
    if (!config._originalConfig && !config._fallbackTried) {
        config._originalConfig = { model: config.model, provider: config.provider, baseURL: config.baseURL, apiKey: config.apiKey };
    }
    const controller = new AbortController();
    const externalSignal = extraBody.signal && typeof extraBody.signal === 'object' ? extraBody.signal : null;
    const requestedTimeout = Number(extraBody._timeoutMs);
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.max(1000, Math.min(REQUEST_TIMEOUT_CAP, requestedTimeout))
        : config._fallbackTried ? 10000 : REQUEST_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);
    const filteredExtraBody = {};
    for (const key of ['max_tokens', 'temperature', 'enable_search', 'web_search_options', 'search_options', 'enable_thinking', 'thinking']) {
        if (extraBody[key] === undefined)
            continue;
        if (key === 'temperature') {
            const temperature = Number(extraBody[key]);
            if (Number.isFinite(temperature))
                filteredExtraBody.temperature = Math.max(0, Math.min(2, temperature));
            continue;
        }
        filteredExtraBody[key] = extraBody[key];
    }
    const maxTokens = filteredExtraBody.max_tokens || 1500;
    const providerMessages = normalizeMessagesForProvider(messages, config);
    let cleanupExternalSignal = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        if (externalSignal.aborted) {
            controller.abort();
        }
        else {
            const onAbort = () => controller.abort();
            externalSignal.addEventListener('abort', onAbort, { once: true });
            cleanupExternalSignal = () => {
                try {
                    externalSignal.removeEventListener('abort', onAbort);
                }
                catch { /* non-critical: external signal cleanup can race with abort */ }
            };
        }
    }
    try {
        let response;
        try {
            response = await fetch(config.baseURL + '/chat/completions', {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({
                    model: config.model, temperature: 0.9, max_tokens: maxTokens,
                    ...buildManagedThinkingArgs(config, !!extraBody._thinkingEnabled),
                    ...filteredExtraBody, messages: providerMessages,
                    ...(tools && Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
                }),
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            if (response.status === 429 || response.status === 401 || response.status === 400) {
                const fbStep = (config._fallbackTried || 0) + 1;
                const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet);
                if (fbConfig)
                    return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools);
            }
            const text = await response.text().catch(() => '');
            const isFallback = (response.status === 429 || response.status === 401) && config._fallbackTried;
            throw new Error((isFallback ? '[FALLBACK] ' : '') + `HTTP ${response.status} ${text}`.trim());
        }
        const data = await response.json();
        const usageTokens = data?.usage?.total_tokens || data?.usage?.totalTokens || 0;
        if (usageTokens > 0)
            recordTokenUsage(config.provider || 'unknown', usageTokens, { model: config.model, usage: data?.usage || {} });
        const m = data?.choices?.[0]?.message || {};
        // tool_calls 必须在 content 判空之前检查
        if (tools && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            return { type: 'tool_calls', tool_calls: m.tool_calls, message: m, reasoning: m.reasoning_content || '' };
        }
        let content = m.content && m.content.trim() ? m.content : '';
        const reasoning = m.reasoning_content || '';
        if (content && /<think>[\s\S]*?<\/think>/i.test(content)) {
            content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        }
        if (!content && reasoning) {
            const fbStep = (config._fallbackTried || 0) + 1;
            const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet);
            if (fbConfig)
                return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools);
            return { type: 'text', content: '', reasoning };
        }
        if (!content) {
            if (config._fallbackTried)
                return { type: 'text', content: '', reasoning };
            const fbStep = (config._fallbackTried || 0) + 1;
            const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet);
            if (fbConfig)
                return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools);
            return { type: 'text', content: '', reasoning };
        }
        return { type: 'text', content: String(content).replace(/\s+/g, ' ').trim(), reasoning };
    }
    catch (networkErr) {
        if (externalSignal?.aborted)
            throw networkErr;
        const isHttpError = errorMessage(networkErr).includes('HTTP');
        const fbStep = (config._fallbackTried || 0) + 1;
        if (!isHttpError && fbStep <= 5) {
            const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet);
            if (fbConfig)
                return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools);
        }
        throw networkErr;
    }
    finally {
        if (cleanupExternalSignal)
            cleanupExternalSignal();
    }
}
async function requestOpenAIResponsesWithSearch(messages, config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
        const response = await fetch(config.baseURL + '/responses', {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({
                model: config.model, temperature: 0.9, max_output_tokens: 160,
                input: buildResponsesInput(messages),
                tools: [{ type: 'web_search' }],
            }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${text}`.trim());
        }
        const data = await response.json();
        const usageTokens = data?.usage?.total_tokens || data?.usage?.totalTokens || 0;
        if (usageTokens > 0)
            recordTokenUsage(config.provider || 'unknown', usageTokens, { model: config.model, usage: data?.usage || {} });
        return extractResponsesText(data);
    }
    finally {
        clearTimeout(timer);
    }
}
const DEFAULT_CHAT_FALLBACK = [
    { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
    { model: 'deepseek-v4-flash', provider: 'opencode', keyFile: null },
    { model: 'qwen3.5-omni-flash', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
    { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
];
const DEFAULT_VISION_FALLBACK = [
    { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
    { model: 'mimo-v2-omni', provider: 'mimorium', keyFile: MIMORIUM_KEY_FILE },
    { model: 'qwen3.5-omni-flash', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
    { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
];
const FALLBACK_DEFAULTS = {
    chat: DEFAULT_CHAT_FALLBACK,
    vision: DEFAULT_VISION_FALLBACK,
    lightweight: DEFAULT_CHAT_FALLBACK,
};
function readFallbackSteps() {
    const data = readApiJsonFileSync(FALLBACK_CHAINS_FILE, null);
    if (data && 'chains' in data && isFallbackChainMap(data.chains))
        return data.chains;
    if (isFallbackChainMap(data))
        return data;
    return null;
}
async function buildFallbackConfig(config, step, fallbackSet) {
    const chain = FALLBACK_DEFAULTS[fallbackSet] || DEFAULT_CHAT_FALLBACK;
    const custom = readFallbackSteps();
    const steps = (custom && custom[fallbackSet]) ? custom[fallbackSet] : chain;
    const fb = steps[step - 1];
    if (!fb) {
        if (config._originalConfig && !config._isOriginalRetry) {
            return Object.assign({}, config._originalConfig, { _fallbackTried: step, _isOriginalRetry: true });
        }
        return null;
    }
    const provider = resolveProviderDefinitionSync(fb.provider);
    if (!provider)
        return null;
    let nextKey = config.apiKey;
    if (fb.keyFile) {
        nextKey = readApiTextFileSync(resolveProviderKeyFile(fb.keyFile)).replace(/[\r\n]+/g, '') || nextKey;
    }
    else if (provider.custom && provider.keyFile) {
        nextKey = resolveProviderApiKeySync(fb.provider, nextKey, { allowFallback: false });
    }
    return Object.assign({}, config, {
        _fallbackTried: step,
        provider: fb.provider,
        model: fb.model,
        baseURL: String(provider.baseURL || '').replace(/\/+$/, ''),
        apiKey: nextKey,
    });
}
function getFallbackSteps() {
    return {
        chat: DEFAULT_CHAT_FALLBACK.map(function (item) { return Object.assign({}, item); }),
        vision: DEFAULT_VISION_FALLBACK.map(function (item) { return Object.assign({}, item); }),
        lightweight: DEFAULT_CHAT_FALLBACK.map(function (item) { return Object.assign({}, item); }),
    };
}
function callOneBotWs(action, params, echo, timeoutMs, extractData) {
    return new Promise((resolve) => {
        let ws = null;
        let timer = null;
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            try {
                if (ws)
                    ws.close();
            }
            catch { /* non-critical: OneBot websocket may already be closed */ }
            resolve(value || null);
        };
        try {
            ws = new WebSocket(resolveOneBotWsUrl());
            const socket = ws;
            timer = setTimeout(() => finish(null), timeoutMs);
            socket.on('open', () => {
                try {
                    socket.send(JSON.stringify({ action, params, echo }));
                }
                catch {
                    finish(null);
                }
            });
            socket.on('message', (d) => {
                let message = null;
                try {
                    message = JSON.parse(d.toString());
                }
                catch {
                    return finish(null);
                }
                if (!message)
                    return finish(null);
                if (message.echo !== echo)
                    return;
                try {
                    finish(extractData(message));
                }
                catch {
                    finish(null);
                }
            });
            socket.on('error', () => finish(null));
            socket.on('close', () => finish(null));
        }
        catch {
            finish(null);
        }
    });
}
function callGetImage(fileName) {
    return callOneBotWs('get_image', { file: fileName }, 'gi', 5000, message => (isRecord(message.data) && message.data.file ? message.data : null));
}
function callGetFile(fileId) {
    return callOneBotWs('get_file', { file_id: fileId }, 'gf_file', 8000, message => (isRecord(message.data) && (message.data.file || message.data.url) ? message.data : null));
}
function callGetRecord(fileName) {
    return callOneBotWs('get_record', { file: fileName, out_format: 'wav' }, 'gr', 8000, message => (isRecord(message.data) && message.data.file ? message.data : null));
}
function callGetForwardMsg(forwardId) {
    return callOneBotWs('get_forward_msg', { id: forwardId }, 'gf', 10000, message => isRecord(message.data) ? (message.data.messages || message.data.message || null) : (Array.isArray(message.data) ? message.data : null));
}
function sendForwardMsg(groupId, nodes, timeoutMs = 10000) {
    return callOneBotWs('send_group_forward_msg', { group_id: Number(groupId), messages: nodes }, 'sfm', timeoutMs, message => (isRecord(message.data) && message.data.message_id ? message.data : null));
}
function getGroupMemberInfo(groupId, userId, timeoutMs = 800) {
    return callOneBotWs('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: false }, 'ggmi', timeoutMs, message => (message.retcode === 0 || message.status === 'ok') && isRecord(message.data) ? message.data : null);
}
function getGroupInfo(groupId, timeoutMs = 800) {
    return callOneBotWs('get_group_info', { group_id: Number(groupId), no_cache: false }, 'ggi', timeoutMs, message => (message.retcode === 0 || message.status === 'ok') && isRecord(message.data) ? message.data : null);
}
async function readImageAsBase64(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES)
            return null;
        const buf = fs.readFileSync(filePath);
        return `data:${mimeFromImagePath(filePath)};base64,${buf.toString('base64')}`;
    }
    catch {
        return null;
    }
}
function extractImageFileFromElements(session) {
    try {
        const segs = Array.isArray(session.event?.message) ? session.event.message : [];
        for (const seg of segs) {
            if ((seg.type === 'image' || seg.type === 'img') && seg.data?.file)
                return seg.data.file;
        }
        const m = session.content?.match(/\[CQ:image[^\]]*?file=([^,\]\s]+)/i);
        if (m)
            return m[1];
    }
    catch { /* non-critical: malformed session elements fall back to no image file */ }
    return null;
}
async function downloadImageAsBase64(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let request = null;
        let timer = null;
        let settled = false;
        let currentUrl = null;
        const finishDownload = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(value || null);
        };
        (async () => {
            try {
                currentUrl = validatePublicHttpUrl(url);
                await resolveAndValidateHostname(currentUrl);
            }
            catch {
                return finishDownload(null);
            }
            try {
                if (!currentUrl)
                    return finishDownload(null);
                const mod = currentUrl.protocol === 'https:' ? https : http;
                timer = setTimeout(() => {
                    try {
                        if (request)
                            request.destroy();
                    }
                    catch { /* non-critical: request may already be closed */ }
                    finishDownload(null);
                }, timeoutMs);
                request = mod.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                    const status = Number(res.statusCode || 0);
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume();
                        return finishDownload(null);
                    }
                    if (status !== 200) {
                        res.resume();
                        return finishDownload(null);
                    }
                    const contentTypeHeader = res.headers['content-type'];
                    const contentTypeValue = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
                    const type = String(contentTypeValue || 'image/jpeg').split(';')[0].trim().toLowerCase();
                    if (type && !/^image\/(?:png|jpe?g|gif|webp|bmp)$/.test(type)) {
                        res.resume();
                        return finishDownload(null);
                    }
                    const contentLengthHeader = res.headers['content-length'];
                    const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;
                    const declared = parseInt(String(contentLengthValue || ''), 10);
                    if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) {
                        res.resume();
                        return finishDownload(null);
                    }
                    const chunks = [];
                    let received = 0;
                    res.on('data', (c) => {
                        received += c.length;
                        if (received > MAX_REMOTE_IMAGE_BYTES) {
                            try {
                                if (request)
                                    request.destroy();
                            }
                            catch { /* non-critical: request may already be closed */ }
                            return finishDownload(null);
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        if (!buf.length || buf.length > MAX_REMOTE_IMAGE_BYTES)
                            return finishDownload(null);
                        finishDownload(`data:${type || 'image/jpeg'};base64,${buf.toString('base64')}`);
                    });
                    res.on('error', () => finishDownload(null));
                });
                request.on('error', () => finishDownload(null));
            }
            catch {
                finishDownload(null);
            }
        })();
    });
}
function isVisionModel(provider, modelId) {
    const resolved = resolveProviderDefinitionSync(provider);
    if (resolved) {
        const match = Array.isArray(resolved.models) ? resolved.models.find(function (model) { return model.id === modelId; }) : null;
        if (match)
            return !!match.vision;
    }
    return /qwen|glm|kimi|omni/i.test(modelId);
}
module.exports = {
    requestChatCompletions, normalizeMessagesForProvider, buildResponsesInput, extractResponsesText,
    requestOpenAIResponsesWithSearch,
    buildFallbackConfig, getFallbackSteps,
    callGetImage, callGetFile, callGetRecord, callGetForwardMsg, sendForwardMsg, getGroupMemberInfo, getGroupInfo,
    readImageAsBase64, extractImageFileFromElements, downloadImageAsBase64,
    isVisionModel, recordTokenUsage, flushTokenUsage,
};
