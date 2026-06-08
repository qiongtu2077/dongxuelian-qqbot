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
interface MediaTask extends Record<string, unknown> {
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
declare function ensureMediaDirs(): void;
declare function writeMediaEvent(event: string, data?: Record<string, unknown>): void;
declare function createMediaHash(input: MediaTaskInput): string;
declare function readCacheIndex(): Record<string, unknown>;
declare function writeCacheIndex(index: Record<string, unknown>): void;
declare function cleanupExpiredMediaTasks(): number;
declare function listPendingMediaTasks(kind?: string, limit?: number): MediaTask[];
declare function claimNextMediaTask(workerName?: string, kind?: string): MediaTask | null;
declare function requeueMediaTask(task: MediaTask, reason?: string): MediaTask;
declare function completeMediaTask(task: MediaTask, result?: Record<string, unknown>): MediaTask;
declare function failMediaTask(task: MediaTask, error: unknown, reason?: string): MediaTask;
declare function enqueueMediaTask(input: MediaTaskInput): EnqueueMediaTaskResult;
declare function getMediaBackpressureStatus(): Record<string, unknown>;
declare const _default: {
    MEDIA_ROOT: string;
    MEDIA_QUEUE_ROOT: string;
    MEDIA_CACHE_INDEX_FILE: string;
    ensureMediaDirs: typeof ensureMediaDirs;
    writeMediaEvent: typeof writeMediaEvent;
    createMediaHash: typeof createMediaHash;
    readCacheIndex: typeof readCacheIndex;
    writeCacheIndex: typeof writeCacheIndex;
    cleanupExpiredMediaTasks: typeof cleanupExpiredMediaTasks;
    enqueueMediaTask: typeof enqueueMediaTask;
    listPendingMediaTasks: typeof listPendingMediaTasks;
    claimNextMediaTask: typeof claimNextMediaTask;
    requeueMediaTask: typeof requeueMediaTask;
    completeMediaTask: typeof completeMediaTask;
    failMediaTask: typeof failMediaTask;
    getMediaBackpressureStatus: typeof getMediaBackpressureStatus;
};
export = _default;
