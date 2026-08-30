interface MediaTaskInput {
    kind: 'media_image_analysis' | 'media_file_analysis' | 'media_voice_transcription' | string;
    channelKey: string;
    messageId: string;
    url?: string;
    fileId?: string | null;
    priority?: number;
    ttlMs?: number;
    payload?: Record<string, unknown>;
}
interface MediaTask {
    id: string;
    kind: string;
    channelKey: string;
    messageId: string;
    urlHash: string;
    url: string;
    fileId: string | null;
    createdAt: string;
    expiresAt: string;
    priority: number;
    status: string;
    payload: Record<string, unknown>;
    claimedBy?: string;
    claimedAt?: string;
    updatedAt?: string;
    finishedAt?: string;
    deferredReason?: string;
    deferredUntil?: string;
    notBefore?: string;
    error?: string;
    result?: Record<string, unknown>;
}
type EnqueueMediaTaskResult = MediaTask | {
    reused: true;
    cache: unknown;
    urlHash: string;
} | {
    reused: false;
    existing: MediaTask;
    urlHash: string;
};
interface MediaRetentionResult {
    enabled: boolean;
    archivedDone: number;
    archivedDropped: number;
    deletedArchiveDirs: number;
    backupPath: string;
}
declare function ensureMediaDirs(): void;
declare function writeMediaEvent(event: string, data?: Record<string, unknown>): void;
declare function parseMediaTask(value: unknown): MediaTask | null;
declare function createMediaHash(input: MediaTaskInput): string;
declare function readCacheIndex(): Record<string, unknown>;
declare function writeCacheIndex(index: Record<string, unknown>): void;
declare function cleanupExpiredMediaTasks(kind?: string): number;
declare function cleanupExpiredMediaTasksThrottled(kind?: string, now?: number): number;
declare function cleanupFinishedMediaTasks(now?: number): MediaRetentionResult;
declare function cleanupFinishedMediaTasksThrottled(now?: number): MediaRetentionResult;
declare function isMediaTaskDeferred(task: MediaTask | null | undefined, now?: number): boolean;
declare function listPendingMediaTasks(kind?: string, limit?: number): MediaTask[];
declare function claimNextMediaTask(workerName?: string, kind?: string): MediaTask | null;
declare function requeueMediaTask(task: MediaTask, reason?: string, delayMs?: number): MediaTask;
declare function completeMediaTask(task: MediaTask, result?: Record<string, unknown>): MediaTask;
declare function failMediaTask(task: MediaTask, error: unknown, reason?: string): MediaTask;
interface DiscardInterruptedMediaTasksResult {
    discarded: number;
    invalidFilesRemoved: number;
    failed: number;
}
declare function discardInterruptedMediaTasks(reason?: string): DiscardInterruptedMediaTasksResult;
declare function enqueueMediaTask(input: MediaTaskInput): EnqueueMediaTaskResult;
declare function getMediaBackpressureStatus(): Record<string, unknown>;
declare const _default: {
    MEDIA_ROOT: string;
    MEDIA_QUEUE_ROOT: string;
    MEDIA_CACHE_INDEX_FILE: string;
    MEDIA_ARCHIVE_ROOT: string;
    MEDIA_RETENTION_CONTROL_FILE: string;
    ensureMediaDirs: typeof ensureMediaDirs;
    writeMediaEvent: typeof writeMediaEvent;
    createMediaHash: typeof createMediaHash;
    readCacheIndex: typeof readCacheIndex;
    writeCacheIndex: typeof writeCacheIndex;
    cleanupExpiredMediaTasks: typeof cleanupExpiredMediaTasks;
    cleanupExpiredMediaTasksThrottled: typeof cleanupExpiredMediaTasksThrottled;
    cleanupFinishedMediaTasks: typeof cleanupFinishedMediaTasks;
    cleanupFinishedMediaTasksThrottled: typeof cleanupFinishedMediaTasksThrottled;
    enqueueMediaTask: typeof enqueueMediaTask;
    listPendingMediaTasks: typeof listPendingMediaTasks;
    claimNextMediaTask: typeof claimNextMediaTask;
    requeueMediaTask: typeof requeueMediaTask;
    completeMediaTask: typeof completeMediaTask;
    failMediaTask: typeof failMediaTask;
    discardInterruptedMediaTasks: typeof discardInterruptedMediaTasks;
    getMediaBackpressureStatus: typeof getMediaBackpressureStatus;
    isMediaTaskDeferred: typeof isMediaTaskDeferred;
    _test: {
        parseMediaTask: typeof parseMediaTask;
    };
};
export = _default;
