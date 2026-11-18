import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import * as fs from 'node:fs/promises';
import type { VideoTraceFields } from './video-trace';
export declare const CACHE_FILE_RE: RegExp;
export declare const STAGING_DIR_RE: RegExp;
export type VideoFsApi = Pick<typeof fs, 'mkdir' | 'stat' | 'rm'>;
export type StagingFsApi = Pick<typeof fs, 'lstat' | 'realpath' | 'rm' | 'stat' | 'readFile'>;
export type StagingPrepareResult = {
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
type StagingRemoval = {
    ok: true;
} | {
    ok: false;
    event: 'staging_cleanup_failed' | 'staging_cleanup_rejected';
    errorCode: string;
    error: string;
};
export declare function runVideoCommand(file: string, args: string[], options?: ExecFileOptionsWithStringEncoding): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function getErrorMessage(error: unknown): string;
export declare function getNodeErrorCode(error: unknown, fallback?: string): string;
export declare function getCommandErrorMessage(error: unknown): string;
export declare function getSafeCommandErrorSummary(error: unknown, cookies: string): string;
export declare function prepareVideoDirectories(workdir: string, cacheDir: string, stagingRoot: string, fsApi: VideoFsApi): Promise<{
    id: "video-007" | "video-008" | "video-009";
    error: unknown;
} | null>;
export declare function isSafeVideoCacheFile(cacheDir: string, filePath: string): boolean;
export declare function createRequestStagingDirectory(stagingRoot: string, cacheSlug: string): Promise<StagingPrepareResult>;
export declare function removeVideoStagingDirectory(stagingRoot: string, stagingDir: string, fsApi: StagingFsApi): Promise<StagingRemoval>;
interface VideoDownloadRequest {
    ytdlp: string;
    cookies: string;
    cacheDir: string;
    maxSize: number;
    url: string;
    format: string;
    bvId: string;
    bvKey: string;
}
type DownloadFailureId = 'video-016' | 'video-017' | 'video-018' | 'video-019' | 'video-020' | 'video-030';
type VideoDownloadResult = {
    kind: 'ready';
    filePath: string;
    actualSize: number;
} | {
    kind: 'oversize';
    actualSize: number;
} | {
    kind: 'failed';
    errorId: DownloadFailureId;
};
interface VideoDownloadDeps {
    fs: VideoFsApi;
    run: typeof runVideoCommand;
    createStagingDirectory(cacheSlug: string): Promise<StagingPrepareResult>;
    removeStagingDirectory(directory: string): Promise<boolean>;
    beforeDownload(): {
        ok: boolean;
        code: string;
    };
    trace(event: 'download_started' | 'download_finished', fields: VideoTraceFields): void;
    warn(message: string): void;
    logFailure(id: DownloadFailureId, detail?: string): void;
}
export declare function createVideoDownload(request: VideoDownloadRequest, deps: VideoDownloadDeps): {
    prepareOutput: () => Promise<VideoDownloadResult>;
    discardOutput: (reason: string) => Promise<void>;
    transferToCache: () => void;
    cleanup: () => Promise<void>;
};
export {};
