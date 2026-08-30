"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSharedText = normalizeSharedText;
exports.uniqueStrings = uniqueStrings;
exports.extractBiliUrl = extractBiliUrl;
exports.buildBiliKeys = buildBiliKeys;
exports.extractBvId = extractBvId;
exports.normalizeBiliP1Url = normalizeBiliP1Url;
exports.isAllowedBiliRedirectUrl = isAllowedBiliRedirectUrl;
exports.isPrivateIpAddress = isPrivateIpAddress;
exports.resolveBiliShortLink = resolveBiliShortLink;
exports.resolveBiliInput = resolveBiliInput;
exports.getBiliInputCacheSize = getBiliInputCacheSize;
exports.clearBiliInputCache = clearBiliInputCache;
/**
 * MODULE: Bilibili input and short-link boundary.
 * 职责: 归一化分享文本、生成稳定键，并在 DNS/重定向安全检查后解析 b23 短链。
 * 边界: 不下载媒体、不发送消息、不接触资源门禁。
 */
const dns = require('dns/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const SHORT_LINK_CACHE_TTL_MS = 10 * 60 * 1000;
const SHORT_LINK_MAX_REDIRECTS = 5;
const SHORT_LINK_TIMEOUT_MS = 5000;
const SHORT_LINK_MAX_HEADER_BYTES = 16 * 1024;
const shortLinkResolutionCache = new Map();
// 反复解码常见分享转义，保留无法解码的原始文本。
function normalizeSharedText(input = '') {
    let text = String(input);
    for (let index = 0; index < 3; index++) {
        const previous = text;
        text = text
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#44;/g, ',')
            .replace(/&#91;/g, '[')
            .replace(/&#93;/g, ']')
            .replace(/&#123;/g, '{')
            .replace(/&#125;/g, '}')
            .replace(/&#58;/g, ':')
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
        try {
            const decoded = decodeURIComponent(text);
            if (decoded !== text)
                text = decoded;
        }
        catch { /* malformed shared text remains usable without URI decoding */ }
        if (text === previous)
            break;
    }
    return text;
}
// 去重并删除空字符串，保持首次出现顺序。
function uniqueStrings(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value)))];
}
// 将 BV 号转换为大小写无关的缓存键。
function normalizeBiliIdentifier(identifier = '') {
    const value = String(identifier).trim();
    if (!value)
        return '';
    return `bv:${value.replace(/^bv/i, '').toLowerCase()}`;
}
// 将 B 站地址转换为忽略查询和尾斜杠的缓存键。
function normalizeBiliUrlKey(input = '') {
    const value = normalizeSharedText(input).trim();
    if (!value)
        return '';
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.replace(/\/+$/, '');
        return host ? `url:${host}${pathname.toLowerCase()}` : '';
    }
    catch {
        return `url:${value.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()}`;
    }
}
// 从分享文本中提取 B 站视频 URL 或裸 BV 号。
function extractBiliUrl(input = '') {
    const text = normalizeSharedText(input);
    const urlMatch = text.match(/https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|bilibili\.com|b23\.tv)\/[^\s"'<>\\\]}),，。！？、]+/i);
    if (urlMatch)
        return urlMatch[0];
    const bvMatch = text.match(/\bBV[0-9A-Za-z]{10}\b/i);
    return bvMatch ? `https://www.bilibili.com/video/${bvMatch[0]}` : null;
}
// 为去重和缓存生成 BV 键与 URL 键。
function buildBiliKeys(input = '') {
    const text = normalizeSharedText(input);
    const keys = (text.match(/\bBV[0-9A-Za-z]{10}\b/gi) || []).map(normalizeBiliIdentifier);
    const url = extractBiliUrl(text);
    if (url)
        keys.push(normalizeBiliUrlKey(url));
    return uniqueStrings(keys);
}
// 从任意 B 站文本或地址中提取规范化 BV 缓存键。
function extractBvKey(input = '') {
    const match = normalizeSharedText(input).match(/\bBV[0-9A-Za-z]{10}\b/i);
    return match ? normalizeBiliIdentifier(match[0]) : '';
}
// 从任意 B 站文本或地址中提取保留原始大小写的 BV 号。
function extractBvId(input = '') {
    const match = normalizeSharedText(input).match(/\bBV[0-9A-Za-z]{10}\b/i);
    return match ? match[0] : '';
}
// 将 BV 或普通视频地址统一为只指向第一分 P 的规范地址。
function normalizeBiliP1Url(input = '') {
    const value = normalizeSharedText(input).trim();
    const bvId = extractBvId(value);
    if (bvId)
        return `https://www.bilibili.com/video/${bvId}?p=1`;
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host))
            return '';
        const identifier = parsed.pathname.match(/^\/video\/(av\d+)\/?$/i)?.[1];
        return identifier ? `https://www.bilibili.com/video/${identifier}?p=1` : '';
    }
    catch {
        return '';
    }
}
// 判断 URL 是否为需要轻量解析的 b23.tv 短链。
function isB23ShortUrl(input = '') {
    try {
        return new URL(input).hostname.toLowerCase() === 'b23.tv';
    }
    catch {
        return false;
    }
}
// 限定短链跳转只能留在 B 站公开域名内。
function isAllowedBiliRedirectUrl(input) {
    try {
        const parsed = new URL(input);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return false;
        const host = parsed.hostname.toLowerCase();
        return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
    }
    catch {
        return false;
    }
}
// 判断 DNS 结果是否属于本机、私网、链路本地或保留地址。
function isPrivateIpAddress(address) {
    const normalized = String(address || '').toLowerCase().split('%')[0];
    const version = net.isIP(normalized);
    if (version === 4) {
        const [a, b] = normalized.split('.').map(Number);
        return a === 0 || a === 10 || a === 127
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || a >= 224;
    }
    if (version === 6) {
        if (normalized === '::' || normalized === '::1')
            return true;
        if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized))
            return true;
        const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return !!(mapped && isPrivateIpAddress(mapped[1]));
    }
    return true;
}
// 解析并验证白名单域名，返回已通过公网检查的固定连接地址。
async function resolvePublicBiliHost(input) {
    if (!isAllowedBiliRedirectUrl(input))
        throw new Error('short link redirect escaped Bilibili allowlist');
    const hostname = new URL(input).hostname;
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateIpAddress(item.address)))
        throw new Error('short link redirect resolved to private or invalid address');
    return addresses[0];
}
// 固定到已校验 IP 读取短链响应，保留原域名 Host 和 TLS SNI。
async function requestRedirectLocation(input, timeoutMs) {
    const parsed = new URL(input);
    const destination = await resolvePublicBiliHost(input);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request({
            protocol: parsed.protocol,
            hostname: destination.address,
            family: destination.family,
            port: parsed.port || undefined,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'HEAD',
            servername: parsed.hostname,
            maxHeaderSize: SHORT_LINK_MAX_HEADER_BYTES,
            headers: { host: parsed.host, 'user-agent': 'dongxuelian-local-video-sender/0.2' },
        }, response => {
            const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location || '';
            response.resume();
            resolve({ statusCode: Number(response.statusCode || 0), location: String(location) });
        });
        request.setTimeout(Math.max(100, timeoutMs), () => request.destroy(new Error('short link redirect timeout')));
        request.on('error', reject);
        request.end();
    });
}
// 沿受限重定向链把一个 b23 短链归一化为第一分 P 地址。
async function resolveBiliShortLink(input, requestRedirect = requestRedirectLocation) {
    let current = String(input || '').trim();
    if (!isB23ShortUrl(current))
        return normalizeBiliP1Url(current);
    const deadline = Date.now() + SHORT_LINK_TIMEOUT_MS;
    for (let index = 0; index <= SHORT_LINK_MAX_REDIRECTS; index++) {
        const existing = normalizeBiliP1Url(current);
        if (existing)
            return existing;
        if (index === SHORT_LINK_MAX_REDIRECTS)
            throw new Error('short link redirect limit exceeded');
        if (!isAllowedBiliRedirectUrl(current))
            throw new Error('short link redirect escaped Bilibili allowlist');
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw new Error('short link redirect timeout');
        const response = await requestRedirect(current, remaining);
        if (response.statusCode < 300 || response.statusCode >= 400 || !response.location)
            return '';
        current = new URL(response.location, current).toString();
    }
    return '';
}
// 清理过期短链缓存并返回仍有效的第一分 P 结果。
function getCachedShortLinkResolution(urlKey, now = Date.now()) {
    for (const [key, entry] of shortLinkResolutionCache)
        if (entry.expiresAt <= now)
            shortLinkResolutionCache.delete(key);
    const entry = shortLinkResolutionCache.get(urlKey);
    return entry && entry.expiresAt > now ? entry : null;
}
// 在媒体探测前生成统一的第一分 P 地址，并补齐去重和缓存查询键。
async function resolveBiliInput(options) {
    const { url, source } = options;
    const keys = uniqueStrings(buildBiliKeys(source).concat(buildBiliKeys(url)));
    const directP1Url = normalizeBiliP1Url(url) || normalizeBiliP1Url(source);
    if (directP1Url)
        return { keys: uniqueStrings(keys.concat(buildBiliKeys(directP1Url))), p1Url: directP1Url };
    if (!isB23ShortUrl(url))
        return { keys, p1Url: '' };
    const urlKey = normalizeBiliUrlKey(url);
    const cached = getCachedShortLinkResolution(urlKey);
    if (cached)
        return { keys: uniqueStrings(keys.concat(cached.bvKey).concat(buildBiliKeys(cached.p1Url))), p1Url: cached.p1Url };
    try {
        const resolver = options.resolveShortLink || resolveBiliShortLink;
        const p1Url = normalizeBiliP1Url(await resolver(url));
        const bvKey = extractBvKey(p1Url);
        if (!p1Url || !bvKey)
            throw new Error('short link did not resolve to a Bilibili video BV address');
        shortLinkResolutionCache.set(urlKey, { bvKey, p1Url, expiresAt: Date.now() + SHORT_LINK_CACHE_TTL_MS });
        return { keys: uniqueStrings(keys.concat(bvKey).concat(buildBiliKeys(p1Url))), p1Url };
    }
    catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error || 'unknown error'));
        return { keys, p1Url: '' };
    }
}
// 返回当前短链缓存数量，供运行状态展示。
function getBiliInputCacheSize() {
    getCachedShortLinkResolution('', Date.now());
    return shortLinkResolutionCache.size;
}
// 清空短链解析缓存，供插件 dispose 和测试隔离。
function clearBiliInputCache() {
    shortLinkResolutionCache.clear();
}
