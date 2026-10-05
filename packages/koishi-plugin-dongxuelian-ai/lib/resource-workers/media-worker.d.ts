interface MediaWorkerOptions {
    workerName?: string;
    gateWaitMs?: number;
    onTaskChange?: (task: {
        id: string;
        claimedAt: string;
    } | null) => void;
}
interface MediaTaskPayloadLike {
    userId?: unknown;
    url?: unknown;
    file?: unknown;
}
interface MediaTaskLike {
    id: string;
    kind: string;
    channelKey: string;
    messageId: string;
    priority: number;
    payload?: MediaTaskPayloadLike;
    url?: string;
    fileId?: string | null;
}
declare function runVoiceTranscriptionTask(task: MediaTaskLike): Promise<Record<string, unknown>>;
declare function runClaimedMediaTask(task: MediaTaskLike): Promise<Record<string, unknown>>;
declare function runClaimedMediaTaskWithTimeout(task: MediaTaskLike): Promise<Record<string, unknown>>;
declare function drainOneMediaTask(options?: MediaWorkerOptions): Promise<boolean>;
declare const _default: {
    MEDIA_TASK_TIMEOUT_MS: number;
    drainOneMediaTask: typeof drainOneMediaTask;
    runClaimedMediaTask: typeof runClaimedMediaTask;
    runClaimedMediaTaskWithTimeout: typeof runClaimedMediaTaskWithTimeout;
    runVoiceTranscriptionTask: typeof runVoiceTranscriptionTask;
};
export = _default;
