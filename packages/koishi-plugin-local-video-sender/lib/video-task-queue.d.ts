type ResourceTask = import('../../koishi-plugin-dongxuelian-ai/lib/resource-workers/task-types').ResourceTask;
interface VideoTaskStore {
    submitResourceTask(input: Record<string, unknown>): ResourceTask;
    getResourceTaskById(taskId: string): ResourceTask | null;
    countResourceTasksByKind(options: {
        kind: string;
        statuses?: string[];
        limit?: number;
    }): number;
    claimNextTask(kind: string, workerName: string): ResourceTask | null;
    markTaskRunning(task: ResourceTask, workerName: string, step?: string): ResourceTask;
    completeTask(task: ResourceTask, result?: Record<string, unknown>): ResourceTask;
    failTask(task: ResourceTask, error: unknown, result?: Record<string, unknown>): ResourceTask;
    requeueTask(task: ResourceTask, reason?: string): ResourceTask;
    cancelResourceTasksByKind(kind: string, statuses?: string[], actor?: string, reason?: string): ResourceTask[];
}
interface VideoTaskPayload {
    p1Url: string;
    bvId: string;
    inputType: string;
    targetType: 'group' | 'private';
    targetId: string;
    requestedAt: string;
    retryCount: number;
    traceId: string;
}
interface EnqueueVideoTaskInput extends VideoTaskPayload {
    taskId: string;
    channelKey: string;
    userId: string;
}
type EnqueueVideoTaskResult = {
    status: 'queued';
    task: ResourceTask;
    waiting: number;
    capacity: number;
} | {
    status: 'full';
    waiting: number;
    capacity: number;
} | {
    status: 'unavailable';
    reason: string;
} | {
    status: 'persist_failed';
    taskId: string;
};
type VideoTaskExecutionResult = {
    status: 'done';
    result?: Record<string, unknown>;
} | {
    status: 'retry';
    reason: string;
} | {
    status: 'failed';
    reason: string;
    result?: Record<string, unknown>;
    notify?: boolean;
};
interface CreateVideoTaskQueueOptions {
    store?: VideoTaskStore | null;
    execute(task: ResourceTask): Promise<VideoTaskExecutionResult>;
    onTerminalFailure?(task: ResourceTask, reason: string): Promise<void>;
    onTerminal?(task: ResourceTask, status: 'done' | 'failed' | 'cancelled', reason: string): void;
    now?: () => number;
    schedule?: (handler: () => void, delayMs: number) => NodeJS.Timeout;
}
interface VideoTaskQueueController {
    initialize(): {
        available: boolean;
        cancelled: number;
        reason: string;
    };
    enqueue(input: EnqueueVideoTaskInput): Promise<EnqueueVideoTaskResult>;
    kick(): void;
    dispose(): void;
    status(): Record<string, unknown>;
}
declare function validateVideoTaskStore(candidate: unknown): candidate is VideoTaskStore;
declare function loadVideoTaskStore(): VideoTaskStore | null;
declare function createVideoTaskQueue(options: CreateVideoTaskQueueOptions): VideoTaskQueueController;
declare const _default: {
    EXTERNAL_VIDEO_TASK_KIND: string;
    VIDEO_QUEUE_CAPACITY: number;
    ACTIVE_VIDEO_TASK_STATUSES: string[];
    WAITING_VIDEO_TASK_STATUSES: string[];
    validateVideoTaskStore: typeof validateVideoTaskStore;
    loadVideoTaskStore: typeof loadVideoTaskStore;
    createVideoTaskQueue: typeof createVideoTaskQueue;
};
export = _default;
