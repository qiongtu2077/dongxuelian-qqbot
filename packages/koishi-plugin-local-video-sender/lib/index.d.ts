import type { ExecFileOptions } from 'child_process';
declare const fs: any;
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
    middleware(handler: (session: VideoSessionLike, next: () => unknown) => unknown): unknown;
    logger(name: string): LoggerLike;
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
    send(message: unknown): Promise<unknown>;
}
interface RuntimeConfig {
    ytdlp: string;
    cookies: string;
    workdir: string;
    maxSize: number;
    testVideoFile: string;
    videoBlacklistFile: string;
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
    error?: string;
}
interface DownloadDeps {
    fs?: typeof fs;
    run?: typeof run;
    probeVideo?: typeof probeVideo;
    resourceGate?: false;
}
interface RecentParseEntry {
    timestamp: number;
    keys: string[];
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
declare function loadVideoBlacklist(force?: boolean): VideoBlacklistCache;
declare function isBlacklistedGroup(session: VideoSessionLike): boolean;
declare function isRecentDuplicateParse(session: VideoSessionLike, keys: string[], now?: number): boolean;
declare function rememberRecentParse(session: VideoSessionLike, keys: string[], now?: number): RecentParseEntry | null;
declare function getShortestBiliUrl(info?: VideoInfo): string;
declare function pickFormat(info: VideoInfo): FormatPick | null;
declare function safeSend(ctx: ContextLike, session: VideoSessionLike, message: unknown, label?: string): Promise<boolean>;
declare function probeVideo(url: string): Promise<ProbeResult>;
declare function downloadAndSend(ctx: ContextLike, session: VideoSessionLike, url: string, source?: string, deps?: DownloadDeps): Promise<string | undefined>;
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
    extractBiliUrl: typeof extractBiliUrl;
    buildBiliKeys: typeof buildBiliKeys;
    pickFormat: typeof pickFormat;
    getShortestBiliUrl: typeof getShortestBiliUrl;
    downloadAndSend: typeof downloadAndSend;
    getRuntimeConfig: typeof getRuntimeConfig;
    toFileUrl: typeof toFileUrl;
    safeSend: typeof safeSend;
    isBlacklistedGroup: typeof isBlacklistedGroup;
    loadVideoBlacklist: typeof loadVideoBlacklist;
    isRecentDuplicateParse: typeof isRecentDuplicateParse;
    rememberRecentParse: typeof rememberRecentParse;
    clearRecentParseHistory: () => void;
};
export = _default;
