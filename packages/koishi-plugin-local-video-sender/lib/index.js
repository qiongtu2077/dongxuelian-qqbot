"use strict";
const { segment } = require('koishi');
const { execFile } = require('child_process');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const biliInput = require('./bili-input');
const cookieFile = require('./cookie-file');
const videoTaskQueueModule = require('./video-task-queue');
const videoTraceModule = require('./video-trace');
const { buildBiliKeys, extractBvId, extractBiliUrl, isBilibiliCardInput, isAllowedBiliRedirectUrl, isPrivateIpAddress, normalizeBiliP1Url, normalizeSharedText, resolveBiliShortLink, uniqueStrings, } = biliInput;
const { clearBiliCookieHealthCache, getBiliCookieHealth, resolveBiliCookiePath, } = cookieFile;
const name = 'local-video-sender';
const DEFAULT_MAX_SIZE = 60000000;
const YTDLP = process.env.BILI_YTDLP || '/usr/local/bin/yt-dlp';
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
const COOKIES = resolveBiliCookiePath(DATA_DIR, process.env.BILI_COOKIES_FILE);
const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json');
const VIDEO_BLACKLIST_FILE = process.env.BILI_VIDEO_BLACKLIST_FILE || path.join(DATA_DIR, 'video-blacklist.json');
const MAX_SIZE = parsePositiveInteger(process.env.BILI_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE);
const TEST_VIDEO_FILE = process.env.BILI_TEST_VIDEO_FILE || '/root/test_bili.mp4';
const VIDEO_MIN_MEM_MB = Math.max(300, parsePositiveInteger(process.env.BILI_MIN_MEM_MB, 300));
const MIN_720_HEIGHT = 700;
const MAX_720_HEIGHT = 720;
const PREFERRED_MAX_HEIGHT = 720;
const DUPLICATE_WINDOW_MS = 300 * 1000;
const DUPLICATE_HISTORY_LIMIT = 3;
const VIDEO_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_CACHE_HARD_CLEANUP_MS = 10 * 60 * 1000;
const VIDEO_CACHE_SWEEP_MS = 60 * 1000;
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024;
const MAX_VIDEO_BLACKLIST_BYTES = 128 * 1024;
const MAX_ADMIN_IDS_BYTES = 128 * 1024;
const EXTERNAL_VIDEO_TASK_KIND = 'external_video_download';
const CACHE_FILE_RE = /^bili-cache-[a-z0-9]+-\d+-[a-z0-9]+\.mp4$/;
const STAGING_DIR_RE = /^bili-job-[a-z0-9]+-\d+-[a-z0-9]+$/;
const CACHE_DIR = path.join(WORKDIR, 'cache');
const STAGING_ROOT = path.join(WORKDIR, '.staging');
const STATIC_VIDEO_USER_ERRORS = {
    'video-001': { stage: 'command_usage', message: '视频解析命令格式错误。详细信息：请在“bvidl”后填写B站链接；也可以填写BV号。错误编号：video-001。' },
    'video-003': { stage: 'resource_module_load', message: '视频下载暂时关闭。详细信息：视频资源门禁模块加载失败。错误编号：video-003。' },
    'video-006': { stage: 'resource_gate_acquire', message: '视频搬运暂时无法执行，请稍后再试。详细信息：视频资源锁在5秒内未申请成功。错误编号：video-006。' },
    'video-007': { stage: 'workdir_create', message: '视频目录准备失败，请稍后再试。详细信息：视频工作目录创建失败。错误编号：video-007。' },
    'video-008': { stage: 'cache_dir_create', message: '视频目录准备失败，请稍后再试。详细信息：五分钟视频缓存目录创建失败。错误编号：video-008。' },
    'video-009': { stage: 'staging_root_create', message: '视频目录准备失败，请稍后再试。详细信息：下载暂存根目录创建失败。错误编号：video-009。' },
    'video-010': { stage: 'video_probe', message: '视频信息获取失败，请稍后再试。详细信息：视频信息探测命令执行失败。错误编号：video-010。' },
    'video-013': { stage: 'preview_send_call', message: '视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息调用接口失败。错误编号：video-013。' },
    'video-014': { stage: 'size_estimate', message: '视频文件大小无法预估，请自行去 bilibili 观看。详细信息：所选清晰度缺少可用的文件大小、码率和时长数据。错误编号：video-014。' },
    'video-016': { stage: 'staging_create', message: '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录创建失败。错误编号：video-016。' },
    'video-017': { stage: 'staging_validate', message: '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录未通过安全校验。错误编号：video-017。' },
    'video-018': { stage: 'video_download', message: '视频下载失败，请稍后再试。详细信息：视频下载命令执行失败。错误编号：video-018。' },
    'video-019': { stage: 'output_path_validate', message: '视频文件校验失败，请稍后再试。详细信息：下载结果未通过视频缓存路径安全校验。错误编号：video-019。' },
    'video-020': { stage: 'output_stat', message: '视频文件校验失败，请稍后再试。详细信息：下载结果的文件信息读取失败。错误编号：video-020。' },
    'video-023': { stage: 'video_send_call', message: '视频发送失败，请稍后再试。详细信息：视频发送接口调用失败。错误编号：video-023。' },
    'video-025': { stage: 'cached_preview_send_call', message: '缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息调用接口失败。错误编号：video-025。' },
    'video-027': { stage: 'cached_video_send_call', message: '缓存视频发送失败，请稍后再试。详细信息：缓存视频发送接口调用失败。错误编号：video-027。' },
    'video-028': { stage: 'resource_busy_not_queued', message: '视频搬运资源正忙，本次没有进入队列，请稍后重新发送。错误编号：video-028。' },
    'video-029': { stage: 'queue_persist_failed', message: '视频任务排队保存失败，本次没有进入队列，请稍后重新发送。错误编号：video-029。' },
    'video-030': { stage: 'cookie_health', message: '视频凭据不可用，请联系管理员更新 B 站 Cookie。错误编号：video-030。' },
    'video-031': { stage: 'shortlink_resolution', message: 'B 站短链接解析失败，请重新复制链接或发送 BV 号。错误编号：video-031。' },
    'video-032': { stage: 'resource_gate_storage_failed', message: '视频资源系统故障，本次未执行。错误编号：video-032。' },
};
const RESOURCE_STATE_LABELS = {
    green: '正常',
    yellow: '注意',
    red: '紧张',
};
const ADMISSION_DECISION_LABELS = {
    reject: '拒绝',
    defer: '延后',
    queue: '排队',
    downgrade: '降级',
    silent_drop: '静默丢弃',
};
const recentParseHistory = new Map();
const videoFileCache = new Map();
const videoCacheAliases = new Map();
const inflightDownloads = new Map();
const queuedVideoSessions = new Map();
let videoTaskQueue = null;
let videoCacheSweepTimer = null;
let cacheDisposed = false;
let lastValidVideoAdminIds = [];
const gateAdminAlertWindows = new Map();
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
// 通过统一模块写入白名单视频生命周期事件。
function writeVideoTrace(ctx, trace, event, fields = {}) {
    return !!trace && videoTraceModule.writeVideoTrace(ctx.logger('bvidl'), trace, event, fields);
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
async function acquireVideoResourceGate(ctx, session, source, deps = {}, existingTaskId = '', trace) {
    if (deps.resourceGate === false) {
        writeVideoTrace(ctx, trace, 'admission_decided', { decision: 'bypassed', reason: 'test_dependency_override' });
        writeVideoTrace(ctx, trace, 'gate_acquired', { stage: 'resource_gate_bypassed' });
        return { ok: true, handle: null, taskId: existingTaskId };
    }
    const modules = Object.prototype.hasOwnProperty.call(deps, 'resourceModules') ? deps.resourceModules || null : loadVideoResourceModules(ctx);
    if (!modules) {
        const userError = buildVideoUserError({ id: 'video-003' });
        logVideoUserError(ctx, userError);
        return { ok: false, userError };
    }
    const taskId = existingTaskId || buildVideoTaskId(session, source);
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
    writeVideoTrace(ctx, trace, 'admission_decided', { decision: String(admission.decision), reason: String(admission.reason || admission.decision) });
    if (admission.decision !== 'run_now') {
        ctx.logger('bvidl').warn(`video download rejected by resource scheduler: ${admission.reason || admission.decision}; state=${admission.resourceState || 'unknown'} mem=${admission.memAvailableMb ?? 'unknown'}MB min=${VIDEO_MIN_MEM_MB}MB`);
        ctx.logger('bvidl').warn(`admission_decided decision=${admission.decision} queue_persisted=false reason=${sanitizeResourceId(admission.reason || admission.decision)}`);
        const canOnlyQueue = ['queue', 'defer', 'downgrade'].includes(String(admission.decision));
        const userError = canOnlyQueue
            ? buildVideoUserError({ id: 'video-028' })
            : typeof admission.memAvailableMb === 'number' && Number.isFinite(admission.memAvailableMb)
                ? buildVideoUserError({
                    id: 'video-004',
                    resourceState: admission.resourceState,
                    availableMemoryMb: admission.memAvailableMb,
                    minimumMemoryMb: VIDEO_MIN_MEM_MB,
                    decision: admission.decision,
                })
                : buildVideoUserError({
                    id: 'video-005',
                    resourceState: admission.resourceState,
                    minimumMemoryMb: VIDEO_MIN_MEM_MB,
                    decision: admission.decision,
                });
        logVideoUserError(ctx, userError);
        return { ok: false, busy: canOnlyQueue, taskId, userError };
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
        writeVideoTrace(ctx, trace, 'gate_acquired', { stage: 'video_prepare' });
        return { ok: true, handle, taskId };
    }
    catch (error) {
        const storageFailure = getResourceGateStorageFailure(error);
        if (storageFailure) {
            await reportResourceGateStorageFailure(ctx, session, storageFailure, trace?.traceId || taskId, taskId, deps.gateAdminAlertOptions, trace);
            const userError = buildVideoUserError({ id: 'video-032' });
            logVideoUserError(ctx, userError, `failureCode=${storageFailure.failureCode} errno=${storageFailure.errno} stage=${storageFailure.stage} safePath=${storageFailure.safePath}`);
            return { ok: false, userError };
        }
        const isBusyTimeout = !!(error && typeof error === 'object' && (error.code === 'gate_busy_timeout'
            || error.name === 'ResourceGateBusyTimeoutError'));
        if (isBusyTimeout) {
            ctx.logger('bvidl').warn(`gate_busy_timeout taskId=${taskId} queue_persisted=false`);
            const userError = buildVideoUserError({ id: 'video-028' });
            return { ok: false, busy: true, taskId, userError };
        }
        ctx.logger('bvidl').warn(`video download gate wait failed: ${getErrorMessage(error)}`);
        const userError = buildVideoUserError({ id: 'video-006' });
        logVideoUserError(ctx, userError);
        return { ok: false, userError };
    }
}
// 按固定编号生成只包含安全动态数据的中文用户报错。
function buildVideoUserError(input) {
    switch (input.id) {
        case 'video-002': {
            const remainingSeconds = Math.min(300, Math.max(1, Math.ceil(safeNumber(input.remainingSeconds))));
            return {
                id: input.id,
                stage: 'duplicate_request',
                message: `请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余${remainingSeconds}秒。错误编号：video-002。`,
            };
        }
        case 'video-004': {
            const resourceState = RESOURCE_STATE_LABELS[String(input.resourceState)] || '未识别';
            const decision = ADMISSION_DECISION_LABELS[String(input.decision)] || '未识别';
            const availableMemoryMb = Math.max(0, Math.round(safeNumber(input.availableMemoryMb)));
            const minimumMemoryMb = Math.max(1, Math.round(safeNumber(input.minimumMemoryMb)));
            return {
                id: input.id,
                stage: 'resource_admission_with_memory',
                message: `视频搬运暂时无法执行，本次请求未执行。详细信息：资源状态为${resourceState}，当前可用内存${availableMemoryMb}MB，视频任务最低需要${minimumMemoryMb}MB，调度结果为${decision}。错误编号：video-004。`,
            };
        }
        case 'video-005': {
            const resourceState = RESOURCE_STATE_LABELS[String(input.resourceState)] || '未识别';
            const decision = ADMISSION_DECISION_LABELS[String(input.decision)] || '未识别';
            const minimumMemoryMb = Math.max(1, Math.round(safeNumber(input.minimumMemoryMb)));
            return {
                id: input.id,
                stage: 'resource_admission_without_memory',
                message: `视频搬运暂时无法执行，本次请求未执行。详细信息：资源状态为${resourceState}，当前可用内存数据未取得，视频任务最低需要${minimumMemoryMb}MB，调度结果为${decision}。错误编号：video-005。`,
            };
        }
        case 'video-011': {
            const bvMatch = String(input.bvId || '').match(/^BV[0-9A-Za-z]{10}$/i);
            const partNumber = Math.max(1, Math.floor(safeNumber(input.partNumber)));
            const target = bvMatch ? `${bvMatch[0]}第${partNumber}P` : `当前链接第${partNumber}P`;
            return {
                id: input.id,
                stage: 'format_select',
                message: `视频信息获取失败，请稍后再试。详细信息：${target}未找到可用的视频格式。错误编号：video-011。`,
            };
        }
        case 'video-012':
            return {
                id: input.id,
                stage: 'preview_send_rejected',
                message: `视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-012。`,
            };
        case 'video-015': {
            const estimatedBytes = Math.max(0, Math.round(safeNumber(input.estimatedBytes)));
            return {
                id: input.id,
                stage: 'estimated_size_limit',
                message: `视频文件过大（${formatDecimalMb(estimatedBytes)}），请自行去 bilibili 观看。详细信息：预计大小为${estimatedBytes}字节，上传限制为${MAX_SIZE}字节。错误编号：video-015。`,
            };
        }
        case 'video-021': {
            const actualBytes = Math.max(0, Math.round(safeNumber(input.actualBytes)));
            return {
                id: input.id,
                stage: 'actual_size_limit',
                message: `视频文件过大（${formatDecimalMb(actualBytes)}），请自行去 bilibili 观看。详细信息：实际大小为${actualBytes}字节，上传限制为${MAX_SIZE}字节。错误编号：video-021。`,
            };
        }
        case 'video-022':
            return {
                id: input.id,
                stage: 'video_send_rejected',
                message: `视频发送失败，请稍后再试。详细信息：视频发送请求被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-022。`,
            };
        case 'video-024':
            return {
                id: input.id,
                stage: 'cached_preview_send_rejected',
                message: `缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-024。`,
            };
        case 'video-026':
            return {
                id: input.id,
                stage: 'cached_video_send_rejected',
                message: `缓存视频发送失败，请稍后再试。详细信息：缓存视频发送请求被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-026。`,
            };
        default: {
            const definition = STATIC_VIDEO_USER_ERRORS[input.id];
            return { id: input.id, stage: definition.stage, message: definition.message };
        }
    }
}
// 记录用户错误编号和固定阶段，原始技术详情只进入服务端日志。
function logVideoUserError(ctx, userError, technicalDetail = '') {
    const suffix = technicalDetail ? ` detail=${technicalDetail}` : '';
    ctx.logger('bvidl').warn(`user_error_id=${userError.id} stage=${userError.stage}${suffix}`);
}
// 将主插件上下文适配到独立的 B 站输入与短链安全边界。
async function resolveInputBiliTarget(ctx, url, source, deps = {}, trace) {
    const shortCodeHash = videoTraceModule.hashVideoTraceValue(url);
    return biliInput.resolveBiliInput({
        url,
        source,
        resolveShortLink: deps.resolveShortLink,
        onShortLinkHop: event => {
            ctx.logger('bvidl').warn(`shortlink_hop hop=${event.hop} statusCode=${event.statusCode ?? 'none'} finalHost=${event.finalHost} finalPath=${event.finalPath} failureCode=${event.failureCode || 'none'} elapsedMs=${event.elapsedMs}`);
            writeVideoTrace(ctx, trace, 'shortlink_hop', { shortCodeHash, hop: event.hop, statusCode: event.statusCode, finalHost: event.finalHost, finalPath: event.finalPath, code: event.failureCode, durationMs: event.elapsedMs });
        },
        onError: failure => {
            ctx.logger('bvidl').warn(`shortlink_failed failureCode=${failure.code} hops=${failure.hops} statusCode=${failure.statusCode ?? 'none'}`);
            writeVideoTrace(ctx, trace, 'shortlink_failed', { shortCodeHash, hop: failure.hops, statusCode: failure.statusCode, code: failure.code });
        },
    });
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
// 返回当前群命中的重复记录和剩余限制秒数。
function findRecentDuplicateParse(session, keys, now = Date.now()) {
    if (!keys.length)
        return null;
    const history = pruneRecentParseHistory(session, now);
    const entry = history.find(item => item.keys.some(key => keys.includes(key)));
    if (!entry)
        return null;
    const remainingMs = Math.max(1, DUPLICATE_WINDOW_MS - Math.max(0, now - entry.timestamp));
    return { entry, remainingSeconds: Math.ceil(remainingMs / 1000) };
}
// 判断当前群是否仍处于相同视频的重复解析窗口。
function isRecentDuplicateParse(session, keys, now = Date.now()) {
    return !!findRecentDuplicateParse(session, keys, now);
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
// 生成下载前预计体积超限的详细中文提示。
function buildOversizeMessage(bytes) {
    return buildVideoUserError({ id: 'video-015', estimatedBytes: bytes }).message;
}
// 生成下载后实际体积超限的详细中文提示。
function buildActualOversizeMessage(bytes) {
    return buildVideoUserError({ id: 'video-021', actualBytes: bytes }).message;
}
// --- 视频缓存与暂存目录安全 ---
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
// 判断路径是否为暂存根目录下命名合规的直接子目录。
function isStagingPathShapeSafe(stagingDir) {
    const stagingRoot = path.resolve(STAGING_ROOT);
    const resolved = path.resolve(stagingDir);
    return path.dirname(resolved) === stagingRoot && STAGING_DIR_RE.test(path.basename(resolved));
}
// 读取系统错误码；缺少错误码时返回固定占位值。
function getNodeErrorCode(error, fallback = 'UNKNOWN') {
    const code = error && typeof error === 'object' ? error.code : '';
    return typeof code === 'string' && code.trim() ? code.trim() : fallback;
}
// 校验暂存目录类型与真实路径，并保留读取失败的准确原因。
async function validateStagingDirectory(stagingDir, fsApi = fs) {
    const resolved = path.resolve(stagingDir);
    if (!isStagingPathShapeSafe(resolved))
        return { status: 'rejected', error: '暂存目录不是暂存根目录下命名合规的直接子目录' };
    let stat;
    try {
        stat = await fsApi.lstat(resolved);
    }
    catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT')
            return { status: 'missing' };
        return { status: 'failed', code: getNodeErrorCode(error), error: `读取暂存目录信息失败：${getErrorMessage(error)}` };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
        return { status: 'rejected', error: '暂存目标不是普通目录或目标是符号链接' };
    let realRoot;
    try {
        realRoot = await fsApi.realpath(STAGING_ROOT);
    }
    catch (error) {
        return { status: 'failed', code: getNodeErrorCode(error), error: `解析暂存根目录真实路径失败：${getErrorMessage(error)}` };
    }
    let realDir;
    try {
        realDir = await fsApi.realpath(resolved);
    }
    catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT')
            return { status: 'missing' };
        return { status: 'failed', code: getNodeErrorCode(error), error: `解析暂存目录真实路径失败：${getErrorMessage(error)}` };
    }
    if (path.dirname(realDir) !== realRoot)
        return { status: 'rejected', error: '暂存目录真实路径已离开暂存根目录' };
    return { status: 'safe' };
}
// 校验暂存目录是否可以由当前任务安全删除。
async function isSafeStagingDirectory(stagingDir, fsApi = fs) {
    return (await validateStagingDirectory(stagingDir, fsApi)).status === 'safe';
}
// 为单次首次下载创建权限受限的暂存目录，并返回精确失败阶段。
async function createRequestStagingDirectory(cacheSlug) {
    const stagingName = `bili-job-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingDir = path.join(STAGING_ROOT, stagingName);
    try {
        await fs.mkdir(stagingDir, { mode: 0o700 });
    }
    catch (error) {
        return { status: 'create_failed', path: stagingDir, error };
    }
    if (!await isSafeStagingDirectory(stagingDir)) {
        return { status: 'safety_validation_failed', path: stagingDir };
    }
    return { status: 'ready', path: stagingDir };
}
// 把时间转换为固定的北京时间文本。
function formatBeijingTime(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
// 清理错误文本中的换行、完整地址和登录凭据路径。
function sanitizeStagingCleanupError(error) {
    return getErrorMessage(error)
        .replace(/https?:\/\/\S+/gi, '[url]')
        .split(COOKIES).join('[cookies-file]')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000) || '未提供错误文本';
}
// 从运行数据目录读取并严格筛选纯数字超级管理员账号，成功后更新最后有效缓存。
async function loadVideoAdminIds(adminIdsFile, fsApi) {
    try {
        const stat = await fsApi.stat(adminIdsFile);
        if (!stat.isFile())
            return { status: 'failed', code: 'ADMIN_IDS_NOT_FILE', error: '超级管理员名单路径不是普通文件' };
        if (stat.size > MAX_ADMIN_IDS_BYTES)
            return { status: 'failed', code: 'ADMIN_IDS_TOO_LARGE', error: `超级管理员名单文件超过${MAX_ADMIN_IDS_BYTES}字节` };
    }
    catch (error) {
        return { status: 'failed', code: getNodeErrorCode(error), error: `读取超级管理员名单文件信息失败：${sanitizeStagingCleanupError(error)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(String(await fsApi.readFile(adminIdsFile, 'utf8')));
    }
    catch (error) {
        return { status: 'failed', code: 'ADMIN_IDS_INVALID_JSON', error: `超级管理员名单不是有效 JSON：${sanitizeStagingCleanupError(error)}` };
    }
    if (!Array.isArray(parsed))
        return { status: 'failed', code: 'ADMIN_IDS_NOT_ARRAY', error: '超级管理员名单顶层结构不是数组' };
    const values = parsed.map(value => value === null || value === undefined ? '' : String(value).trim());
    const ids = [...new Set(values.filter(value => /^\d+$/.test(value)))];
    const invalidCount = values.filter(value => !/^\d+$/.test(value)).length;
    if (!ids.length)
        return { status: 'failed', code: 'ADMIN_IDS_EMPTY', error: '超级管理员名单中没有有效的纯数字 QQ 号' };
    lastValidVideoAdminIds = ids.slice();
    return { status: 'ready', ids, invalidCount };
}
// 构造发给超级管理员的固定清理失败文本。
function buildStagingCleanupAdminMessage(failure) {
    return [
        '【视频暂存目录清理失败】',
        `任务：${failure.taskId}`,
        `视频：${failure.bvId}`,
        `暂存目录：${failure.stagingDir}`,
        `错误码：${failure.errorCode}`,
        `错误信息：${failure.errorText}`,
        `时间：${failure.beijingTime}`,
        '请登录服务器人工处理。',
    ].join('\n');
}
// 读取最新管理员名单；读取失败时返回进程内最后一次有效名单。
async function resolveVideoAdminIds(ctx, adminIdsFile, fsApi, logPrefix) {
    const adminResult = await loadVideoAdminIds(adminIdsFile, fsApi);
    if (adminResult.status === 'failed') {
        ctx.logger('bvidl').warn(`${logPrefix}_admin_ids_unavailable: file=${JSON.stringify(path.resolve(adminIdsFile))} code=${adminResult.code} error=${JSON.stringify(adminResult.error)} cached_count=${lastValidVideoAdminIds.length}`);
        return lastValidVideoAdminIds.slice();
    }
    if (adminResult.invalidCount > 0)
        ctx.logger('bvidl').warn(`${logPrefix}_admin_ids_invalid: invalid_count=${adminResult.invalidCount}`);
    return adminResult.ids;
}
// 复用同一管理员配置向全部有效 QQ 私聊，单个发送失败只记录一次且不递归告警。
async function sendVideoAdminAlert(ctx, session, message, options, logPrefix) {
    const fsApi = options.fs || fs;
    const adminIdsFile = options.adminIdsFile || ADMIN_IDS_FILE;
    const adminIds = await resolveVideoAdminIds(ctx, adminIdsFile, fsApi, logPrefix);
    if (!adminIds.length)
        return false;
    const internal = session.bot?.internal;
    const sendPrivateMsg = internal?.sendPrivateMsg;
    if (typeof sendPrivateMsg !== 'function') {
        ctx.logger('bvidl').warn(`${logPrefix}_admin_notify_unavailable: reason=sendPrivateMsg_unavailable admin_count=${adminIds.length}`);
        return false;
    }
    const results = await Promise.all(adminIds.map(async (adminId) => {
        try {
            await sendPrivateMsg.call(internal, adminId, message);
            return true;
        }
        catch (error) {
            ctx.logger('bvidl').warn(`${logPrefix}_admin_notify_failed: admin=${adminId} code=${getNodeErrorCode(error)} error=${JSON.stringify(sanitizeStagingCleanupError(error))}`);
            return false;
        }
    }));
    return results.some(Boolean);
}
// 将一次暂存目录清理失败通过通用视频管理员通道发送，不重试失败通知。
async function notifyStagingCleanupFailure(ctx, session, failure, options) {
    await sendVideoAdminAlert(ctx, session, buildStagingCleanupAdminMessage(failure), options, 'staging_cleanup');
}
// 记录并通知同一份结构化暂存目录清理失败信息。
async function reportStagingCleanupFailure(ctx, session, failure, options) {
    if (!ctx)
        return;
    ctx.logger('bvidl').warn(`${failure.event}: task=${failure.taskId} bv=${failure.bvId} dir=${JSON.stringify(failure.stagingDir)} code=${failure.errorCode} error=${JSON.stringify(failure.errorText)} beijing_time=${JSON.stringify(failure.beijingTime)}`);
    await notifyStagingCleanupFailure(ctx, session, failure, options);
}
const GATE_FAILURE_CHINESE_REASON = {
    gate_permission_denied: '资源锁路径权限不足',
    gate_readonly_filesystem: '资源锁所在文件系统只读',
    gate_storage_full: '资源锁所在磁盘空间或 inode 已用尽',
    gate_quota_exceeded: '资源锁所在磁盘配额已耗尽',
    gate_path_invalid: '资源锁路径结构错误',
    gate_fd_exhausted: '资源锁进程或系统文件描述符已耗尽',
    gate_io_error: '资源锁磁盘输入输出错误',
    gate_state_unreadable: '资源锁状态存在但无法读取或校验',
    gate_event_write_failed: '资源锁事件日志写入失败',
    gate_cleanup_failed: '资源锁残留状态清理失败',
};
// 从跨包或注入异常中提取计划规定的资源锁结构化存储故障。
function getResourceGateStorageFailure(error) {
    if (!error || typeof error !== 'object')
        return null;
    const candidate = error;
    const failureCode = String(candidate.failureCode || '');
    if (!Object.prototype.hasOwnProperty.call(GATE_FAILURE_CHINESE_REASON, failureCode))
        return null;
    return {
        failureCode,
        errno: String(candidate.errno || 'UNKNOWN').slice(0, 40),
        stage: sanitizeResourceId(candidate.stage || 'unknown'),
        safePath: String(candidate.safePath || '.').replace(/[^a-zA-Z0-9._/-]/g, '_').slice(0, 240) || '.',
    };
}
// 构造不含 Cookie、正文、完整 URL 或堆栈的资源锁管理员私聊文本。
function buildGateAdminAlertMessage(failure, traceId, taskId, now) {
    return [
        '【视频资源锁存储故障】',
        `时间：${formatBeijingTime(now)}`,
        `中文原因：${GATE_FAILURE_CHINESE_REASON[failure.failureCode] || '资源锁存储故障'}`,
        `内部代码：${failure.failureCode}`,
        `系统错误码：${failure.errno}`,
        `链路编号：${sanitizeResourceId(traceId)}`,
        `任务编号：${sanitizeResourceId(taskId)}`,
        `失败步骤：${failure.stage}`,
        `脱敏路径：${failure.safePath}`,
        '本次任务未入队。',
    ].join('\n');
}
// 为 5 分钟告警合并窗口生成稳定键。
function buildGateAdminAlertKey(failure) {
    return [failure.failureCode, failure.errno, failure.stage, failure.safePath].join('|');
}
// 窗口结束时仅为出现重复的同类故障发送一次累计汇总。
async function flushGateAdminAlertWindow(key) {
    const window = gateAdminAlertWindows.get(key);
    if (!window)
        return;
    gateAdminAlertWindows.delete(key);
    if (window.count <= 1)
        return;
    const message = [
        '【视频资源锁故障五分钟汇总】',
        `内部代码：${window.failure.failureCode}`,
        `系统错误码：${window.failure.errno}`,
        `失败步骤：${window.failure.stage}`,
        `脱敏路径：${window.failure.safePath}`,
        `总次数：${window.count}`,
        `首次时间：${formatBeijingTime(window.firstAt)}`,
        `最后时间：${formatBeijingTime(window.lastAt)}`,
    ].join('\n');
    await sendVideoAdminAlert(window.ctx, window.session, message, window.options, 'gate');
    window.ctx.logger('bvidl').warn(`gate_admin_alert_summary failureCode=${window.failure.failureCode} errno=${window.failure.errno} stage=${window.failure.stage} safePath=${window.failure.safePath} count=${window.count}`);
    writeVideoTrace(window.ctx, window.trace, 'gate_admin_alert_summary', { code: window.failure.failureCode, reason: `count=${window.count}` });
}
// 首次故障立即通知全部管理员，同键后续故障只计数并在五分钟结束时汇总。
async function reportResourceGateStorageFailure(ctx, session, failure, traceId, taskId, options = {}, trace) {
    const now = options.now === undefined ? Date.now() : options.now;
    const traceContext = trace || videoTraceModule.createVideoTrace({ traceId, taskId, inputType: 'unknown', startedAt: now });
    const key = buildGateAdminAlertKey(failure);
    const current = gateAdminAlertWindows.get(key);
    ctx.logger('bvidl').warn(`gate_storage_failed failureCode=${failure.failureCode} errno=${failure.errno} stage=${failure.stage} safePath=${failure.safePath} traceId=${sanitizeResourceId(traceId)} taskId=${sanitizeResourceId(taskId)}`);
    writeVideoTrace(ctx, traceContext, 'gate_storage_failed', { stage: failure.stage, code: failure.failureCode, reason: `${failure.errno}:${failure.safePath}` });
    if (current) {
        current.count += 1;
        current.lastAt = now;
        ctx.logger('bvidl').warn(`gate_admin_alert_suppressed failureCode=${failure.failureCode} errno=${failure.errno} stage=${failure.stage} safePath=${failure.safePath} count=${current.count}`);
        writeVideoTrace(ctx, traceContext, 'gate_admin_alert_suppressed', { stage: failure.stage, code: failure.failureCode, reason: `count=${current.count}` });
        return;
    }
    const schedule = options.schedule || ((handler, delayMs) => setTimeout(handler, delayMs));
    const timer = schedule(() => { void flushGateAdminAlertWindow(key); }, 5 * 60 * 1000);
    timer.unref?.();
    gateAdminAlertWindows.set(key, { count: 1, firstAt: now, lastAt: now, timer, ctx, session, failure, traceId, taskId, options, trace: traceContext });
    const sent = await sendVideoAdminAlert(ctx, session, buildGateAdminAlertMessage(failure, traceId, taskId, now), options, 'gate');
    if (sent) {
        ctx.logger('bvidl').warn(`gate_admin_alert_sent failureCode=${failure.failureCode} errno=${failure.errno} stage=${failure.stage} safePath=${failure.safePath}`);
        writeVideoTrace(ctx, traceContext, 'gate_admin_alert_sent', { stage: failure.stage, code: failure.failureCode });
    }
}
// 清理资源锁告警窗口及管理员缓存，供插件关闭和测试隔离。
function clearVideoAdminAlertState() {
    for (const window of gateAdminAlertWindows.values())
        clearTimeout(window.timer);
    gateAdminAlertWindows.clear();
    lastValidVideoAdminIds = [];
}
// 在当前任务 finally 中安全删除一次暂存目录；失败时只告警，不重删。
async function removeRequestStagingDirectory(ctx, session, stagingDir, bvId, taskId, options = {}) {
    const fsApi = options.fs || fs;
    const resolved = path.resolve(stagingDir);
    const normalizedBvId = extractBvId(bvId) || 'unknown';
    const normalizedTaskId = String(taskId || '').trim() || 'unknown';
    const validation = await validateStagingDirectory(resolved, fsApi);
    if (validation.status === 'missing')
        return true;
    if (validation.status === 'rejected' || validation.status === 'failed') {
        const failure = {
            event: validation.status === 'rejected' ? 'staging_cleanup_rejected' : 'staging_cleanup_failed',
            taskId: normalizedTaskId,
            bvId: normalizedBvId,
            stagingDir: resolved,
            errorCode: validation.status === 'rejected' ? 'SAFETY_VALIDATION_FAILED' : validation.code,
            errorText: sanitizeStagingCleanupError(validation.error),
            beijingTime: formatBeijingTime(options.now),
        };
        await reportStagingCleanupFailure(ctx, session, failure, options);
        return false;
    }
    try {
        await fsApi.rm(resolved, { recursive: true, force: true });
        return true;
    }
    catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT')
            return true;
        const failure = {
            event: 'staging_cleanup_failed',
            taskId: normalizedTaskId,
            bvId: normalizedBvId,
            stagingDir: resolved,
            errorCode: getNodeErrorCode(error),
            errorText: sanitizeStagingCleanupError(error),
            beijingTime: formatBeijingTime(options.now),
        };
        await reportStagingCleanupFailure(ctx, session, failure, options);
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
function registerVideoFileCache(ctx, filePath, sizeBytes, infoMessage, keys, lastSendStatus, now = Date.now()) {
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
        lastSendStatus,
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
// 判断消息是否包含可直接搬运的 B 站视频标识或地址；显式命令仍交给命令处理器。
function isStandaloneBilibiliVideoInput(input = '') {
    const text = normalizeSharedText(input).trim();
    return !!text && !/^bvidl\b/i.test(text) && !!extractBiliUrl(text);
}
// 使用现有封面信息和磁盘 MP4 向当前会话发送缓存视频。
async function sendCachedVideo(ctx, session, entry, trace) {
    entry.activeSends += 1;
    try {
        const previewOutcome = await safeSend(ctx, session, entry.infoMessage, 'cached preview');
        writeVideoTrace(ctx, trace, 'preview_send_finished', { stage: 'cached_preview', ok: previewOutcome.status === 'confirmed', reason: previewOutcome.status });
        if (previewOutcome.status === 'uncertain') {
            return { status: 'failed', reason: 'cached_preview_send_uncertain' };
        }
        if (previewOutcome.status === 'failed') {
            const userError = previewOutcome.reason === 'rejected'
                ? buildVideoUserError({ id: 'video-024', retcode: previewOutcome.retcode })
                : buildVideoUserError({ id: 'video-025' });
            logVideoUserError(ctx, userError);
            return { status: 'failed', reason: previewOutcome.reason, userError };
        }
        const videoOutcome = await safeSend(ctx, session, segment.video(toFileUrl(entry.filePath)), 'cached video');
        writeVideoTrace(ctx, trace, 'video_send_finished', { stage: 'cached_video', ok: videoOutcome.status === 'confirmed', reason: videoOutcome.status });
        entry.lastSendStatus = videoOutcome.status;
        if (videoOutcome.status === 'uncertain') {
            return { status: 'failed', reason: 'cached_video_send_uncertain' };
        }
        if (videoOutcome.status === 'failed') {
            const userError = videoOutcome.reason === 'rejected'
                ? buildVideoUserError({ id: 'video-026', retcode: videoOutcome.retcode })
                : buildVideoUserError({ id: 'video-027' });
            logVideoUserError(ctx, userError);
            return { status: 'failed', reason: videoOutcome.reason, userError };
        }
        return { status: 'done' };
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
// 启动一分钟最终缓存清理，并注册插件关闭时的收口动作。
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
        biliInput.clearBiliInputCache();
        clearBiliCookieHealthCache();
        clearVideoAdminAlertState();
        inflightDownloads.clear();
    });
}
// 插件启动时只清理命名和真实路径均属于视频暂存根目录的上次运行遗留目录。
function cleanupInterruptedVideoStagingDirectories(ctx) {
    let removed = 0;
    let failed = 0;
    try {
        fsSync.mkdirSync(STAGING_ROOT, { recursive: true, mode: 0o700 });
        const realRoot = fsSync.realpathSync(STAGING_ROOT);
        for (const entry of fsSync.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory() || !STAGING_DIR_RE.test(entry.name))
                continue;
            const target = path.join(STAGING_ROOT, entry.name);
            try {
                const stat = fsSync.lstatSync(target);
                const realTarget = fsSync.realpathSync(target);
                if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(realTarget) !== realRoot)
                    continue;
                fsSync.rmSync(target, { recursive: true, force: true });
                removed += 1;
            }
            catch (error) {
                failed += 1;
                ctx.logger('bvidl').warn(`startup_staging_cleanup_failed path=${JSON.stringify(entry.name)} code=${getNodeErrorCode(error)}`);
            }
        }
    }
    catch (error) {
        failed += 1;
        ctx.logger('bvidl').warn(`startup_staging_scan_failed code=${getNodeErrorCode(error)}`);
    }
    ctx.logger('bvidl').warn(`startup_staging_discarded removed=${removed} failed=${failed}`);
    return { removed, failed };
}
// 返回可用于测试和运行时验收的无敏感缓存摘要。
function getVideoCacheStatus() {
    return {
        entries: videoFileCache.size,
        aliases: videoCacheAliases.size,
        inflight: inflightDownloads.size,
        shortLinks: biliInput.getBiliInputCacheSize(),
        items: [...videoFileCache.values()].map(entry => ({
            bvKey: entry.bvKey,
            sizeBytes: entry.sizeBytes,
            expiresAt: entry.expiresAt,
            activeSends: entry.activeSends,
            lastSendStatus: entry.lastSendStatus,
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
// 将消息接口异常严格区分为超时、明确拒绝和普通调用异常。
async function safeSend(ctx, session, message, label = 'message') {
    try {
        await session.send(message);
        return { status: 'confirmed' };
    }
    catch (error) {
        const candidate = error;
        const constructorName = error instanceof Error ? error.constructor.name : '';
        if (constructorName === 'TimeoutError' && candidate.url === 'send_group_msg') {
            const messageText = getErrorMessage(error);
            ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=uncertain`);
            return { status: 'uncertain', reason: 'timeout', error: messageText };
        }
        if (constructorName === 'SenderError' && candidate.url === 'send_group_msg' && typeof candidate.code === 'number' && Number.isFinite(candidate.code)) {
            const messageText = getErrorMessage(error);
            ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=failed reason=rejected retcode=${Math.trunc(candidate.code)}`);
            return { status: 'failed', reason: 'rejected', retcode: Math.trunc(candidate.code), error: messageText };
        }
        const messageText = getErrorMessage(error);
        ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=failed reason=call_error`);
        return { status: 'failed', reason: 'call_error', error: messageText };
    }
}
// 从探测目标和元数据中提取可安全显示的规范 BV 号。
function getProbeBvId(url, info) {
    const candidates = [info.id, info.display_id, info.webpage_url, info.original_url, url];
    for (const candidate of candidates) {
        const match = String(candidate || '').match(/\bBV[0-9A-Za-z]{10}\b/i);
        if (match)
            return match[0];
    }
    return '';
}
// 从显式查询参数和 yt-dlp 条目标识中解析正整数分 P，缺省为 P1。
function getProbePartNumber(url, info) {
    try {
        const value = Number(new URL(url).searchParams.get('p'));
        if (Number.isInteger(value) && value > 0)
            return value;
    }
    catch { /* canonical BV input may be supplied without a URL wrapper */
    }
    const entryMatch = String(info.id || '').match(/_p(\d+)$/i);
    const entryPart = entryMatch ? Number(entryMatch[1]) : 0;
    return Number.isInteger(entryPart) && entryPart > 0 ? entryPart : 1;
}
// 记录不含 Cookie 内容的运行健康摘要，供启动和每次处理链路定位文件变化。
function logBiliCookieHealth(ctx, stage, trace) {
    const health = getBiliCookieHealth(COOKIES);
    ctx.logger('bvidl').warn(`cookie_health_checked stage=${sanitizeResourceId(stage)} ok=${health.ok} code=${health.code} path=${JSON.stringify(health.path)} size=${health.size} records=${health.recordCount} mtime_ms=${health.mtimeMs}`);
    writeVideoTrace(ctx, trace, 'cookie_health_checked', { stage, ok: health.ok, code: health.code });
    return health;
}
// 探测视频元数据，并将无可用格式转换为受控中文错误。
async function probeVideo(url, runCommand = run) {
    const cookieHealth = getBiliCookieHealth(COOKIES);
    if (!cookieHealth.ok)
        return { userError: buildVideoUserError({ id: 'video-030' }) };
    const { stdout } = await runCommand(YTDLP, [
        '--cookies', COOKIES,
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        url,
    ], { timeout: 2 * 60 * 1000 });
    const info = JSON.parse(stdout);
    const picked = pickFormat(info);
    if (!picked) {
        return {
            info,
            userError: buildVideoUserError({
                id: 'video-011',
                bvId: getProbeBvId(url, info),
                partNumber: getProbePartNumber(url, info),
            }),
        };
    }
    return { info, picked };
}
// 生成不含完整 URL 和 Cookie 路径的 yt-dlp 错误摘要。
function getSafeCommandErrorSummary(error) {
    return getCommandErrorMessage(error)
        .replace(/https?:\/\/\S+/gi, '[url]')
        .split(COOKIES).join('[cookies-file]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000) || 'unknown';
}
// 显式发送拒绝提示，避免 action 返回值造成重复消息。
async function sendRejectedVideo(ctx, session, infoMessage, message, includePreview = true) {
    if (includePreview)
        await safeSend(ctx, session, infoMessage, 'preview');
    await safeSend(ctx, session, message, 'video refusal');
}
// 释放已取得的 S0 锁；释放期存储故障仍告警，但不覆盖已经明确的发送结果。
async function releaseAcquiredVideoGate(ctx, session, handle, reason, taskId, options = {}, trace) {
    try {
        handle?.release(reason);
        writeVideoTrace(ctx, trace, 'gate_released', { stage: reason });
    }
    catch (error) {
        const storageFailure = getResourceGateStorageFailure(error);
        if (!storageFailure) {
            ctx.logger('bvidl').warn(`video resource gate release failed: ${getErrorMessage(error)}`);
            return;
        }
        await reportResourceGateStorageFailure(ctx, session, storageFailure, trace?.traceId || taskId, taskId, options, trace);
    }
}
// 给缓存命中请求单独申请资源锁并发送磁盘视频。
async function sendCachedVideoWithGate(ctx, session, entry, source, deps, trace) {
    const taskId = buildVideoTaskId(session, source);
    const taskTrace = trace ? videoTraceModule.withVideoTraceTask(trace, taskId) : undefined;
    const gateResult = await acquireVideoResourceGate(ctx, session, source, deps, taskId, taskTrace);
    if (!gateResult.ok)
        return (gateResult.userError || buildVideoUserError({ id: 'video-003' })).message;
    const gateHandle = gateResult.handle || null;
    let sendResult = { status: 'failed', reason: 'cached_send_not_started' };
    try {
        gateHandle?.updateStep('video_cached_send');
        sendResult = await sendCachedVideo(ctx, session, entry, taskTrace);
    }
    catch (error) {
        const storageFailure = getResourceGateStorageFailure(error);
        if (!storageFailure)
            throw error;
        await reportResourceGateStorageFailure(ctx, session, storageFailure, taskTrace?.traceId || taskId, taskId, deps.gateAdminAlertOptions, taskTrace);
        const userError = buildVideoUserError({ id: 'video-032' });
        logVideoUserError(ctx, userError, `failureCode=${storageFailure.failureCode} errno=${storageFailure.errno} stage=${storageFailure.stage} safePath=${storageFailure.safePath}`);
        sendResult = { status: 'failed', reason: storageFailure.failureCode, userError };
    }
    finally {
        await releaseAcquiredVideoGate(ctx, session, gateHandle, 'external-video-cache-finally', taskId, deps.gateAdminAlertOptions, taskTrace);
    }
    writeVideoTrace(ctx, taskTrace, 'terminal_status', {
        status: sendResult.status === 'done' ? 'done' : 'failed',
        errorId: sendResult.status === 'failed' ? sendResult.userError?.id : undefined,
        reason: sendResult.status === 'done' ? 'cached_video_sent' : sendResult.reason,
    });
    return sendResult.status === 'failed' ? sendResult.userError?.message : undefined;
}
// 创建一个视频运行目录，并把失败转换为指定的目录错误编号。
async function ensureVideoDirectory(ctx, fsApi, directory, errorId) {
    try {
        await fsApi.mkdir(directory, { recursive: true });
        return null;
    }
    catch (error) {
        const userError = buildVideoUserError({ id: errorId });
        logVideoUserError(ctx, userError, getErrorMessage(error));
        return userError;
    }
}
// 对最终视频文件只执行一次删除，失败只记录服务端日志。
async function removeOutputFileOnce(ctx, fsApi, filePath, reason) {
    try {
        await fsApi.rm(filePath, { force: true });
    }
    catch (error) {
        ctx.logger('bvidl').warn(`video output delete failed: reason=${reason} error=${getErrorMessage(error)}`);
    }
}
// 为首次请求执行探测、大小门禁、下载、首发和缓存登记。
async function processInitialVideoRequest(ctx, session, url, source, keys, recentEntry, deps, existingTaskId = '', trace) {
    const taskId = existingTaskId || buildVideoTaskId(session, source);
    const taskTrace = trace ? videoTraceModule.withVideoTraceTask(trace, taskId) : undefined;
    const gateResult = await acquireVideoResourceGate(ctx, session, source, deps, taskId, taskTrace);
    if (!gateResult.ok) {
        const userError = gateResult.userError || buildVideoUserError({ id: 'video-003' });
        return gateResult.busy ? { kind: 'busy', taskId: gateResult.taskId || taskId, p1Url: url, keys, userError } : { kind: 'failed', userError };
    }
    const gateHandle = gateResult.handle || null;
    const fsApi = deps.fs || fs;
    const runCommand = deps.run || run;
    const probe = deps.probeVideo || probeVideo;
    const createStagingDirectory = deps.createStagingDirectory || createRequestStagingDirectory;
    const removeStagingDirectory = deps.removeStagingDirectory || removeRequestStagingDirectory;
    let outputFile = '';
    let stagingDir = '';
    let bvId = '';
    let bvKey = '';
    let cacheId = '';
    let pickedFormat = '';
    let downloadStartedAt = 0;
    let commandFailure = null;
    try {
        const workdirError = await ensureVideoDirectory(ctx, fsApi, WORKDIR, 'video-007');
        if (workdirError)
            return { kind: 'failed', userError: workdirError };
        const cacheDirError = await ensureVideoDirectory(ctx, fsApi, CACHE_DIR, 'video-008');
        if (cacheDirError)
            return { kind: 'failed', userError: cacheDirError };
        const stagingRootError = await ensureVideoDirectory(ctx, fsApi, STAGING_ROOT, 'video-009');
        if (stagingRootError)
            return { kind: 'failed', userError: stagingRootError };
        let info;
        let picked;
        gateHandle?.updateStep('video_probe');
        const probeCookieHealth = logBiliCookieHealth(ctx, 'before_probe', taskTrace);
        if (!probeCookieHealth.ok) {
            const userError = buildVideoUserError({ id: 'video-030' });
            logVideoUserError(ctx, userError, `code=${probeCookieHealth.code}`);
            return { kind: 'failed', userError };
        }
        const probeStartedAt = Date.now();
        writeVideoTrace(ctx, taskTrace, 'probe_started', { stage: 'video_probe' });
        try {
            const result = await probe(url);
            if (result.userError) {
                writeVideoTrace(ctx, taskTrace, 'probe_finished', { stage: 'video_probe', durationMs: Date.now() - probeStartedAt, ok: false, errorId: result.userError.id });
                logVideoUserError(ctx, result.userError);
                return { kind: 'failed', userError: result.userError };
            }
            if (!result.info || !result.picked) {
                const userError = buildVideoUserError({
                    id: 'video-011',
                    bvId: getProbeBvId(url, result.info || {}),
                    partNumber: getProbePartNumber(url, result.info || {}),
                });
                writeVideoTrace(ctx, taskTrace, 'probe_finished', { stage: 'video_probe', durationMs: Date.now() - probeStartedAt, ok: false, errorId: userError.id });
                logVideoUserError(ctx, userError);
                return { kind: 'failed', userError };
            }
            info = result.info;
            picked = result.picked;
            writeVideoTrace(ctx, taskTrace, 'probe_finished', { stage: 'video_probe', durationMs: Date.now() - probeStartedAt, ok: true });
        }
        catch (error) {
            ctx.logger('bvidl').warn(getCommandErrorMessage(error));
            const userError = buildVideoUserError({ id: 'video-010' });
            writeVideoTrace(ctx, taskTrace, 'probe_finished', { stage: 'video_probe', durationMs: Date.now() - probeStartedAt, ok: false, errorId: userError.id, reason: getSafeCommandErrorSummary(error) });
            logVideoUserError(ctx, userError, getSafeCommandErrorSummary(error));
            return { kind: 'failed', userError };
        }
        const canonicalKeys = uniqueStrings(keys
            .concat(buildBiliKeys(getCanonicalBiliUrl(info)))
            .concat(buildBiliKeys(getShortestBiliUrl(info))));
        mergeRecentParseKeys(recentEntry, canonicalKeys);
        const infoMessage = buildInfoMessage(info, picked);
        bvId = getProbeBvId(url, info);
        gateHandle?.updateStep('video_preview');
        const previewOutcome = await safeSend(ctx, session, infoMessage, 'preview');
        writeVideoTrace(ctx, taskTrace, 'preview_send_finished', { stage: 'video_preview', ok: previewOutcome.status === 'confirmed', reason: previewOutcome.status });
        if (previewOutcome.status === 'uncertain')
            return { kind: 'sent', sendStatus: 'uncertain' };
        if (previewOutcome.status === 'failed') {
            const userError = previewOutcome.reason === 'rejected'
                ? buildVideoUserError({ id: 'video-012', retcode: previewOutcome.retcode })
                : buildVideoUserError({ id: 'video-013' });
            logVideoUserError(ctx, userError);
            return { kind: 'failed', userError };
        }
        if (picked.totalSize <= 0) {
            const userError = buildVideoUserError({ id: 'video-014' });
            await sendRejectedVideo(ctx, session, infoMessage, userError.message, false);
            ctx.logger('bvidl').warn(`rejected_before_download: reason=size_unknown keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`);
            return { kind: 'rejected', infoMessage, userError };
        }
        if (picked.totalSize > MAX_SIZE) {
            const userError = buildVideoUserError({ id: 'video-015', estimatedBytes: picked.totalSize });
            await sendRejectedVideo(ctx, session, infoMessage, userError.message, false);
            ctx.logger('bvidl').warn(`rejected_before_download: reason=oversize estimated=${picked.totalSize} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`);
            return { kind: 'rejected', infoMessage, userError };
        }
        bvKey = canonicalKeys.find(key => key.startsWith('bv:')) || '';
        const cacheSlug = (bvKey.replace(/^bv:/, '') || 'unknown').replace(/[^a-z0-9]/g, '').slice(0, 32) || 'unknown';
        cacheId = `bili-cache-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        outputFile = path.join(CACHE_DIR, `${cacheId}.mp4`);
        let stagingResult;
        try {
            stagingResult = await createStagingDirectory(cacheSlug);
        }
        catch (error) {
            stagingResult = { status: 'create_failed', path: '', error };
        }
        stagingDir = stagingResult.path;
        if (stagingResult.status !== 'ready') {
            const userError = buildVideoUserError({ id: stagingResult.status === 'create_failed' ? 'video-016' : 'video-017' });
            const technicalDetail = stagingResult.status === 'create_failed' ? getErrorMessage(stagingResult.error) : 'safety_validation_failed';
            ctx.logger('bvidl').warn(`staging_prepare_failed: bv=${bvKey || 'unknown'} reason=${stagingResult.status} user_error_id=${userError.id} error=${technicalDetail}`);
            logVideoUserError(ctx, userError);
            return { kind: 'failed', userError };
        }
        gateHandle?.updateStep('video_download');
        const downloadCookieHealth = logBiliCookieHealth(ctx, 'before_download', taskTrace);
        if (!downloadCookieHealth.ok) {
            const userError = buildVideoUserError({ id: 'video-030' });
            logVideoUserError(ctx, userError, `code=${downloadCookieHealth.code}`);
            return { kind: 'failed', userError };
        }
        pickedFormat = picked.format;
        downloadStartedAt = Date.now();
        writeVideoTrace(ctx, taskTrace, 'download_started', { stage: 'video_download' });
        try {
            await runCommand(YTDLP, [
                '--cookies', COOKIES,
                '--no-playlist',
                '-f', picked.format,
                '--merge-output-format', 'mp4',
                '-P', `home:${CACHE_DIR}`,
                '-P', `temp:${stagingDir}`,
                '-o', `${cacheId}.%(ext)s`,
                url,
            ], { timeout: 10 * 60 * 1000 });
            writeVideoTrace(ctx, taskTrace, 'download_finished', { stage: 'video_download', durationMs: Date.now() - downloadStartedAt, ok: true });
        }
        catch (error) {
            commandFailure = error instanceof Error ? error : new Error(String(error));
            const userError = buildVideoUserError({ id: 'video-018' });
            writeVideoTrace(ctx, taskTrace, 'download_finished', { stage: 'video_download', durationMs: Date.now() - downloadStartedAt, ok: false, errorId: userError.id, reason: getSafeCommandErrorSummary(commandFailure) });
            logVideoUserError(ctx, userError, getSafeCommandErrorSummary(commandFailure));
            return { kind: 'failed', userError };
        }
        if (!isSafeVideoCacheFile(outputFile)) {
            const userError = buildVideoUserError({ id: 'video-019' });
            logVideoUserError(ctx, userError);
            return { kind: 'failed', userError };
        }
        let actualSize;
        try {
            actualSize = (await fsApi.stat(outputFile)).size;
        }
        catch (error) {
            const userError = buildVideoUserError({ id: 'video-020' });
            logVideoUserError(ctx, userError, getErrorMessage(error));
            return { kind: 'failed', userError };
        }
        if (actualSize > MAX_SIZE) {
            const userError = buildVideoUserError({ id: 'video-021', actualBytes: actualSize });
            await removeOutputFileOnce(ctx, fsApi, outputFile, 'actual_size_limit');
            outputFile = '';
            await sendRejectedVideo(ctx, session, infoMessage, userError.message, false);
            ctx.logger('bvidl').warn(`rejected_after_download: estimated=${picked.totalSize} actual=${actualSize} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`);
            return { kind: 'rejected', infoMessage, userError };
        }
        gateHandle?.updateStep('video_send');
        const videoOutcome = await safeSend(ctx, session, segment.video(toFileUrl(outputFile)), 'video');
        writeVideoTrace(ctx, taskTrace, 'video_send_finished', { stage: 'video_send', ok: videoOutcome.status === 'confirmed', reason: videoOutcome.status });
        if (videoOutcome.status === 'failed') {
            const userError = videoOutcome.reason === 'rejected'
                ? buildVideoUserError({ id: 'video-022', retcode: videoOutcome.retcode })
                : buildVideoUserError({ id: 'video-023' });
            await removeOutputFileOnce(ctx, fsApi, outputFile, userError.stage);
            outputFile = '';
            logVideoUserError(ctx, userError);
            return { kind: 'failed', userError };
        }
        const cacheEntry = registerVideoFileCache(ctx, outputFile, actualSize, infoMessage, canonicalKeys, videoOutcome.status);
        if (!cacheEntry) {
            await removeOutputFileOnce(ctx, fsApi, outputFile, videoOutcome.status === 'uncertain' ? 'uncertain_cache_registration' : 'cache_registration');
            outputFile = '';
            return { kind: 'sent', sendStatus: videoOutcome.status };
        }
        outputFile = '';
        return { kind: 'cached', entry: cacheEntry };
    }
    catch (error) {
        const storageFailure = getResourceGateStorageFailure(error);
        if (!storageFailure)
            throw error;
        await reportResourceGateStorageFailure(ctx, session, storageFailure, taskTrace?.traceId || taskId, taskId, deps.gateAdminAlertOptions, taskTrace);
        const userError = buildVideoUserError({ id: 'video-032' });
        logVideoUserError(ctx, userError, `failureCode=${storageFailure.failureCode} errno=${storageFailure.errno} stage=${storageFailure.stage} safePath=${storageFailure.safePath}`);
        return { kind: 'failed', userError };
    }
    finally {
        if (outputFile)
            await removeOutputFileOnce(ctx, fsApi, outputFile, 'request_finally');
        const cleanupOk = stagingDir ? await removeStagingDirectory(ctx, session, stagingDir, bvId, taskId) : true;
        if (commandFailure) {
            ctx.logger('bvidl').warn(`video_download_failed: cacheId=${cacheId || 'unknown'} bv=${bvKey || 'unknown'} format=${pickedFormat || 'unknown'} duration_ms=${downloadStartedAt ? Date.now() - downloadStartedAt : 0} exit_code=${commandFailure.code ?? 'unknown'} signal=${commandFailure.signal || 'none'} cleanup_ok=${cleanupOk} user_error_id=video-018 error=${getSafeCommandErrorSummary(commandFailure)}`);
        }
        await releaseAcquiredVideoGate(ctx, session, gateHandle, 'external-video-finally', taskId, deps.gateAdminAlertOptions, taskTrace);
    }
}
// 根据已归一化输入和原消息形态生成不含正文的输入类型标签。
function detectBiliInputType(url, source) {
    const normalizedSource = normalizeSharedText(source).trim();
    if (/^BV[0-9A-Za-z]{10}(?:\?p=\d+)?$/i.test(normalizedSource))
        return 'bare_bv';
    try {
        if (new URL(url).hostname.toLowerCase() === 'b23.tv')
            return 'short_link';
    }
    catch { /* 已归一化 URL 的最终校验由 bili-input 负责。 */ }
    if (isBilibiliCardInput(normalizedSource))
        return 'qq_card';
    return 'long_link';
}
// 从 session 生成队列允许持久化的原发送目标，不保存整个会话对象。
function getQueuedVideoTarget(session) {
    if (session.isDirect)
        return { targetType: 'private', targetId: getVideoUserId(session) };
    return { targetType: 'group', targetId: String(session.channelId || session.guildId || '') };
}
// 最终失败通知第一次明确失败后等待 10 秒只重试一次文字，不重新执行视频。
async function sendQueuedVideoFailureNotice(ctx, task, reason, deps) {
    const session = queuedVideoSessions.get(task.id);
    if (!session)
        return;
    const safeReason = /错误编号：video-\d{3}。/.test(reason)
        ? reason
        : `视频任务执行失败，请稍后重新发送。任务编号：${sanitizeResourceId(task.id)}。`;
    try {
        const first = await safeSend(ctx, session, safeReason, 'queued video terminal failure');
        if (first.status !== 'failed')
            return;
        const delay = deps.finalNoticeDelay || ((delayMs) => new Promise(resolve => setTimeout(resolve, delayMs)));
        await delay(10000);
        await safeSend(ctx, session, safeReason, 'queued video terminal failure retry');
    }
    finally {
        queuedVideoSessions.delete(task.id);
    }
}
// 从持久视频任务的最小 payload 恢复原 trace，不读取或记录消息正文。
function getQueuedVideoTrace(task) {
    const payload = task.payload;
    const requestedAt = Date.parse(String(payload.requestedAt || task.createdAt || ''));
    return videoTraceModule.createVideoTrace({
        traceId: String(payload.traceId || ''),
        taskId: task.id,
        inputType: String(payload.inputType || 'unknown'),
        videoKey: payload.bvId,
        startedAt: Number.isFinite(requestedAt) ? requestedAt : Date.now(),
    });
}
// 为队列完成、失败或重启取消写入唯一终态。
function recordQueuedVideoTerminal(ctx, task, status, reason) {
    const trace = getQueuedVideoTrace(task);
    writeVideoTrace(ctx, trace, 'terminal_status', { status, reason: reason || status, stage: 'video_queue_terminal' });
}
// 使用持久任务中经过严格校验的最小 payload 复用直接请求的下载发送函数。
async function executeQueuedVideoTask(ctx, task, deps) {
    const payload = task.payload;
    const p1Url = String(payload.p1Url || '');
    const bvId = String(payload.bvId || '');
    const traceId = String(payload.traceId || '');
    const keys = uniqueStrings(buildBiliKeys(p1Url).concat(buildBiliKeys(bvId)));
    const session = queuedVideoSessions.get(task.id);
    const trace = getQueuedVideoTrace(task);
    // 会话缺失时禁止根据持久化目标凭空重建发送能力。
    if (!session)
        return { status: 'failed', reason: 'queued_video_session_missing', notify: false };
    // 载荷无效但会话存在时保留映射，交给终态失败通知统一清理。
    if (normalizeBiliP1Url(p1Url) !== p1Url || !/^BV[0-9A-Za-z]{10}$/i.test(bvId) || !traceId || !keys.length) {
        return { status: 'failed', reason: 'invalid_video_task_payload' };
    }
    const result = await processInitialVideoRequest(ctx, session, p1Url, bvId, keys, null, deps, task.id, trace);
    if (result.kind === 'busy')
        return { status: 'retry', reason: 'resource_busy' };
    if (result.kind === 'failed')
        return { status: 'failed', reason: result.userError.message };
    if (result.kind === 'rejected') {
        queuedVideoSessions.delete(task.id);
        return { status: 'failed', reason: result.userError.message, notify: false, result: { userErrorId: result.userError.id } };
    }
    if (result.kind === 'cached' && result.entry.lastSendStatus !== 'confirmed') {
        queuedVideoSessions.delete(task.id);
        return { status: 'failed', reason: 'video_send_outcome_uncertain', notify: false };
    }
    if (result.kind === 'sent' && result.sendStatus !== 'confirmed') {
        queuedVideoSessions.delete(task.id);
        return { status: 'failed', reason: 'video_send_outcome_uncertain', notify: false };
    }
    queuedVideoSessions.delete(task.id);
    return { status: 'done', result: { traceId, bvId } };
}
// 创建并初始化唯一主进程视频队列；接口缺失时保持不可用状态且不半启用。
function getOrCreateVideoTaskQueue(ctx, deps = {}) {
    if (videoTaskQueue)
        return videoTaskQueue;
    videoTaskQueue = videoTaskQueueModule.createVideoTaskQueue({
        store: deps.taskStore,
        execute: task => executeQueuedVideoTask(ctx, task, deps),
        onTerminalFailure: (task, reason) => sendQueuedVideoFailureNotice(ctx, task, reason, deps),
        onTerminal: (task, status, reason) => recordQueuedVideoTerminal(ctx, task, status, reason),
    });
    const startup = videoTaskQueue.initialize();
    ctx.logger('bvidl').warn(`video_queue_initialized available=${startup.available} cancelled=${startup.cancelled} reason=${sanitizeResourceId(startup.reason || 'none')}`);
    return videoTaskQueue;
}
// 先持久化并全状态确认资源忙请求，再发送真实排队、队满或失败回执。
async function enqueueBusyVideoRequest(ctx, session, result, deps, trace) {
    const queue = getOrCreateVideoTaskQueue(ctx, deps);
    const target = getQueuedVideoTarget(session);
    const bvId = extractBvId(result.p1Url);
    const taskTrace = videoTraceModule.withVideoTraceTask(trace, result.taskId);
    writeVideoTrace(ctx, taskTrace, 'queue_write_started', { stage: 'video_queue_persist' });
    const queued = await queue.enqueue({
        taskId: result.taskId,
        p1Url: result.p1Url,
        bvId,
        inputType: taskTrace.inputType,
        targetType: target.targetType,
        targetId: target.targetId,
        channelKey: getVideoChannelKey(session),
        userId: getVideoUserId(session),
        requestedAt: new Date().toISOString(),
        retryCount: 0,
        traceId: taskTrace.traceId,
    });
    if (queued.status === 'queued') {
        const queuedTaskTrace = videoTraceModule.withVideoTraceTask(taskTrace, queued.task.id);
        // 任务库可能规范化提交 ID；执行、清理和日志统一使用落盘后的实际 ID。
        queuedVideoSessions.set(queued.task.id, session);
        ctx.logger('bvidl').warn(`queue_persisted taskId=${queued.task.id} traceId=${queuedTaskTrace.traceId} waiting=${queued.waiting} capacity=${queued.capacity}`);
        writeVideoTrace(ctx, queuedTaskTrace, 'queue_persisted', { waiting: queued.waiting, capacity: queued.capacity, stage: String(queued.task.status || 'pending') });
        const observedStatus = String(queued.task.status || '');
        if (observedStatus === 'pending' || observedStatus === 'deferred') {
            await safeSend(ctx, session, `视频任务已排队，当前等待 ${queued.waiting}/${queued.capacity}，任务编号：${queued.task.id}。`, 'video queued');
            queue.kick();
        }
        else if (observedStatus === 'claiming' || observedStatus === 'running') {
            await safeSend(ctx, session, `视频任务已保存并开始处理，任务编号：${queued.task.id}。`, 'video running');
        }
        else if (observedStatus === 'done') {
            queuedVideoSessions.delete(queued.task.id);
            writeVideoTrace(ctx, queuedTaskTrace, 'terminal_status', { status: 'done', reason: 'task_already_done', stage: 'video_queue_terminal' });
            await safeSend(ctx, session, `视频任务已完成，任务编号：${queued.task.id}。`, 'video already done');
        }
        else {
            queuedVideoSessions.delete(queued.task.id);
            const statusLabel = observedStatus === 'cancelled' ? '已取消' : '已失败';
            writeVideoTrace(ctx, queuedTaskTrace, 'terminal_status', { status: observedStatus === 'cancelled' ? 'cancelled' : 'failed', reason: `task_already_${observedStatus}`, stage: 'video_queue_terminal' });
            await safeSend(ctx, session, `视频任务${statusLabel}，本次不会继续执行。任务编号：${queued.task.id}。`, 'video already terminal');
        }
        return true;
    }
    if (queued.status === 'full') {
        writeVideoTrace(ctx, taskTrace, 'queue_persist_failed', { reason: 'queue_full', waiting: queued.waiting, capacity: queued.capacity });
        await safeSend(ctx, session, '视频队列已满，本次未入队，请稍后重新发送。', 'video queue full');
        return false;
    }
    const userError = buildVideoUserError({ id: queued.status === 'persist_failed' ? 'video-029' : 'video-028' });
    writeVideoTrace(ctx, taskTrace, 'queue_persist_failed', { errorId: userError.id, reason: queued.status === 'unavailable' ? queued.reason : queued.status });
    logVideoUserError(ctx, userError, queued.status === 'unavailable' ? `reason=${sanitizeResourceId(queued.reason)}` : `taskId=${queued.taskId}`);
    await safeSend(ctx, session, userError.message, 'video queue unavailable');
    return false;
}
// 把共享首次处理结果投递给等待中的其他群请求。
async function deliverSharedVideoResult(ctx, session, result, source, deps, trace) {
    if (result.kind === 'cached')
        return sendCachedVideoWithGate(ctx, session, result.entry, source, deps, trace);
    if (result.kind === 'rejected') {
        await sendRejectedVideo(ctx, session, result.infoMessage, result.userError.message);
        return undefined;
    }
    if (result.kind === 'failed')
        return result.userError.message;
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
// 根据一次直接处理结果写入成功或失败终态，busy 留给真实队列继续同一 trace。
function recordDirectVideoTerminal(ctx, trace, result, overrideError) {
    if (overrideError) {
        writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', reason: overrideError });
        return;
    }
    if (result.kind === 'cached') {
        writeVideoTrace(ctx, trace, 'terminal_status', { status: result.entry.lastSendStatus === 'confirmed' ? 'done' : 'failed', reason: `video_send_${result.entry.lastSendStatus}` });
        return;
    }
    if (result.kind === 'sent') {
        writeVideoTrace(ctx, trace, 'terminal_status', { status: result.sendStatus === 'confirmed' ? 'done' : 'failed', reason: `video_send_${result.sendStatus}` });
        return;
    }
    writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', errorId: result.userError.id, reason: result.userError.stage });
}
// 编排同群去重、短链归一化、缓存命中、并发合并和首次处理。
async function downloadAndSend(ctx, session, url, source = url, deps = {}, options = {}) {
    if (isBlacklistedGroup(session))
        return;
    const now = Date.now();
    let trace = videoTraceModule.createVideoTrace({ inputType: detectBiliInputType(url, source), videoKey: buildBiliKeys(url)[0], startedAt: now });
    writeVideoTrace(ctx, trace, 'input_detected', { stage: 'video_input' });
    const resolvedInput = await resolveInputBiliTarget(ctx, url, source, deps, trace);
    const keys = resolvedInput.keys;
    if (!resolvedInput.p1Url) {
        const shortLinkFailure = resolvedInput.shortLink?.ok === false ? resolvedInput.shortLink : null;
        const userError = buildVideoUserError({ id: shortLinkFailure ? 'video-031' : 'video-010' });
        const detail = shortLinkFailure
            ? `failureCode=${shortLinkFailure.code} hops=${shortLinkFailure.hops} statusCode=${shortLinkFailure.statusCode ?? 'none'}`
            : 'input_normalization_failed';
        writeVideoTrace(ctx, trace, 'input_rejected', { errorId: userError.id, reason: detail });
        writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', errorId: userError.id, reason: userError.stage });
        logVideoUserError(ctx, userError, detail);
        return userError.message;
    }
    trace = videoTraceModule.withVideoTraceKey(trace, keys.find(key => key.startsWith('bv:')) || keys[0] || resolvedInput.p1Url);
    writeVideoTrace(ctx, trace, 'input_normalized', { stage: 'video_input_normalized' });
    const resolvedDuplicate = findRecentDuplicateParse(session, keys, now);
    const cached = findVideoFileCache(ctx, keys, now);
    const canRetryUncertainCache = !!(options.explicitCommand && resolvedDuplicate && cached?.lastSendStatus === 'uncertain');
    if (resolvedDuplicate && !canRetryUncertainCache) {
        const userError = buildVideoUserError({ id: 'video-002', remainingSeconds: resolvedDuplicate.remainingSeconds });
        logVideoUserError(ctx, userError, `remaining_seconds=${resolvedDuplicate.remainingSeconds}`);
        await safeSend(ctx, session, userError.message, 'duplicate parse notice');
        writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', errorId: userError.id, reason: userError.stage });
        return undefined;
    }
    const recentEntry = canRetryUncertainCache ? null : rememberRecentParse(session, keys, now);
    if (cached) {
        const result = await sendCachedVideoWithGate(ctx, session, cached, source, deps, trace);
        if (result)
            forgetRecentParse(session, recentEntry);
        writeVideoTrace(ctx, trace, 'terminal_status', { status: result ? 'failed' : 'done', reason: result ? 'cached_send_failed' : 'cached_send_complete' });
        return result;
    }
    const inflight = findInflightDownload(keys);
    if (inflight) {
        const result = await inflight;
        if (result.kind === 'busy') {
            const queued = await enqueueBusyVideoRequest(ctx, session, { ...result, taskId: buildVideoTaskId(session, source) }, deps, trace);
            if (!queued)
                forgetRecentParse(session, recentEntry);
            if (!queued)
                writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', reason: 'queue_not_persisted' });
            return undefined;
        }
        const delivered = await deliverSharedVideoResult(ctx, session, result, source, deps, trace);
        if (result.kind === 'failed' || delivered)
            forgetRecentParse(session, recentEntry);
        recordDirectVideoTerminal(ctx, trace, result, delivered ? 'shared_result_delivery_failed' : undefined);
        return delivered;
    }
    let work;
    work = processInitialVideoRequest(ctx, session, resolvedInput.p1Url, source, keys, recentEntry, deps, '', trace);
    const registeredKeys = registerInflightDownload(keys, work);
    try {
        const result = await work;
        if (result.kind === 'failed') {
            forgetRecentParse(session, recentEntry);
            recordDirectVideoTerminal(ctx, trace, result);
            return result.userError.message;
        }
        if (result.kind === 'busy') {
            const queued = await enqueueBusyVideoRequest(ctx, session, result, deps, trace);
            if (!queued)
                forgetRecentParse(session, recentEntry);
            if (!queued)
                writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', reason: 'queue_not_persisted' });
            return undefined;
        }
        recordDirectVideoTerminal(ctx, trace, result);
        return undefined;
    }
    finally {
        unregisterInflightDownload(registeredKeys, work);
    }
}
// 处理独立 B 站视频输入；不匹配时继续消息链，命中时复用统一下载与准入流程。
async function handleStandaloneBilibiliVideoInput(ctx, session, next, deps = {}) {
    if (isBlacklistedGroup(session))
        return next();
    const content = session.content || '';
    const url = extractBiliUrl(content);
    if (!url) {
        if (!isBilibiliCardInput(content))
            return next();
        const trace = videoTraceModule.createVideoTrace({ inputType: 'qq_card' });
        writeVideoTrace(ctx, trace, 'input_detected', { stage: 'qq_card' });
        const userError = buildVideoUserError({ id: 'video-010' });
        writeVideoTrace(ctx, trace, 'input_rejected', { errorId: userError.id, reason: 'recognized_bilibili_card_without_video_url' });
        writeVideoTrace(ctx, trace, 'terminal_status', { status: 'failed', errorId: userError.id, reason: userError.stage });
        logVideoUserError(ctx, userError, 'recognized_bilibili_card_without_video_url');
        return userError.message;
    }
    if (!isStandaloneBilibiliVideoInput(content))
        return next();
    return downloadAndSend(ctx, session, url, content, deps);
}
function apply(ctx) {
    logBiliCookieHealth(ctx, 'startup');
    cleanupInterruptedVideoStagingDirectories(ctx);
    startVideoCacheMaintenance(ctx);
    getOrCreateVideoTaskQueue(ctx);
    ctx.on?.('dispose', () => {
        videoTaskQueue?.dispose();
        videoTaskQueue = null;
        queuedVideoSessions.clear();
        videoTraceModule.clearVideoTraceState();
    });
    ctx.command('sendtestvideo', 'send local test video').action(() => {
        return segment.video(toFileUrl(TEST_VIDEO_FILE));
    });
    ctx.command('bvidl <text:text>', 'download and send Bilibili video').action(async ({ session }, text) => {
        if (isBlacklistedGroup(session))
            return;
        const url = extractBiliUrl(text);
        if (!url)
            return buildVideoUserError({ id: 'video-001' }).message;
        return downloadAndSend(ctx, session, url, text || url, {}, { explicitCommand: true });
    });
    ctx.middleware((session, next) => handleStandaloneBilibiliVideoInput(ctx, session, next), true);
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
    videoTaskQueue?.dispose();
    videoTaskQueue = null;
    queuedVideoSessions.clear();
    recentParseHistory.clear();
    biliInput.clearBiliInputCache();
    clearBiliCookieHealthCache();
    videoTraceModule.clearVideoTraceState();
    clearVideoAdminAlertState();
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
    isBilibiliCardInput,
    isStandaloneBilibiliVideoInput,
    handleStandaloneBilibiliVideoInput,
    buildBiliKeys,
    pickFormat,
    getShortestBiliUrl,
    downloadAndSend,
    formatDecimalMb,
    buildOversizeMessage,
    buildActualOversizeMessage,
    buildVideoUserError,
    getRuntimeConfig,
    toFileUrl,
    safeSend,
    isBlacklistedGroup,
    loadVideoBlacklist,
    isRecentDuplicateParse,
    rememberRecentParse,
    clearRecentParseHistory,
    resolveBiliShortLink,
    normalizeBiliP1Url,
    probeVideo,
    isAllowedBiliRedirectUrl,
    isPrivateIpAddress,
    cleanupVideoCache,
    removeRequestStagingDirectory,
    getResourceGateStorageFailure,
    reportResourceGateStorageFailure,
    flushGateAdminAlertWindow,
    getVideoCacheStatus,
    clearVideoRuntimeState,
};
