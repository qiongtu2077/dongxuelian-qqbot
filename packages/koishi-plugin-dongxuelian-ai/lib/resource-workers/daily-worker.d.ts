interface WorkerTaskResult extends Record<string, unknown> {
    defer?: boolean;
    reason?: string;
    mode?: string;
}
interface DailyWorkerTaskLike {
    id?: string;
    kind?: string;
    channelKey?: string;
    createdAt?: string;
    payload?: Record<string, unknown> & {
        renderImage?: unknown;
        level?: unknown;
        detail?: unknown;
    };
}
declare function runDailyWorkerTask(task: DailyWorkerTaskLike, runtime?: {
    deadlineMs?: number;
    startedAtMs?: number;
    signal?: AbortSignal;
}): Promise<WorkerTaskResult>;
declare const _default: {
    runDailyWorkerTask: typeof runDailyWorkerTask;
};
export = _default;
