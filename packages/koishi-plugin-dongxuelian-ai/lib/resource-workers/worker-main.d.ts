interface WorkerMainOptions {
    type?: string;
    workerName?: string;
    once?: boolean;
    pollMs?: number;
    gateWaitMs?: number;
}
interface WorkerHeartbeatHandle {
    setStep(step: string, patch?: Record<string, unknown>): void;
    stop(step?: string): void;
}
type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred';
interface ResourceTaskLike extends Record<string, unknown> {
    id: string;
    kind: string;
    status: ResourceTaskStatus;
    source: string;
    channelKey: string;
    userId: string;
    priority: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    timeoutMs: number;
    payload: Record<string, unknown>;
    notify: Record<string, unknown>;
    step?: string;
    claimedBy?: string;
    claimedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
}
declare function runTaskWithTimeout(task: ResourceTaskLike): Promise<Record<string, unknown>>;
declare function runOneQueuedTask(options?: WorkerMainOptions, heartbeat?: WorkerHeartbeatHandle | null): Promise<boolean>;
declare function runWorkerTick(options?: WorkerMainOptions, heartbeat?: WorkerHeartbeatHandle | null): Promise<boolean>;
declare function runWorkerLoop(options?: WorkerMainOptions): Promise<void>;
declare function parseWorkerCliArgs(argv?: string[]): WorkerMainOptions;
declare const _default: {
    runWorkerLoop: typeof runWorkerLoop;
    runWorkerTick: typeof runWorkerTick;
    runOneQueuedTask: typeof runOneQueuedTask;
    runTaskWithTimeout: typeof runTaskWithTimeout;
    parseWorkerCliArgs: typeof parseWorkerCliArgs;
};
export = _default;
