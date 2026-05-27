"use strict";
/**
 * MODULE: Agent 轻量网页读取核心。
 * 职责: 统一公开 URL 校验、DNS/redirect SSRF 防护、超时、大小限制和文本解码。
 * 边界: 不做 Agent 工具包装、不做搜索结果排序、不执行 JavaScript。
 * 状态: 无。
 */
const dns = require('dns');
const net = require('net');
const FETCH_READER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_REDIRECTS = 5;
const DEFAULT_MIN_RELIABLE_TEXT_CHARS = 80;
function getErrorMessage(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        const message = error.message;
        if (message)
            return String(message);
    }
    return String(error);
}
function getErrorName(error) {
    if (error && typeof error === 'object' && 'name' in error)
        return String(error.name || '');
    return '';
}
function parsePositiveInt(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function getFetchLimits(params = {}) {
    return {
        timeoutMs: parsePositiveInt(params.timeoutMs || process.env.DONGXUELIAN_WEB_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 15000),
        maxBytes: parsePositiveInt(params.maxBytes || process.env.DONGXUELIAN_WEB_FETCH_MAX_BYTES, DEFAULT_MAX_BYTES, 64 * 1024, 2 * 1024 * 1024),
        maxChars: parsePositiveInt(params.maxChars || process.env.DONGXUELIAN_WEB_FETCH_MAX_CHARS, DEFAULT_MAX_CHARS, 300, 8000),
        redirects: parsePositiveInt(params.redirects || process.env.DONGXUELIAN_WEB_FETCH_REDIRECTS, DEFAULT_REDIRECTS, 0, 8),
    };
}
function normalizeHostname(hostname = '') {
    return String(hostname || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}
function isPrivateHostname(hostname = '') {
    const host = normalizeHostname(hostname);
    return !host || host === 'localhost' || host.endsWith('.localhost');
}
function isPrivateIp(ip = '') {
    const value = String(ip || '').trim();
    const family = net.isIP(value);
    if (!family)
        return false;
    if (family === 4) {
        const parts = value.split('.').map(part => parseInt(part, 10));
        if (parts.length !== 4 || parts.some(part => !Number.isFinite(part)))
            return true;
        const [a, b] = parts;
        return (a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224);
    }
    const lower = value.toLowerCase();
    if (lower === '::' || lower === '::1')
        return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:'))
        return true;
    const mapped = lower.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped)
        return isPrivateIp(mapped[1]);
    return false;
}
function validatePublicHttpUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    }
    catch {
        throw new Error('URL 格式无效');
    }
    if (!/^https?:$/.test(parsed.protocol))
        throw new Error('只允许读取 http/https URL');
    if (parsed.username || parsed.password)
        throw new Error('拒绝包含用户名或密码的 URL');
    const hostname = normalizeHostname(parsed.hostname);
    if (isPrivateHostname(hostname))
        throw new Error('拒绝访问本机、内网或保留地址');
    if (net.isIP(hostname) && isPrivateIp(hostname))
        throw new Error('拒绝访问本机、内网或保留地址');
    parsed.hash = '';
    return parsed;
}
function lookupHostname(hostname) {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error)
                return reject(error);
            resolve(Array.isArray(addresses) ? addresses : []);
        });
    });
}
async function resolveAndValidateHostname(url) {
    const parsed = typeof url === 'string' ? validatePublicHttpUrl(url) : validatePublicHttpUrl(url.toString());
    const hostname = normalizeHostname(parsed.hostname);
    if (net.isIP(hostname))
        return [{ address: hostname, family: net.isIP(hostname) }];
    const addresses = await lookupHostname(hostname);
    if (!addresses.length)
        throw new Error('DNS 未返回可用地址');
    for (const item of addresses) {
        if (!item || !item.address || isPrivateIp(item.address)) {
            throw new Error('拒绝访问 DNS 指向的本机、内网或保留地址');
        }
    }
    return addresses;
}
function getResponseHeader(response, name) {
    try {
        if (response.headers && typeof response.headers.get === 'function')
            return response.headers.get(name) || '';
    }
    catch { /* non-critical: malformed headers object falls back to empty header */ }
    return '';
}
function isAllowedContentType(contentType = '') {
    const value = String(contentType || '').toLowerCase();
    if (!value)
        return true;
    return /(?:^|;|\s)(text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/ld\+json)(?:;|\s|$)/i.test(value);
}
function normalizeCharset(charset = '') {
    const value = String(charset || '').trim().toLowerCase();
    if (!value)
        return '';
    if (value === 'gbk' || value === 'gb2312')
        return 'gb18030';
    if (value === 'utf8')
        return 'utf-8';
    return value;
}
function getCharsetFromContentType(contentType = '') {
    const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(String(contentType || ''));
    return normalizeCharset(match ? match[1] : '');
}
function getCharsetFromHtml(bytes = Buffer.alloc(0)) {
    const sample = Buffer.from(bytes || []).slice(0, 4096).toString('latin1');
    const match = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(sample)
        || /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i.exec(sample);
    return normalizeCharset(match ? match[1] : '');
}
function decodeBytes(bytes = Buffer.alloc(0), contentType = '') {
    const charset = getCharsetFromContentType(contentType) || getCharsetFromHtml(bytes) || 'utf-8';
    try {
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
    }
    catch { /* non-critical: unsupported declared charset falls back to utf8 */
        return Buffer.from(bytes || []).toString('utf8');
    }
}
async function readResponseBytesLimited(response, maxBytes) {
    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        let truncated = false;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
            const remaining = maxBytes - total;
            if (remaining <= 0) {
                truncated = true;
                try {
                    await reader.cancel();
                }
                catch { /* non-critical: stream may already be closed */ }
                break;
            }
            const kept = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
            chunks.push(kept);
            total += kept.length;
            if (chunk.length > remaining) {
                truncated = true;
                try {
                    await reader.cancel();
                }
                catch { /* non-critical: stream may already be closed */ }
                break;
            }
            if (total >= maxBytes) {
                truncated = true;
                try {
                    await reader.cancel();
                }
                catch { /* non-critical: stream may already be closed */ }
                break;
            }
        }
        return { bytes: Buffer.concat(chunks, total), truncated };
    }
    if (typeof response.arrayBuffer === 'function') {
        const buffer = Buffer.from(await response.arrayBuffer());
        return { bytes: buffer.slice(0, maxBytes), truncated: buffer.length > maxBytes };
    }
    const text = typeof response.text === 'function' ? await response.text() : '';
    const buffer = Buffer.from(String(text || ''), 'utf8');
    return { bytes: buffer.slice(0, maxBytes), truncated: buffer.length > maxBytes };
}
function decodeBasicHtmlEntities(value = '') {
    return String(value || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        const key = String(entity || '').toLowerCase();
        if (key === 'amp')
            return '&';
        if (key === 'lt')
            return '<';
        if (key === 'gt')
            return '>';
        if (key === 'quot')
            return '"';
        if (key === 'apos')
            return "'";
        if (key === 'nbsp')
            return ' ';
        if (key.startsWith('#x')) {
            const code = parseInt(key.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        if (key.startsWith('#')) {
            const code = parseInt(key.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return match;
    });
}
function extractTitle(html = '') {
    const match = /<title\b[^>]*>([\s\S]{0,500})<\/title>/i.exec(String(html || ''));
    return match ? decodeBasicHtmlEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 180) : '';
}
function isLikelyGarbagePageText(text = '') {
    const sample = String(text || '').trim().slice(0, 500);
    if (!sample)
        return false;
    if (/^<img\s|^<svg\s|track_ua\.gif/i.test(sample))
        return true;
    const pathCount = (sample.match(/<path\s/gi) || []).length;
    if (pathCount >= 3)
        return true;
    if (/^(?:window\.|function\s*\(|\{["'][\w-]+["']\s*:)/i.test(sample) && sample.length < DEFAULT_MIN_RELIABLE_TEXT_CHARS)
        return true;
    return false;
}
function classifyCandidateText(text = '', page = {}, options = {}) {
    const value = String(text || '').trim();
    const contentType = String(page && page.contentType || '').toLowerCase();
    const minTextChars = parsePositiveInt(options.minTextChars, DEFAULT_MIN_RELIABLE_TEXT_CHARS, 20, 500);
    const isStructuredJson = /application\/(?:ld\+)?json/i.test(contentType);
    if (!value) {
        return { textQuality: 'empty', reason: '未提取到正文', reliable: false };
    }
    if (isLikelyGarbagePageText(value)) {
        return { textQuality: 'garbage', reason: '正文疑似脚本、SVG、追踪像素或非文章内容', reliable: false };
    }
    if (!isStructuredJson && value.length < minTextChars) {
        return { textQuality: 'short', reason: `正文过短（${value.length} 字，低于 ${minTextChars} 字），可能需要 JavaScript 渲染或换下一个候选页`, reliable: false };
    }
    return { textQuality: 'usable', reason: '已读取可用正文', reliable: true };
}
function defaultExtractCandidateText(body = '', maxChars = DEFAULT_MAX_CHARS) {
    return String(body || '')
        .replace(/<script\b[^>]{0,500}>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]{0,500}>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]{0,500}>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars);
}
async function readCandidatePage(rawUrl, options = {}) {
    const limits = options.limits || getFetchLimits(options);
    const textMaxChars = parsePositiveInt(options.maxChars || limits.maxChars, DEFAULT_MAX_CHARS, 300, 8000);
    const extractText = typeof options.extractText === 'function' ? options.extractText : defaultExtractCandidateText;
    try {
        const page = await fetchWithManualRedirect(rawUrl, limits);
        const extracted = extractText(page.body || '', textMaxChars, page);
        const text = String(extracted || '').trim().slice(0, textMaxChars);
        const quality = classifyCandidateText(text, page, { minTextChars: options.minTextChars });
        return {
            ok: true,
            url: page.originalUrl,
            originalUrl: page.originalUrl,
            finalUrl: page.finalUrl,
            title: page.title,
            status: page.status,
            contentType: page.contentType,
            body: page.body,
            text,
            textQuality: quality.textQuality,
            reason: quality.reason,
            reliable: quality.reliable,
            truncated: !!page.truncated,
        };
    }
    catch (error) {
        const message = getErrorMessage(error);
        return {
            ok: false,
            url: String(rawUrl || ''),
            originalUrl: String(rawUrl || ''),
            finalUrl: '',
            title: '',
            status: 0,
            contentType: '',
            body: '',
            text: '',
            textQuality: 'error',
            reason: message,
            error: message,
            reliable: false,
            truncated: false,
        };
    }
}
async function fetchWithManualRedirect(rawUrl, limits = getFetchLimits()) {
    if (typeof fetch !== 'function')
        throw new Error('当前 Node.js 不支持 fetch，无法读取网页');
    let current = validatePublicHttpUrl(rawUrl);
    for (let redirectCount = 0; redirectCount <= limits.redirects; redirectCount++) {
        await resolveAndValidateHostname(current);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
        try {
            const response = await fetch(current.toString(), {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': FETCH_READER_USER_AGENT,
                    Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
                },
            });
            const status = Number(response.status || 0);
            if (status >= 300 && status < 400) {
                const location = getResponseHeader(response, 'location');
                if (!location)
                    throw new Error(`HTTP ${status} redirect 缺少 Location`);
                if (redirectCount >= limits.redirects)
                    throw new Error('redirect 超过上限');
                current = validatePublicHttpUrl(new URL(location, current).toString());
                continue;
            }
            if (response.url) {
                const responseUrl = validatePublicHttpUrl(response.url);
                await resolveAndValidateHostname(responseUrl);
            }
            if (!response.ok)
                throw new Error(`HTTP ${status || '请求失败'}`);
            const contentType = getResponseHeader(response, 'content-type');
            if (!isAllowedContentType(contentType))
                throw new Error(`非文本页面（${String(contentType).slice(0, 80)}）`);
            const { bytes, truncated } = await readResponseBytesLimited(response, limits.maxBytes);
            const body = decodeBytes(bytes, contentType);
            return {
                originalUrl: validatePublicHttpUrl(rawUrl).toString(),
                finalUrl: current.toString(),
                status,
                contentType,
                body,
                title: extractTitle(body),
                truncated,
            };
        }
        catch (error) {
            if (getErrorName(error) === 'AbortError')
                throw new Error(`读取超时（${limits.timeoutMs}ms）`);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw new Error('redirect 超过上限');
}
async function fetchReadableUrl(rawUrl, params = {}) {
    return fetchWithManualRedirect(rawUrl, getFetchLimits(params));
}
module.exports = {
    FETCH_READER_USER_AGENT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_CHARS,
    DEFAULT_REDIRECTS,
    DEFAULT_MIN_RELIABLE_TEXT_CHARS,
    parsePositiveInt,
    getFetchLimits,
    normalizeHostname,
    isPrivateHostname,
    isPrivateIp,
    validatePublicHttpUrl,
    resolveAndValidateHostname,
    getResponseHeader,
    isAllowedContentType,
    normalizeCharset,
    decodeBytes,
    readResponseBytesLimited,
    extractTitle,
    isLikelyGarbagePageText,
    classifyCandidateText,
    defaultExtractCandidateText,
    fetchWithManualRedirect,
    fetchReadableUrl,
    readCandidatePage,
};
