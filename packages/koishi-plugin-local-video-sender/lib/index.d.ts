import type { ExecFileOptions } from 'child_process';
declare const fs: typeof import("fs/promises");
interface LoggerLike {
    warn(...args: unknown[]): void;
}
interface CommandLike {
    action(handler: (argv: {
        session: VideoSessionLike;
    }, text?: string) => unknown): CommandLike;
}
interface ContextLike {
    command(name: string, desc: string): CommandLike;
    middleware(handler: (session: VideoSessionLike, next: () => unknown) => unknown, prepend?: boolean): unknown;
    logger(name: string): LoggerLike;
    on?(event: 'dispose', handler: () => unknown): unknown;
}
interface VideoSessionLike {
    userId?: string | number;
    guildId?: string | number;
    channelId?: string | number;
    isDirect?: boolean;
    content?: string;
    author?: {
        id?: string | number;
    };
    event?: {
        user?: {
            id?: string | number;
        };
        sender?: {
            userId?: string | number;
            id?: string | number;
        };
    };
    bot?: {
        internal?: {
            sendPrivateMsg?: (userId: string, message: unknown) => Promise<unknown> | unknown;
        };
    };
    send(message: unknown): Promise<unknown>;
}
interface RuntimeConfig {
    ytdlp: string;
    cookies: string;
    workdir: string;
    maxSize: number;
    testVideoFile: string;
    videoBlacklistFile: string;
    videoMinMemMb: number;
}
interface VideoFormat {
    format_id?: string | number;
    format_note?: string;
    ext?: string;
    filesize?: number;
    filesize_approx?: number;
    height?: number;
    fps?: number;
    abr?: number;
    vcodec?: string;
    acodec?: string;
    url?: string;
}
interface VideoInfo {
    title?: string;
    thumbnail?: string;
    webpage_url?: string;
    original_url?: string;
    url?: string;
    id?: string;
    display_id?: string;
    duration?: number;
    formats?: VideoFormat[];
}
interface FormatPick {
    format: string;
    label: string;
    totalSize: number;
    height: number;
}
interface RunResult {
    stdout: string;
    stderr: string;
}
interface ProbeResult {
    info?: VideoInfo;
    picked?: FormatPick;
    userError?: VideoUserError;
}
type VideoFsApi = Pick<typeof fs, 'mkdir' | 'stat' | 'rm'>;
type StagingFsApi = Pick<typeof fs, 'lstat' | 'realpath' | 'rm' | 'stat' | 'readFile'>;
type VideoUserErrorNumber = '001' | '002' | '003' | '004' | '005' | '006' | '007' | '008' | '009' | '010' | '011' | '012' | '013' | '014' | '015' | '016' | '017' | '018' | '019' | '020' | '021' | '022' | '023' | '024' | '025' | '026' | '027';
type VideoUserErrorId = `video-${VideoUserErrorNumber}`;
interface VideoUserError {
    id: VideoUserErrorId;
    message: string;
    stage: string;
}
type StaticVideoUserErrorId = 'video-001' | 'video-003' | 'video-006' | 'video-007' | 'video-008' | 'video-009' | 'video-010' | 'video-013' | 'video-014' | 'video-016' | 'video-017' | 'video-018' | 'video-019' | 'video-020' | 'video-023' | 'video-025' | 'video-027';
type VideoUserErrorInput = {
    id: StaticVideoUserErrorId;
} | {
    id: 'video-002';
    remainingSeconds: number;
} | {
    id: 'video-004';
    resourceState: string;
    availableMemoryMb: number;
    minimumMemoryMb: number;
    decision: string;
} | {
    id: 'video-005';
    resourceState: string;
    minimumMemoryMb: number;
    decision: string;
} | {
    id: 'video-011';
    bvId: string;
    partNumber: number;
} | {
    id: 'video-012' | 'video-022' | 'video-024' | 'video-026';
    retcode: number;
} | {
    id: 'video-015';
    estimatedBytes: number;
} | {
    id: 'video-021';
    actualBytes: number;
};
type SendOutcome = {
    status: 'confirmed';
} | {
    status: 'uncertain';
    reason: 'timeout';
    error: string;
} | {
    status: 'failed';
    reason: 'rejected';
    retcode: number;
    error: string;
} | {
    status: 'failed';
    reason: 'call_error';
    error: string;
};
type StagingPrepareResult = {
    status: 'ready';
    path: string;
} | {
    status: 'create_failed';
    path: string;
    error: unknown;
} | {
    status: 'safety_validation_failed';
    path: string;
};
interface StagingCleanupOptions {
    fs?: StagingFsApi;
    adminIdsFile?: string;
    now?: number;
}
interface DownloadDeps {
    fs?: VideoFsApi;
    run?: typeof run;
    probeVideo?: typeof probeVideo;
    createStagingDirectory?: typeof createRequestStagingDirectory;
    removeStagingDirectory?: typeof removeRequestStagingDirectory;
    resolveShortLink?: typeof resolveBiliShortLink;
    resourceModules?: VideoResourceModules | null;
    resourceGate?: false;
}
interface DownloadRequestOptions {
    explicitCommand?: boolean;
}
type VideoAdmissionModule = typeof import('../../koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission');
type VideoResourceGateModule = typeof import('../../koishi-plugin-dongxuelian-ai/lib/resource-gate/gate');
interface VideoResourceModules {
    admitTask: VideoAdmissionModule['admitTask'];
    acquireResourceGate: VideoResourceGateModule['acquireResourceGate'];
}
interface RecentParseEntry {
    timestamp: number;
    keys: string[];
}
interface RedirectResponse {
    statusCode: number;
    location: string;
}
interface VideoBlacklistCache {
    fingerprint: string;
    groups: Set<string>;
    users: Set<string>;
}
declare function toFileUrl(filePath: string): string;
declare function getRuntimeConfig(): RuntimeConfig;
declare function run(file: string, args: string[], options?: ExecFileOptions): Promise<RunResult>;
declare function extractBiliUrl(input?: string): string | null;
declare function buildBiliKeys(input?: string): string[];
declare function normalizeBiliP1Url(input?: string): string;
declare function buildVideoUserError(input: VideoUserErrorInput): VideoUserError;
declare function isAllowedBiliRedirectUrl(input: string): boolean;
declare function isPrivateIpAddress(address: string): boolean;
declare function requestRedirectLocation(input: string, timeoutMs: number): Promise<RedirectResponse>;
declare function resolveBiliShortLink(input: string, requestRedirect?: typeof requestRedirectLocation): Promise<string>;
declare function loadVideoBlacklist(force?: boolean): VideoBlacklistCache;
declare function isBlacklistedGroup(session: VideoSessionLike): boolean;
declare function isRecentDuplicateParse(session: VideoSessionLike, keys: string[], now?: number): boolean;
declare function rememberRecentParse(session: VideoSessionLike, keys: string[], now?: number): RecentParseEntry | null;
declare function formatDecimalMb(bytes: number): string;
declare function buildOversizeMessage(bytes: number): string;
declare function buildActualOversizeMessage(bytes: number): string;
declare function createRequestStagingDirectory(cacheSlug: string): Promise<StagingPrepareResult>;
declare function removeRequestStagingDirectory(ctx: ContextLike | null, session: VideoSessionLike, stagingDir: string, bvId: string, taskId: string, options?: StagingCleanupOptions): Promise<boolean>;
declare function isStandaloneBilibiliVideoInput(input?: string): boolean;
declare function cleanupVideoCache(ctx: ContextLike | null, now?: number): Promise<{
    entriesRemoved: number;
    filesRemoved: number;
    staleActive: number;
}>;
declare function getVideoCacheStatus(): Record<string, unknown>;
declare function getShortestBiliUrl(info?: VideoInfo): string;
declare function pickFormat(info: VideoInfo): FormatPick | null;
declare function safeSend(ctx: ContextLike, session: VideoSessionLike, message: unknown, label?: string): Promise<SendOutcome>;
declare function probeVideo(url: string, runCommand?: typeof run): Promise<ProbeResult>;
declare function downloadAndSend(ctx: ContextLike, session: VideoSessionLike, url: string, source?: string, deps?: DownloadDeps, options?: DownloadRequestOptions): Promise<string | undefined>;
declare function handleStandaloneBilibiliVideoInput(ctx: ContextLike, session: VideoSessionLike, next: () => unknown, deps?: DownloadDeps): Promise<unknown>;
declare function apply(ctx: ContextLike): void;
declare function clearVideoRuntimeState(): Promise<void>;
declare const _default: {
    name: string;
    apply: typeof apply;
    extractBiliUrl: typeof extractBiliUrl;
    isStandaloneBilibiliVideoInput: typeof isStandaloneBilibiliVideoInput;
    handleStandaloneBilibiliVideoInput: typeof handleStandaloneBilibiliVideoInput;
    buildBiliKeys: typeof buildBiliKeys;
    pickFormat: typeof pickFormat;
    getShortestBiliUrl: typeof getShortestBiliUrl;
    downloadAndSend: typeof downloadAndSend;
    formatDecimalMb: typeof formatDecimalMb;
    buildOversizeMessage: typeof buildOversizeMessage;
    buildActualOversizeMessage: typeof buildActualOversizeMessage;
    buildVideoUserError: typeof buildVideoUserError;
    getRuntimeConfig: typeof getRuntimeConfig;
    toFileUrl: typeof toFileUrl;
    safeSend: typeof safeSend;
    isBlacklistedGroup: typeof isBlacklistedGroup;
    loadVideoBlacklist: typeof loadVideoBlacklist;
    isRecentDuplicateParse: typeof isRecentDuplicateParse;
    rememberRecentParse: typeof rememberRecentParse;
    clearRecentParseHistory: () => void;
    resolveBiliShortLink: typeof resolveBiliShortLink;
    normalizeBiliP1Url: typeof normalizeBiliP1Url;
    probeVideo: typeof probeVideo;
    isAllowedBiliRedirectUrl: typeof isAllowedBiliRedirectUrl;
    isPrivateIpAddress: typeof isPrivateIpAddress;
    cleanupVideoCache: typeof cleanupVideoCache;
    removeRequestStagingDirectory: typeof removeRequestStagingDirectory;
    getVideoCacheStatus: typeof getVideoCacheStatus;
    clearVideoRuntimeState: typeof clearVideoRuntimeState;
};
export = _default;
