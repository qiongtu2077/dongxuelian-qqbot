type ResourceTaskLike = import('./task-types').ResourceTask;
interface WorkerMainOptions {
    type?: string;
    workerName?: string;
    once?: boolean;
    pollMs?: number;
    gateWaitMs?: number;
    ownerGeneration?: string;
    startToken?: string;
    idleExitMs?: number;
}
interface WorkerHeartbeatHandle {
    setStep(step: string, patch?: Record<string, unknown>): void;
    patchProgress(patch?: Partial<WorkerProgressState>): void;
    stop(step?: string): void;
}
interface WorkerProgressState {
    loopIterations: number;
    lastClaimAttemptAt: string;
    lastTaskFinishedAt: string;
    currentTaskId: string;
    currentTaskStartedAt: string;
    parked: boolean;
    parkSleepMs: number;
    idleSinceAt: string;
}
declare function runTaskWithTimeout(task: ResourceTaskLike): Promise<Record<string, unknown>>;
declare function runOneQueuedTask(options?: WorkerMainOptions, heartbeat?: WorkerHeartbeatHandle | null, progress?: WorkerProgressState): Promise<boolean>;
declare function runWorkerTick(options?: WorkerMainOptions, heartbeat?: WorkerHeartbeatHandle | null, progress?: WorkerProgressState): Promise<boolean>;
declare function resolveWorkerIdleSleepMs(options?: WorkerMainOptions, worked?: boolean): number;
declare function shouldExitManagedWorker(options: WorkerMainOptions, idleSinceAt: string, now?: number): boolean;
declare function runWorkerLoop(options?: WorkerMainOptions): Promise<void>;
declare function parseWorkerCliArgs(argv?: string[]): WorkerMainOptions;
declare const _default: {
    runWorkerLoop: typeof runWorkerLoop;
    runWorkerTick: typeof runWorkerTick;
    resolveWorkerIdleSleepMs: typeof resolveWorkerIdleSleepMs;
    shouldExitManagedWorker: typeof shouldExitManagedWorker;
    runOneQueuedTask: typeof runOneQueuedTask;
    runTaskWithTimeout: typeof runTaskWithTimeout;
    parseWorkerCliArgs: typeof parseWorkerCliArgs;
};
export = _default;
