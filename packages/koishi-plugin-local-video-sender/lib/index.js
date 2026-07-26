"use strict";
const { segment } = require('koishi');
const { execFile } = require('child_process');
const dns = require('dns/promises');
const fsSync = require('fs');
const fs = require('fs/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const name = 'local-video-sender';
const DEFAULT_MAX_SIZE = 60000000;
const YTDLP = process.env.BILI_YTDLP || '/usr/local/bin/yt-dlp';
const COOKIES = process.env.BILI_COOKIES_FILE || '/root/bilibili-cookies.txt';
const WORKDIR = process.env.BILI_WORKDIR || '/root/koishi-bili-downloads';
function resolveRuntimeDataDir() {
    const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim();
    if (configured)
        return path.resolve(configured);
    const koishiDir = String(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || '').trim();
    if (koishiDir)
        return path.resolve(koishiDir, 'data');
    return path.resolve(process.cwd(), 'data');
}
const DATA_DIR = resolveRuntimeDataDir();
const VIDEO_BLACKLIST_FILE = process.env.BILI_VIDEO_BLACKLIST_FILE || path.join(DATA_DIR, 'video-blacklist.json');
const MAX_SIZE = parsePositiveInteger(process.env.BILI_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE);
const TEST_VIDEO_FILE = process.env.BILI_TEST_VIDEO_FILE || '/root/test_bili.mp4';
const VIDEO_MIN_MEM_MB = parsePositiveInteger(process.env.BILI_MIN_MEM_MB, 450);
const MIN_720_HEIGHT = 700;
const MAX_720_HEIGHT = 720;
const PREFERRED_MAX_HEIGHT = 720;
const DUPLICATE_WINDOW_MS = 300 * 1000;
const DUPLICATE_HISTORY_LIMIT = 3;
const VIDEO_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_CACHE_HARD_CLEANUP_MS = 10 * 60 * 1000;
const VIDEO_CACHE_SWEEP_MS = 60 * 1000;
const SHORT_LINK_CACHE_TTL_MS = 10 * 60 * 1000;
const SHORT_LINK_MAX_REDIRECTS = 5;
const SHORT_LINK_TIMEOUT_MS = 5000;
const SHORT_LINK_MAX_HEADER_BYTES = 16 * 1024;
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024;
const MAX_VIDEO_BLACKLIST_BYTES = 128 * 1024;
const EXTERNAL_VIDEO_TASK_KIND = 'external_video_download';
const VIDEO_RESOURCE_BUSY_MESSAGE = '服务器内存紧张，视频搬运稍后再试。';
const VIDEO_RESOURCE_UNAVAILABLE_MESSAGE = '资源系统不可用，视频下载暂时关闭。';
const DUPLICATE_PARSE_MESSAGE = '请勿在短时间内重复解析';
const UNKNOWN_SIZE_MESSAGE = '视频文件大小无法预估，请自行去 bilibili 观看。';
const CACHE_FILE_RE = /^bili-cache-[a-z0-9]+-\d+-[a-z0-9]+\.mp4$/;
const CACHE_DIR = path.join(WORKDIR, 'cache');
const recentParseHistory = new Map();
const shortLinkResolutionCache = new Map();
const videoFileCache = new Map();
const videoCacheAliases = new Map();
const inflightDownloads = new Map();
let videoCacheSweepTimer = null;
let cacheDisposed = false;
let videoBlacklistCache = {
    fingerprint: '',
    groups: new Set(),
    users: new Set(),
};
function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function toFileUrl(filePath) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(filePath)))
        return String(filePath);
    return pathToFileURL(filePath).href;
}
function getRuntimeConfig() {
    return {
        ytdlp: YTDLP,
        cookies: COOKIES,
        workdir: WORKDIR,
        maxSize: MAX_SIZE,
        testVideoFile: TEST_VIDEO_FILE,
        videoBlacklistFile: VIDEO_BLACKLIST_FILE,
        videoMinMemMb: VIDEO_MIN_MEM_MB,
    };
}
const FORMAT_CANDIDATES = [
    { format: '30064+30280', label: '720P AVC' },
    { format: '30066+30280', label: '720P HEVC' },
    { format: '100024+30280', label: '720P AV1' },
];
const SINGLE_FILE_CANDIDATES = [
    { format: '64', label: '720P single file' },
    { format: '32', label: '480P single file' },
    { format: '16', label: '360P single file' },
];
function run(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { maxBuffer: MAX_YTDLP_STDIO_BYTES, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            }
            else {
                resolve({ stdout, stderr });
            }
        });
    });
}
// 将资源任务标识压成文件锁可接受的短字符串。
function sanitizeResourceId(value, fallback = 'unknown') {
    const text = String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
    return text || fallback;
}
// 计算 sibling AI 插件 lib 产物路径，避免本插件引入编译期跨包依赖。
function getAiResourceLibPath(...parts) {
    return path.join(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', ...parts);
}
// 运行时加载 S1/S0 模块；缺失时 fail closed，防止无门控下载。
function loadVideoResourceModules(ctx) {
    try {
        const admission = require(getAiResourceLibPath('resource-scheduler', 'admission'));
        const gate = require(getAiResourceLibPath('resource-gate', 'gate'));
        if (typeof admission.admitTask !== 'function' || typeof gate.acquireResourceGate !== 'function') {
            throw new Error('resource modules missing admitTask/acquireResourceGate');
        }
        return { admitTask: admission.admitTask, acquireResourceGate: gate.acquireResourceGate };
    }
    catch (error) {
        ctx.logger('bvidl').warn(`resource gate unavailable: ${getErrorMessage(error)}`);
        return null;
    }
}
// 为视频下载任务生成跨插件可识别的频道键。
function getVideoChannelKey(session) {
    return String(session.guildId || session.channelId || (session.isDirect ? `private:${session.userId || 'unknown'}` : 'unknown'));
}
// 从 Koishi session 的多种形态中提取触发用户 ID。
function getVideoUserId(session) {
    return String(session.userId || session.author?.id || session.event?.user?.id || session.event?.sender?.userId || session.event?.sender?.id || '');
}
// 生成一次外部视频下载任务的 S0/S1 追踪 ID。
function buildVideoTaskId(session, source) {
    const channelKey = sanitizeResourceId(getVideoChannelKey(session));
    const sourceKey = sanitizeResourceId(source || 'bili');
    return `${EXTERNAL_VIDEO_TASK_KIND}-${channelKey}-${sourceKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// 在启动 yt-dlp 前申请 S1 准入和 S0 独占锁。
async function acquireVideoResourceGate(ctx, session, source, deps = {}) {
    if (deps.resourceGate === false)
        return { ok: true, handle: null };
    const modules = loadVideoResourceModules(ctx);
    if (!modules)
        return { ok: false, message: VIDEO_RESOURCE_UNAVAILABLE_MESSAGE };
    const taskId = buildVideoTaskId(session, source);
    const channelKey = getVideoChannelKey(session);
    const userId = getVideoUserId(session);
    const admission = modules.admitTask({
        taskId,
        kind: EXTERNAL_VIDEO_TASK_KIND,
        source: 'local-video-sender',
        channelKey,
        userId,
        exclusive: true,
        priority: 75,
        minMemMb: VIDEO_MIN_MEM_MB,
        deferable: false,
        queueTimeoutMs: 5000,
        runTimeoutMs: 900000,
    });
    if (admission.decision !== 'run_now') {
        ctx.logger('bvidl').warn(`video download rejected by resource scheduler: ${admission.reason || admission.decision}; state=${admission.resourceState || 'unknown'} mem=${admission.memAvailableMb ?? 'unknown'}MB min=${VIDEO_MIN_MEM_MB}MB`);
        return { ok: false, message: VIDEO_RESOURCE_BUSY_MESSAGE };
    }
    try {
        const handle = await modules.acquireResourceGate({
            taskId,
            kind: EXTERNAL_VIDEO_TASK_KIND,
            owner: 'local-video-sender',
            channelKey,
            userId,
            priority: 75,
            timeoutMs: 900000,
            waitTimeoutMs: 5000,
            pollMs: 500,
            memAvailableMb: admission.memAvailableMb,
            step: 'video_prepare',
        });
        return { ok: true, handle };
    }
    catch (error) {
        ctx.logger('bvidl').warn(`video download gate wait failed: ${getErrorMessage(error)}`);
        return { ok: false, message: VIDEO_RESOURCE_BUSY_MESSAGE };
    }
}
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
        catch { /* non-critical: malformed shared text can continue undecoded */
        }
        if (text === previous)
            break;
    }
    return text;
}
function uniqueStrings(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value)))];
}
function normalizeBiliIdentifier(identifier = '') {
    const value = String(identifier).trim();
    if (!value)
        return '';
    return `bv:${value.replace(/^bv/i, '').toLowerCase()}`;
}
function normalizeBiliUrlKey(input = '') {
    const value = normalizeSharedText(input).trim();
    if (!value)
        return '';
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.replace(/\/+$/, '');
        if (!host)
            return '';
        return `url:${host}${pathname.toLowerCase()}`;
    }
    catch {
        return `url:${value.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()}`;
    }
}
function extractBiliUrl(input = '') {
    const text = normalizeSharedText(input);
    const urlMatch = text.match(/https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|bilibili\.com|b23\.tv)\/[^\s"'<>\\\]}),，。！？、]+/i);
    if (urlMatch)
        return urlMatch[0];
    const bvMatch = text.match(/\bBV[0-9A-Za-z]{10}\b/i);
    if (bvMatch)
        return `https://www.bilibili.com/video/${bvMatch[0]}`;
    return null;
}
function buildBiliKeys(input = '') {
    const text = normalizeSharedText(input);
    const keys = [];
    const bvMatches = text.match(/\bBV[0-9A-Za-z]{10}\b/gi) || [];
    for (const bv of bvMatches) {
        keys.push(normalizeBiliIdentifier(bv));
    }
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
        const parts = normalized.split('.').map(Number);
        const [a, b] = parts;
        return a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            a >= 224;
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
    if (!addresses.length || addresses.some(item => isPrivateIpAddress(item.address))) {
        throw new Error('short link redirect resolved to private or invalid address');
    }
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
            headers: {
                host: parsed.host,
                'user-agent': 'dongxuelian-local-video-sender/0.2',
            },
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
// 沿受限重定向链把一个 b23 短链归一化为 BV 缓存键。
async function resolveBiliShortLink(input, requestRedirect = requestRedirectLocation) {
    let current = String(input || '').trim();
    if (!isB23ShortUrl(current))
        return extractBvKey(current);
    const deadline = Date.now() + SHORT_LINK_TIMEOUT_MS;
    for (let index = 0; index <= SHORT_LINK_MAX_REDIRECTS; index++) {
        const existing = extractBvKey(current);
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
// 清理十分钟短链归一化缓存并返回仍有效的 BV 键。
function getCachedShortLinkBv(urlKey, now = Date.now()) {
    for (const [key, entry] of shortLinkResolutionCache) {
        if (entry.expiresAt <= now)
            shortLinkResolutionCache.delete(key);
    }
    const entry = shortLinkResolutionCache.get(urlKey);
    return entry && entry.expiresAt > now ? entry.bvKey : '';
}
// 在媒体探测前把输入短链安全归一化并补齐去重、缓存查询键。
async function resolveInputBiliKeys(ctx, url, source, deps = {}) {
    const keys = uniqueStrings(buildBiliKeys(source).concat(buildBiliKeys(url)));
    if (!isB23ShortUrl(url))
        return keys;
    const urlKey = normalizeBiliUrlKey(url);
    const cached = getCachedShortLinkBv(urlKey);
    if (cached)
        return uniqueStrings(keys.concat(cached));
    try {
        const resolver = deps.resolveShortLink || resolveBiliShortLink;
        const bvKey = await resolver(url);
        if (!bvKey)
            return keys;
        shortLinkResolutionCache.set(urlKey, { bvKey, expiresAt: Date.now() + SHORT_LINK_CACHE_TTL_MS });
        return uniqueStrings(keys.concat(bvKey));
    }
    catch (error) {
        ctx.logger('bvidl').warn(`short link resolution failed: ${getErrorMessage(error)}`);
        return keys;
    }
}
function getParseChannelKey(session) {
    return String(session.guildId || session.channelId || session.userId || 'private');
}
function getGroupBlacklistCandidates(session) {
    const ids = [];
    if (session.guildId)
        ids.push(String(session.guildId));
    if (!session.isDirect && session.channelId)
        ids.push(String(session.channelId));
    return [...new Set(ids.filter(Boolean))];
}
function getUserBlacklistCandidates(session) {
    return uniqueStrings([
        session.userId,
        session.author?.id,
        session.event?.user?.id,
        session.event?.sender?.userId,
        session.event?.sender?.id,
    ]);
}
function getFileFingerprint(filePath) {
    try {
        const stat = fsSync.statSync(filePath);
        return `${stat.mtimeMs}:${stat.size}`;
    }
    catch {
        return 'missing';
    }
}
function parseStringList(value) {
    return Array.isArray(value) ? uniqueStrings(value) : [];
}
function loadVideoBlacklist(force = false) {
    const fingerprint = getFileFingerprint(VIDEO_BLACKLIST_FILE);
    if (!force && videoBlacklistCache.fingerprint === fingerprint)
        return videoBlacklistCache;
    let groups = [];
    let users = [];
    if (fingerprint !== 'missing') {
        try {
            const stat = fsSync.statSync(VIDEO_BLACKLIST_FILE);
            if (!stat.isFile() || stat.size > MAX_VIDEO_BLACKLIST_BYTES)
                throw new Error('video blacklist too large');
            const raw = JSON.parse(fsSync.readFileSync(VIDEO_BLACKLIST_FILE, 'utf8'));
            groups = Array.isArray(raw) ? parseStringList(raw) : raw && typeof raw === 'object' && Array.isArray(raw.groups) ? parseStringList(raw.groups) : [];
            users = raw && typeof raw === 'object' && Array.isArray(raw.users) ? parseStringList(raw.users) : [];
        }
        catch {
            groups = [];
            users = [];
        }
    }
    videoBlacklistCache = {
        fingerprint,
        groups: new Set(uniqueStrings(groups)),
        users: new Set(uniqueStrings(users)),
    };
    return videoBlacklistCache;
}
function isBlacklistedGroup(session) {
    const blacklist = loadVideoBlacklist();
    return getGroupBlacklistCandidates(session).some(groupId => blacklist.groups.has(groupId)) ||
        getUserBlacklistCandidates(session).some(userId => blacklist.users.has(userId));
}
function pruneRecentParseHistory(session, now = Date.now()) {
    const channelKey = getParseChannelKey(session);
    const history = recentParseHistory.get(channelKey) || [];
    const nextHistory = history
        .filter(entry => now - entry.timestamp < DUPLICATE_WINDOW_MS)
        .slice(-DUPLICATE_HISTORY_LIMIT);
    if (nextHistory.length) {
        recentParseHistory.set(channelKey, nextHistory);
    }
    else {
        recentParseHistory.delete(channelKey);
    }
    return nextHistory;
}
function isRecentDuplicateParse(session, keys, now = Date.now()) {
    if (!keys.length)
        return false;
    const history = pruneRecentParseHistory(session, now);
    return history.some(entry => entry.keys.some(key => keys.includes(key)));
}
function rememberRecentParse(session, keys, now = Date.now()) {
    if (!keys.length)
        return null;
    const history = pruneRecentParseHistory(session, now);
    const entry = {
        timestamp: now,
        keys: uniqueStrings(keys),
    };
    history.push(entry);
    recentParseHistory.set(getParseChannelKey(session), history.slice(-DUPLICATE_HISTORY_LIMIT));
    return entry;
}
// Removes a failed parse attempt so the same link can be retried immediately.
function forgetRecentParse(session, entry) {
    if (!entry)
        return;
    const channelKey = getParseChannelKey(session);
    const history = recentParseHistory.get(channelKey) || [];
    const nextHistory = history.filter(item => item !== entry);
    if (nextHistory.length) {
        recentParseHistory.set(channelKey, nextHistory);
    }
    else {
        recentParseHistory.delete(channelKey);
    }
}
function mergeRecentParseKeys(entry, keys) {
    if (!entry || !keys.length)
        return;
    entry.keys = uniqueStrings(entry.keys.concat(keys));
}
// 生成十进制 MB 文案，和 60,000,000 字节业务阈值保持同一单位。
function formatDecimalMb(bytes) {
    return `${(Math.max(0, safeNumber(bytes)) / 1000000).toFixed(1)} MB`;
}
// 生成统一的超限提示。
function buildOversizeMessage(bytes) {
    return `视频文件过大（${formatDecimalMb(bytes)}），请自行去 bilibili 观看。`;
}
// 检查缓存文件路径、类型和真实位置均留在专用缓存目录内。
function isSafeVideoCacheFile(filePath) {
    try {
        const cacheRoot = path.resolve(CACHE_DIR);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(`${cacheRoot}${path.sep}`) || !CACHE_FILE_RE.test(path.basename(resolved)))
            return false;
        const stat = fsSync.lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink())
            return false;
        const realRoot = fsSync.realpathSync(cacheRoot);
        const realFile = fsSync.realpathSync(resolved);
        return realFile.startsWith(`${realRoot}${path.sep}`);
    }
    catch {
        return false;
    }
}
// 移除缓存项的全部查询键，但保留对象供活动发送 finally 收口。
function detachVideoCacheEntry(entry) {
    entry.expired = true;
    for (const alias of entry.aliases) {
        if (videoCacheAliases.get(alias) === entry.primaryKey)
            videoCacheAliases.delete(alias);
    }
}
// 安全删除一个空闲缓存文件和对应内存状态。
async function deleteVideoCacheEntry(ctx, entry) {
    detachVideoCacheEntry(entry);
    if (entry.activeSends > 0)
        return false;
    if (entry.expiryTimer)
        clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    videoFileCache.delete(entry.primaryKey);
    try {
        if (isSafeVideoCacheFile(entry.filePath))
            await fs.rm(entry.filePath, { force: true });
        return true;
    }
    catch (error) {
        videoFileCache.set(entry.primaryKey, entry);
        ctx?.logger('bvidl').warn(`video cache delete failed: ${getErrorMessage(error)}`);
        return false;
    }
}
// 在固定五分钟边界停止新命中，并在无活动发送时删除文件。
function expireVideoCacheEntry(ctx, entry) {
    detachVideoCacheEntry(entry);
    if (entry.activeSends === 0)
        void deleteVideoCacheEntry(ctx, entry);
}
// 把首次成功上传的 MP4 登记为五分钟全局 BV 缓存。
function registerVideoFileCache(ctx, filePath, sizeBytes, infoMessage, keys, now = Date.now()) {
    if (cacheDisposed || !isSafeVideoCacheFile(filePath) || sizeBytes <= 0 || sizeBytes > MAX_SIZE)
        return null;
    const aliases = uniqueStrings(keys);
    const primaryKey = aliases.find(key => key.startsWith('bv:')) || '';
    if (!primaryKey)
        return null;
    const previous = videoFileCache.get(primaryKey);
    if (previous && previous.filePath !== filePath)
        void deleteVideoCacheEntry(ctx, previous);
    const entry = {
        primaryKey,
        bvKey: primaryKey,
        aliases: uniqueStrings(aliases.concat(primaryKey)),
        filePath,
        sizeBytes,
        infoMessage,
        createdAt: now,
        expiresAt: now + VIDEO_CACHE_TTL_MS,
        hardCleanupAt: now + VIDEO_CACHE_HARD_CLEANUP_MS,
        activeSends: 0,
        expired: false,
        expiryTimer: null,
    };
    videoFileCache.set(primaryKey, entry);
    for (const alias of entry.aliases)
        videoCacheAliases.set(alias, primaryKey);
    entry.expiryTimer = setTimeout(() => expireVideoCacheEntry(ctx, entry), VIDEO_CACHE_TTL_MS);
    entry.expiryTimer.unref?.();
    return entry;
}
// 查找并校验一个仍在五分钟复用窗口内的缓存项。
function findVideoFileCache(ctx, keys, now = Date.now()) {
    for (const key of keys) {
        const primaryKey = videoCacheAliases.get(key) || (videoFileCache.has(key) ? key : '');
        if (!primaryKey)
            continue;
        const entry = videoFileCache.get(primaryKey);
        if (!entry) {
            videoCacheAliases.delete(key);
            continue;
        }
        if (entry.expired || entry.expiresAt <= now) {
            expireVideoCacheEntry(ctx, entry);
            continue;
        }
        if (!isSafeVideoCacheFile(entry.filePath)) {
            void deleteVideoCacheEntry(ctx, entry);
            continue;
        }
        const stat = fsSync.statSync(entry.filePath);
        if (stat.size !== entry.sizeBytes || stat.size > MAX_SIZE) {
            void deleteVideoCacheEntry(ctx, entry);
            continue;
        }
        return entry;
    }
    return null;
}
// 使用现有封面信息和磁盘 MP4 向当前会话发送缓存视频。
async function sendCachedVideo(ctx, session, entry) {
    entry.activeSends += 1;
    try {
        const previewSent = await safeSend(ctx, session, entry.infoMessage, 'cached preview');
        if (!previewSent)
            return 'Failed to send video preview. Please try again later.';
        const videoSent = await safeSend(ctx, session, segment.video(toFileUrl(entry.filePath)), 'cached video');
        if (!videoSent)
            return 'Failed to send video. Please try again later.';
        return undefined;
    }
    finally {
        entry.activeSends = Math.max(0, entry.activeSends - 1);
        if (entry.expired && entry.activeSends === 0)
            await deleteVideoCacheEntry(ctx, entry);
    }
}
// 扫描内存缓存与专用目录，回收五分钟失效项和十分钟遗留文件。
async function cleanupVideoCache(ctx, now = Date.now()) {
    let entriesRemoved = 0;
    let filesRemoved = 0;
    let staleActive = 0;
    const activePaths = new Set();
    for (const entry of [...videoFileCache.values()]) {
        if (entry.activeSends > 0)
            activePaths.add(path.resolve(entry.filePath));
        if (entry.expiresAt <= now)
            detachVideoCacheEntry(entry);
        if (entry.hardCleanupAt <= now && entry.activeSends > 0) {
            staleActive += 1;
            ctx?.logger('bvidl').warn(`stale_active_cache: key=${entry.primaryKey} active=${entry.activeSends}`);
        }
        if (entry.expired && entry.activeSends === 0) {
            if (await deleteVideoCacheEntry(ctx, entry)) {
                entriesRemoved += 1;
                filesRemoved += 1;
            }
        }
    }
    try {
        const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true });
        for (const item of entries) {
            if (!item.isFile() || !CACHE_FILE_RE.test(item.name))
                continue;
            const filePath = path.join(CACHE_DIR, item.name);
            if (activePaths.has(path.resolve(filePath)))
                continue;
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs < VIDEO_CACHE_HARD_CLEANUP_MS)
                continue;
            await fs.rm(filePath, { force: true });
            filesRemoved += 1;
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            ctx?.logger('bvidl').warn(`video cache sweep failed: ${getErrorMessage(error)}`);
    }
    return { entriesRemoved, filesRemoved, staleActive };
}
// 启动一分钟缓存清理，并注册插件关闭时的收口动作。
function startVideoCacheMaintenance(ctx) {
    cacheDisposed = false;
    if (!videoCacheSweepTimer) {
        videoCacheSweepTimer = setInterval(() => { void cleanupVideoCache(ctx); }, VIDEO_CACHE_SWEEP_MS);
        videoCacheSweepTimer.unref?.();
    }
    void cleanupVideoCache(ctx);
    ctx.on?.('dispose', async () => {
        cacheDisposed = true;
        if (videoCacheSweepTimer)
            clearInterval(videoCacheSweepTimer);
        videoCacheSweepTimer = null;
        for (const entry of [...videoFileCache.values()]) {
            detachVideoCacheEntry(entry);
            if (entry.activeSends === 0)
                await deleteVideoCacheEntry(ctx, entry);
        }
        shortLinkResolutionCache.clear();
        inflightDownloads.clear();
    });
}
// 返回可用于测试和运行时验收的无敏感缓存摘要。
function getVideoCacheStatus() {
    return {
        entries: videoFileCache.size,
        aliases: videoCacheAliases.size,
        inflight: inflightDownloads.size,
        shortLinks: shortLinkResolutionCache.size,
        items: [...videoFileCache.values()].map(entry => ({
            bvKey: entry.bvKey,
            sizeBytes: entry.sizeBytes,
            expiresAt: entry.expiresAt,
            activeSends: entry.activeSends,
            expired: entry.expired,
        })),
    };
}
function getCanonicalBiliUrl(info = {}) {
    const source = info.webpage_url || info.original_url || '';
    const bvMatch = source.match(/\bBV[0-9A-Za-z]{10}\b/i);
    if (bvMatch) {
        return `https://www.bilibili.com/video/${bvMatch[0]}/`;
    }
    return source ? source.split('?')[0] : '';
}
function getShortestBiliUrl(info = {}) {
    const values = [
        info.webpage_url,
        info.original_url,
        info.url,
        info.id,
        info.display_id,
    ].filter(Boolean);
    for (const value of values) {
        const match = String(value).match(/\bBV[0-9A-Za-z]{10}\b/i);
        if (match)
            return `https://b23.tv/${match[0]}`;
    }
    return getCanonicalBiliUrl(info);
}
function safeNumber(value) {
    return Number.isFinite(value) ? Number(value) : 0;
}
function estimateFormatSize(format) {
    return safeNumber(format.filesize) || safeNumber(format.filesize_approx);
}
function isAudioOnlyFormat(format) {
    return !!(format && format.vcodec === 'none' && format.acodec && format.acodec !== 'none');
}
function isVideoFormat(format) {
    return !!(format && format.vcodec && format.vcodec !== 'none');
}
function pickBestAudio(formats) {
    return formats
        .filter(isAudioOnlyFormat)
        .sort((left, right) => {
        const abrDiff = safeNumber(right.abr) - safeNumber(left.abr);
        if (abrDiff)
            return abrDiff;
        return estimateFormatSize(right) - estimateFormatSize(left);
    })[0];
}
function sortVideoCandidates(left, right, targetHeight = PREFERRED_MAX_HEIGHT) {
    const leftHeight = safeNumber(left.height);
    const rightHeight = safeNumber(right.height);
    const leftDistance = Math.abs(leftHeight - targetHeight);
    const rightDistance = Math.abs(rightHeight - targetHeight);
    if (leftDistance !== rightDistance)
        return leftDistance - rightDistance;
    const leftPreferred = leftHeight <= targetHeight ? 1 : 0;
    const rightPreferred = rightHeight <= targetHeight ? 1 : 0;
    if (leftPreferred !== rightPreferred)
        return rightPreferred - leftPreferred;
    const heightDiff = rightHeight - leftHeight;
    if (heightDiff)
        return heightDiff;
    const fpsDiff = safeNumber(right.fps) - safeNumber(left.fps);
    if (fpsDiff)
        return fpsDiff;
    return estimateFormatSize(right) - estimateFormatSize(left);
}
function buildSplitPick(video, audio, label) {
    return {
        format: `${video.format_id}+${audio.format_id}`,
        label,
        totalSize: estimateFormatSize(video) + estimateFormatSize(audio),
        height: safeNumber(video.height),
    };
}
function pickFormat(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    for (const candidate of FORMAT_CANDIDATES) {
        const [videoId, audioId] = candidate.format.split('+');
        const video = formats.find(item => String(item.format_id) === videoId);
        const audio = formats.find(item => String(item.format_id) === audioId);
        if (!video || !audio)
            continue;
        const totalSize = estimateFormatSize(video) + estimateFormatSize(audio);
        return {
            format: candidate.format,
            label: candidate.label,
            totalSize,
            height: safeNumber(video.height),
        };
    }
    const audio = pickBestAudio(formats);
    const exact720Candidates = formats
        .filter(item => {
        const height = safeNumber(item.height);
        return isVideoFormat(item) && height >= MIN_720_HEIGHT && height <= MAX_720_HEIGHT;
    })
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (exact720Candidates.length && audio) {
        return buildSplitPick(exact720Candidates[0], audio, `${safeNumber(exact720Candidates[0].height)}P split stream`);
    }
    const preferredVideoCandidates = formats
        .filter(item => {
        const height = safeNumber(item.height);
        return isVideoFormat(item) && height > 0 && height <= PREFERRED_MAX_HEIGHT;
    })
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (preferredVideoCandidates.length && audio) {
        return buildSplitPick(preferredVideoCandidates[0], audio, `${safeNumber(preferredVideoCandidates[0].height)}P split stream`);
    }
    for (const candidate of SINGLE_FILE_CANDIDATES) {
        const merged = formats.find(item => String(item.format_id) === candidate.format);
        if (!merged)
            continue;
        return {
            format: candidate.format,
            label: candidate.label,
            totalSize: estimateFormatSize(merged),
            height: safeNumber(merged.height),
        };
    }
    const anyVideoCandidates = formats
        .filter(item => isVideoFormat(item) && safeNumber(item.height) > 0)
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (anyVideoCandidates.length && audio) {
        return buildSplitPick(anyVideoCandidates[0], audio, `${safeNumber(anyVideoCandidates[0].height)}P fallback split stream`);
    }
    const anyMergedCandidates = formats
        .filter(item => isVideoFormat(item) && item.acodec && item.acodec !== 'none')
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (anyMergedCandidates.length) {
        const merged = anyMergedCandidates[0];
        return {
            format: String(merged.format_id),
            label: `${safeNumber(merged.height)}P fallback single file`,
            totalSize: estimateFormatSize(merged),
            height: safeNumber(merged.height),
        };
    }
    return null;
}
function formatBytes(bytes) {
    if (!bytes)
        return 'unknown';
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
function formatDuration(seconds) {
    seconds = Math.floor(safeNumber(seconds));
    if (!seconds)
        return 'unknown';
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}
function formatVideoInfo(info, picked) {
    const shortestUrl = getShortestBiliUrl(info);
    return [
        info.title || 'Unknown title',
        segment.image(info.thumbnail),
        shortestUrl,
    ].filter(Boolean).join('\n');
}
function buildInfoMessage(info, picked) {
    return formatVideoInfo(info, picked);
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function getCommandErrorMessage(error) {
    if (error && typeof error === 'object') {
        const commandError = error;
        return String(commandError.stderr || commandError.message || error);
    }
    return String(error);
}
async function safeSend(ctx, session, message, label = 'message') {
    try {
        await session.send(message);
        return true;
    }
    catch (error) {
        ctx.logger('bvidl').warn(`${label} send failed: ${getErrorMessage(error)}`);
        return false;
    }
}
async function probeVideo(url) {
    const { stdout } = await run(YTDLP, [
        '--cookies', COOKIES,
        '--dump-single-json',
        '--no-warnings',
        url,
    ], { timeout: 2 * 60 * 1000 });
    const info = JSON.parse(stdout);
    const picked = pickFormat(info);
    if (!picked) {
        return { error: 'No available video format found.' };
    }
    return { info, picked };
}
// 显式发送拒绝提示，避免 action 返回值造成重复消息。
async function sendRejectedVideo(ctx, session, infoMessage, message, includePreview = true) {
    if (includePreview)
        await safeSend(ctx, session, infoMessage, 'preview');
    await safeSend(ctx, session, message, 'video refusal');
}
// 给缓存命中请求单独申请资源锁并发送磁盘视频。
async function sendCachedVideoWithGate(ctx, session, entry, source, deps) {
    const gateResult = await acquireVideoResourceGate(ctx, session, source, deps);
    if (!gateResult.ok)
        return gateResult.message || VIDEO_RESOURCE_BUSY_MESSAGE;
    const gateHandle = gateResult.handle || null;
    try {
        gateHandle?.updateStep('video_cached_send');
        return await sendCachedVideo(ctx, session, entry);
    }
    finally {
        try {
            gateHandle?.release('external-video-cache-finally');
        }
        catch { /* resource gate records stale releases independently */
        }
    }
}
// 为首次请求执行探测、大小门禁、下载、首发和缓存登记。
async function processInitialVideoRequest(ctx, session, url, source, keys, recentEntry, deps) {
    const gateResult = await acquireVideoResourceGate(ctx, session, source, deps);
    if (!gateResult.ok)
        return { kind: 'failed', message: gateResult.message || VIDEO_RESOURCE_BUSY_MESSAGE };
    const gateHandle = gateResult.handle || null;
    const fsApi = deps.fs || fs;
    const runCommand = deps.run || run;
    const probe = deps.probeVideo || probeVideo;
    let outputFile = '';
    try {
        try {
            await fsApi.mkdir(WORKDIR, { recursive: true });
            await fsApi.mkdir(CACHE_DIR, { recursive: true });
        }
        catch (error) {
            ctx.logger('bvidl').warn(getErrorMessage(error));
            return { kind: 'failed', message: 'Failed to prepare download directory. Please check logs later.' };
        }
        let info;
        let picked;
        gateHandle?.updateStep('video_probe');
        try {
            const result = await probe(url);
            if (result.error)
                return { kind: 'failed', message: result.error };
            if (!result.info || !result.picked)
                return { kind: 'failed', message: 'No available video format found.' };
            info = result.info;
            picked = result.picked;
        }
        catch (error) {
            ctx.logger('bvidl').warn(getCommandErrorMessage(error));
            return { kind: 'failed', message: 'Failed to probe video. Please try again later.' };
        }
        const canonicalKeys = uniqueStrings(keys
            .concat(buildBiliKeys(getCanonicalBiliUrl(info)))
            .concat(buildBiliKeys(getShortestBiliUrl(info))));
        mergeRecentParseKeys(recentEntry, canonicalKeys);
        const infoMessage = buildInfoMessage(info, picked);
        gateHandle?.updateStep('video_preview');
        const previewSent = await safeSend(ctx, session, infoMessage, 'preview');
        if (!previewSent)
            return { kind: 'failed', message: 'Failed to send video preview. Please try again later.' };
        if (picked.totalSize <= 0) {
            await sendRejectedVideo(ctx, session, infoMessage, UNKNOWN_SIZE_MESSAGE, false);
            ctx.logger('bvidl').warn(`rejected_before_download: reason=size_unknown keys=${canonicalKeys.join(',')}`);
            return { kind: 'rejected', infoMessage, message: UNKNOWN_SIZE_MESSAGE };
        }
        if (picked.totalSize > MAX_SIZE) {
            const message = buildOversizeMessage(picked.totalSize);
            await sendRejectedVideo(ctx, session, infoMessage, message, false);
            ctx.logger('bvidl').warn(`rejected_before_download: reason=oversize estimated=${picked.totalSize} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')}`);
            return { kind: 'rejected', infoMessage, message };
        }
        const bvKey = canonicalKeys.find(key => key.startsWith('bv:')) || '';
        const cacheSlug = (bvKey.replace(/^bv:/, '') || 'unknown').replace(/[^a-z0-9]/g, '').slice(0, 32) || 'unknown';
        const id = `bili-cache-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const outputTemplate = path.join(CACHE_DIR, `${id}.%(ext)s`);
        outputFile = path.join(CACHE_DIR, `${id}.mp4`);
        gateHandle?.updateStep('video_download');
        try {
            await runCommand(YTDLP, [
                '--cookies', COOKIES,
                '-f', picked.format,
                '--merge-output-format', 'mp4',
                '-o', outputTemplate,
                url,
            ], { timeout: 10 * 60 * 1000 });
            const stat = await fsApi.stat(outputFile);
            if (stat.size > MAX_SIZE) {
                const message = buildOversizeMessage(stat.size);
                await fsApi.rm(outputFile, { force: true });
                outputFile = '';
                await sendRejectedVideo(ctx, session, infoMessage, message, false);
                ctx.logger('bvidl').warn(`rejected_after_download: estimated=${picked.totalSize} actual=${stat.size} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')}`);
                return { kind: 'rejected', infoMessage, message };
            }
            gateHandle?.updateStep('video_send');
            const videoSent = await safeSend(ctx, session, segment.video(toFileUrl(outputFile)), 'video');
            if (!videoSent) {
                await fsApi.rm(outputFile, { force: true });
                outputFile = '';
                return { kind: 'failed', message: 'Failed to send video. Please try again later.' };
            }
            const cacheEntry = registerVideoFileCache(ctx, outputFile, stat.size, infoMessage, canonicalKeys);
            if (!cacheEntry) {
                await fsApi.rm(outputFile, { force: true });
                outputFile = '';
                return { kind: 'sent' };
            }
            outputFile = '';
            return { kind: 'cached', entry: cacheEntry };
        }
        catch (error) {
            if (outputFile)
                await fsApi.rm(outputFile, { force: true }).catch(() => {
                });
            outputFile = '';
            ctx.logger('bvidl').warn(getCommandErrorMessage(error));
            return { kind: 'failed', message: 'Failed to download or send video. Please check logs later.' };
        }
    }
    finally {
        if (outputFile)
            await fsApi.rm(outputFile, { force: true }).catch(() => {
            });
        try {
            gateHandle?.release('external-video-finally');
        }
        catch { /* resource gate records stale releases independently */
        }
    }
}
// 把共享首次处理结果投递给等待中的其他群请求。
async function deliverSharedVideoResult(ctx, session, result, source, deps) {
    if (result.kind === 'cached')
        return sendCachedVideoWithGate(ctx, session, result.entry, source, deps);
    if (result.kind === 'rejected') {
        await sendRejectedVideo(ctx, session, result.infoMessage, result.message);
        return undefined;
    }
    if (result.kind === 'failed')
        return result.message;
    return undefined;
}
// 找到任一 BV/alias 正在执行的首次处理任务。
function findInflightDownload(keys) {
    for (const key of keys) {
        const inflight = inflightDownloads.get(key);
        if (inflight)
            return inflight;
    }
    return null;
}
// 用一组等价键登记同一个首次处理 Promise。
function registerInflightDownload(keys, promise) {
    const registered = uniqueStrings(keys);
    for (const key of registered)
        inflightDownloads.set(key, promise);
    return registered;
}
// 清除仍指向指定 Promise 的 inflight 键，避免误删后来的任务。
function unregisterInflightDownload(keys, promise) {
    for (const key of keys) {
        if (inflightDownloads.get(key) === promise)
            inflightDownloads.delete(key);
    }
}
// 编排同群去重、短链归一化、缓存命中、并发合并和首次处理。
async function downloadAndSend(ctx, session, url, source = url, deps = {}) {
    if (isBlacklistedGroup(session))
        return;
    const now = Date.now();
    const immediateKeys = uniqueStrings(buildBiliKeys(source).concat(buildBiliKeys(url)));
    if (isRecentDuplicateParse(session, immediateKeys, now)) {
        await safeSend(ctx, session, DUPLICATE_PARSE_MESSAGE, 'duplicate parse notice');
        return undefined;
    }
    const keys = await resolveInputBiliKeys(ctx, url, source, deps);
    if (isRecentDuplicateParse(session, keys, now)) {
        await safeSend(ctx, session, DUPLICATE_PARSE_MESSAGE, 'duplicate parse notice');
        return undefined;
    }
    const recentEntry = rememberRecentParse(session, keys, now);
    const cached = findVideoFileCache(ctx, keys, now);
    if (cached) {
        const result = await sendCachedVideoWithGate(ctx, session, cached, source, deps);
        if (result)
            forgetRecentParse(session, recentEntry);
        return result;
    }
    const inflight = findInflightDownload(keys);
    if (inflight) {
        const result = await inflight;
        const delivered = await deliverSharedVideoResult(ctx, session, result, source, deps);
        if (result.kind === 'failed' || delivered)
            forgetRecentParse(session, recentEntry);
        return delivered;
    }
    let work;
    work = processInitialVideoRequest(ctx, session, url, source, keys, recentEntry, deps);
    const registeredKeys = registerInflightDownload(keys, work);
    try {
        const result = await work;
        if (result.kind === 'failed') {
            forgetRecentParse(session, recentEntry);
            return result.message;
        }
        return undefined;
    }
    finally {
        unregisterInflightDownload(registeredKeys, work);
    }
}
function apply(ctx) {
    startVideoCacheMaintenance(ctx);
    ctx.command('sendtestvideo', 'send local test video').action(() => {
        return segment.video(toFileUrl(TEST_VIDEO_FILE));
    });
    ctx.command('bvidl <text:text>', 'download and send Bilibili video').action(async ({ session }, text) => {
        if (isBlacklistedGroup(session))
            return;
        const url = extractBiliUrl(text);
        if (!url)
            return 'Usage: bvidl Bilibili_URL_or_BV_ID';
        return downloadAndSend(ctx, session, url, text || url);
    });
    ctx.middleware(async (session, next) => {
        if (isBlacklistedGroup(session))
            return next();
        const content = session.content || '';
        if (/^\s*bvidl\b/i.test(content))
            return next();
        const url = extractBiliUrl(content);
        if (!url)
            return next();
        return downloadAndSend(ctx, session, url, content);
    });
}
const clearRecentParseHistory = () => recentParseHistory.clear();
// 清理测试可见的内存状态和无活动缓存文件。
async function clearVideoRuntimeState() {
    recentParseHistory.clear();
    shortLinkResolutionCache.clear();
    inflightDownloads.clear();
    for (const entry of [...videoFileCache.values()]) {
        detachVideoCacheEntry(entry);
        entry.activeSends = 0;
        await deleteVideoCacheEntry(null, entry);
    }
    videoCacheAliases.clear();
}
module.exports = {
    name,
    apply,
    extractBiliUrl,
    buildBiliKeys,
    pickFormat,
    getShortestBiliUrl,
    downloadAndSend,
    formatDecimalMb,
    buildOversizeMessage,
    getRuntimeConfig,
    toFileUrl,
    safeSend,
    isBlacklistedGroup,
    loadVideoBlacklist,
    isRecentDuplicateParse,
    rememberRecentParse,
    clearRecentParseHistory,
    resolveBiliShortLink,
    isAllowedBiliRedirectUrl,
    isPrivateIpAddress,
    cleanupVideoCache,
    getVideoCacheStatus,
    clearVideoRuntimeState,
};
