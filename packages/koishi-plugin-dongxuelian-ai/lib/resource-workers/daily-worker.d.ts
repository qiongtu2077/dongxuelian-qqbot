interface WorkerTaskResult extends Record<string, unknown> {
    defer?: boolean;
    reason?: string;
    mode?: string;
}
interface DailyWorkerTaskLike {
    id?: string;
    kind?: string;
    channelKey?: string;
    payload?: {
        renderImage?: unknown;
        level?: unknown;
        detail?: unknown;
    };
}
declare function runDailyWorkerTask(task: DailyWorkerTaskLike): Promise<WorkerTaskResult>;
declare const _default: {
    runDailyWorkerTask: typeof runDailyWorkerTask;
};
export = _default;
