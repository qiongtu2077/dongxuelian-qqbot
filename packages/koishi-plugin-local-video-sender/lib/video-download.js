"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGING_DIR_RE = exports.CACHE_FILE_RE = void 0;
exports.runVideoCommand = runVideoCommand;
exports.getErrorMessage = getErrorMessage;
exports.getNodeErrorCode = getNodeErrorCode;
exports.getCommandErrorMessage = getCommandErrorMessage;
exports.getSafeCommandErrorSummary = getSafeCommandErrorSummary;
exports.prepareVideoDirectories = prepareVideoDirectories;
exports.isSafeVideoCacheFile = isSafeVideoCacheFile;
exports.createRequestStagingDirectory = createRequestStagingDirectory;
exports.removeVideoStagingDirectory = removeVideoStagingDirectory;
exports.createVideoDownload = createVideoDownload;
/**
 * 负责单次视频下载的文件生命周期：暂存、执行下载器、校验、移交和回收。
 * 调用方负责资源闸门、会话发送以及缓存登记。
 */
const node_child_process_1 = require("node:child_process");
const fsSync = __importStar(require("node:fs"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
exports.CACHE_FILE_RE = /^bili-cache-[A-Za-z0-9]+-\d+-[a-z0-9]+\.mp4$/;
exports.STAGING_DIR_RE = /^bili-job-[a-z0-9]+-\d+-[a-z0-9]+$/;
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024;
// --- 下载程序与诊断 --- #
// 运行同一个有界下载程序，保留退出码、信号和标准输出供诊断。
function runVideoCommand(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(file, args, { maxBuffer: MAX_YTDLP_STDIO_BYTES, ...options }, (error, stdout, stderr) => {
            if (error) {
                reject(Object.assign(error, { stdout, stderr }));
            }
            else {
                resolve({ stdout, stderr });
            }
        });
    });
}
// 提取错误文本，也接受下载依赖抛出的非 Error 值。
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// 读取非空系统错误码；缺少错误码时返回固定占位值。
function getNodeErrorCode(error, fallback = 'UNKNOWN') {
    const code = error && typeof error === 'object' ? error.code : '';
    return typeof code === 'string' && code.trim() ? code.trim() : fallback;
}
// 下载器报错优先取标准错误文本。
function getCommandErrorMessage(error) {
    if (error && typeof error === 'object') {
        const commandError = error;
        return String(commandError.stderr || commandError.message || error);
    }
    return String(error);
}
// 生成有界错误摘要，替换完整媒体 URL 和 Cookie 文件路径。
function getSafeCommandErrorSummary(error, cookies) {
    return getCommandErrorMessage(error)
        .replace(/https?:\/\/\S+/gi, '[url]')
        .split(cookies).join('[cookies-file]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000) || 'unknown';
}
// --- 运行目录与安全路径 --- #
// 逐个准备运行目录，保留第一个失败的阶段编号。
async function prepareVideoDirectories(workdir, cacheDir, stagingRoot, fsApi) {
    for (const [directory, id] of [[workdir, 'video-007'], [cacheDir, 'video-008'], [stagingRoot, 'video-009']]) {
        try {
            await fsApi.mkdir(directory, { recursive: true });
        }
        catch (error) {
            return { id, error };
        }
    }
    return null;
}
// 检查缓存文件的名称、类型及真实位置都满足原缓存边界。
function isSafeVideoCacheFile(cacheDir, filePath) {
    try {
        const cacheRoot = path.resolve(cacheDir);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(`${cacheRoot}${path.sep}`) || !exports.CACHE_FILE_RE.test(path.basename(resolved)))
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
// 校验暂存目录的名称、类型和真实边界，并保留读取失败的准确阶段。
async function validateStagingDirectory(stagingRoot, stagingDir, fsApi) {
    const resolved = path.resolve(stagingDir);
    if (path.dirname(resolved) !== path.resolve(stagingRoot) || !exports.STAGING_DIR_RE.test(path.basename(resolved))) {
        return { status: 'rejected', error: '暂存目录不是暂存根目录下命名合规的直接子目录' };
    }
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
        realRoot = await fsApi.realpath(stagingRoot);
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
// 为首次下载建立权限受限的独立暂存目录，并记录可交给回收的路径。
async function createRequestStagingDirectory(stagingRoot, cacheSlug) {
    const stagingName = `bili-job-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingDir = path.join(stagingRoot, stagingName);
    try {
        await fs.mkdir(stagingDir, { mode: 0o700 });
    }
    catch (error) {
        return { status: 'create_failed', path: stagingDir, error };
    }
    if ((await validateStagingDirectory(stagingRoot, stagingDir, fs)).status !== 'safe') {
        return { status: 'safety_validation_failed', path: stagingDir };
    }
    return { status: 'ready', path: stagingDir };
}
// 仅删除校验通过的本任务目录，返回上层告警需要的故障详情。
async function removeVideoStagingDirectory(stagingRoot, stagingDir, fsApi) {
    const validation = await validateStagingDirectory(stagingRoot, stagingDir, fsApi);
    if (validation.status === 'missing')
        return { ok: true };
    if (validation.status === 'rejected')
        return { ok: false, event: 'staging_cleanup_rejected', errorCode: 'SAFETY_VALIDATION_FAILED', error: validation.error };
    if (validation.status === 'failed')
        return { ok: false, event: 'staging_cleanup_failed', errorCode: validation.code, error: validation.error };
    try {
        await fsApi.rm(stagingDir, { recursive: true, force: true });
        return { ok: true };
    }
    catch (error) {
        const errorCode = getNodeErrorCode(error);
        if (errorCode === 'ENOENT')
            return { ok: true };
        return { ok: false, event: 'staging_cleanup_failed', errorCode, error: getErrorMessage(error) };
    }
}
// 持有暂存目录与最终文件，直到发送结束后成功移交缓存或完成回收。
function createVideoDownload(request, deps) {
    const { ytdlp, cookies, cacheDir, maxSize, url, format, bvId, bvKey } = request;
    const cacheSlug = (bvKey.replace(/^bv:/, '') || 'unknown').replace(/[^a-z0-9]/g, '').slice(0, 32) || 'unknown';
    // QQ 转发会保留文件名，使用保留大小写的真实 BV 而非小写缓存键。
    const cacheId = `bili-cache-${bvId || cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.join(cacheDir, `${cacheId}.mp4`);
    let ownsOutput = true;
    let stagingDir = '';
    let downloadStartedAt = 0;
    let commandFailure = null;
    // 只尝试删除本请求的最终文件一次，失败保留原诊断。
    async function discardOutput(reason) {
        if (!ownsOutput)
            return;
        ownsOutput = false;
        try {
            await deps.fs.rm(filePath, { force: true });
        }
        catch (error) {
            deps.warn(`video output delete failed: reason=${reason} error=${getErrorMessage(error)}`);
        }
    }
    // 只在调用方登记缓存成功后移交最终文件的清理责任。
    function transferToCache() {
        ownsOutput = false;
    }
    // 记录原来的阶段错误编号和技术细节，再交给会话层生成用户反馈。
    function fail(errorId, detail) {
        deps.logFailure(errorId, detail);
        return { kind: 'failed', errorId };
    }
    // 准备暂存、执行下载并校验实际产物；超限文件须在发送提示前删除。
    async function prepareOutput() {
        let staging;
        try {
            staging = await deps.createStagingDirectory(cacheSlug);
        }
        catch (error) {
            staging = { status: 'create_failed', path: '', error };
        }
        stagingDir = staging.path;
        if (staging.status !== 'ready') {
            const id = staging.status === 'create_failed' ? 'video-016' : 'video-017';
            const detail = staging.status === 'create_failed' ? getErrorMessage(staging.error) : 'safety_validation_failed';
            deps.warn(`staging_prepare_failed: bv=${bvKey || 'unknown'} reason=${staging.status} user_error_id=${id} error=${detail}`);
            return fail(id);
        }
        const health = deps.beforeDownload();
        if (!health.ok)
            return fail('video-030', `code=${health.code}`);
        downloadStartedAt = Date.now();
        deps.trace('download_started', { stage: 'video_download' });
        try {
            await deps.run(ytdlp, [
                '--cookies', cookies,
                '--no-playlist',
                '-f', format,
                '--merge-output-format', 'mp4',
                '-P', `home:${cacheDir}`,
                '-P', `temp:${stagingDir}`,
                '-o', `${cacheId}.%(ext)s`,
                url,
            ], { timeout: 10 * 60 * 1000 });
            deps.trace('download_finished', { stage: 'video_download', durationMs: Date.now() - downloadStartedAt, ok: true });
        }
        catch (error) {
            commandFailure = error instanceof Error ? error : new Error(String(error));
            const detail = getSafeCommandErrorSummary(commandFailure, cookies);
            deps.trace('download_finished', { stage: 'video_download', durationMs: Date.now() - downloadStartedAt, ok: false, errorId: 'video-018', reason: detail });
            return fail('video-018', detail);
        }
        if (!isSafeVideoCacheFile(cacheDir, filePath))
            return fail('video-019');
        let actualSize;
        try {
            actualSize = (await deps.fs.stat(filePath)).size;
        }
        catch (error) {
            return fail('video-020', getErrorMessage(error));
        }
        if (actualSize > maxSize) {
            await discardOutput('actual_size_limit');
            return { kind: 'oversize', actualSize };
        }
        return { kind: 'ready', filePath, actualSize };
    }
    // 先回收未移交产物，再删暂存目录，然后记录带清理结果的下载故障。
    async function cleanup() {
        if (ownsOutput)
            await discardOutput('request_finally');
        const directory = stagingDir;
        stagingDir = '';
        const cleanupOk = directory ? await deps.removeStagingDirectory(directory) : true;
        if (commandFailure) {
            deps.warn(`video_download_failed: cacheId=${cacheId} bv=${bvKey || 'unknown'} format=${format || 'unknown'} duration_ms=${downloadStartedAt ? Date.now() - downloadStartedAt : 0} exit_code=${commandFailure.code ?? 'unknown'} signal=${commandFailure.signal || 'none'} cleanup_ok=${cleanupOk} user_error_id=video-018 error=${getSafeCommandErrorSummary(commandFailure, cookies)}`);
            commandFailure = null;
        }
    }
    return { prepareOutput, discardOutput, transferToCache, cleanup };
}
