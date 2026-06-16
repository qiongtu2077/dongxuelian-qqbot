interface SubmitTaskInput {
    id?: string;
    kind: string;
    source?: string;
    channelKey?: string;
    userId?: string;
    priority?: number;
    expiresAt?: string;
    timeoutMs?: number;
    payload?: Record<string, unknown>;
    notify?: Record<string, unknown>;
}
interface ListTasksOptions {
    statuses?: string[];
    limit?: number;
}
interface CountTasksOptions {
    statuses?: string[];
    limit?: number;
    kind?: string;
}
interface CountTasksByKindOptions {
    statuses?: string[];
    limit?: number;
    kind: string;
}
type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred';
interface ResourceTask extends Record<string, unknown> {
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
    retryAfter?: string;
}
interface ResourceWorkerState extends Record<string, unknown> {
    name: string;
    pid: number;
    startedAt: string;
    heartbeatAt: string;
    alive: boolean;
    heartbeatLagMs?: number | null;
    kind?: string;
    step?: string;
    loopIterations?: number;
    lastClaimAttemptAt?: string;
    lastTaskFinishedAt?: string;
    currentTaskId?: string;
    currentTaskStartedAt?: string;
    parked?: boolean;
    parkSleepMs?: number;
}
/**
 * 注册任务完成回调
 * @param fn 回调函数，接收 taskId 参数
 */
declare function registerTaskCompletedCallback(fn: (taskId: string) => void): void;
/**
 * 取消注册任务完成回调
 * @param fn 回调函数
 */
declare function unregisterTaskCompletedCallback(fn: (taskId: string) => void): void;
declare function ensureTaskDirs(): void;
declare function writeWorkerEvent(event: string, data?: Record<string, unknown>): void;
declare function createTaskId(kind: string, channelKey?: string): string;
declare function submitResourceTask(input: SubmitTaskInput): ResourceTask;
declare function listResourceTasks(options?: ListTasksOptions): ResourceTask[];
declare function countResourceTasks(options?: CountTasksOptions): number;
declare function countResourceTasksByKind(options: CountTasksByKindOptions, matcher?: (task: ResourceTask) => boolean): number;
declare function findResourceTaskByKindAndChannel(kind: string, channelKey: string, statuses?: string[]): ResourceTask | null;
declare function getTaskQueueSummary(): Record<string, unknown>;
declare function claimNextTask(kind: string | string[], workerName: string): ResourceTask | null;
declare function claimTaskById(taskId: string, workerName: string): ResourceTask | null;
declare function getResourceTaskByIdForKind(taskId: string, kind: string, statuses?: ResourceTaskStatus[]): ResourceTask | null;
declare function getResourceTaskById(taskId: string): ResourceTask | null;
declare function markTaskRunning(task: ResourceTask, workerName: string, step?: string): ResourceTask;
declare function failIsolatedClaimingTask(task: ResourceTask, error: unknown, result?: Record<string, unknown>): ResourceTask;
declare function updateTaskStep(taskId: string, kind: string, step: string): ResourceTask | null;
declare function writeTaskResult(taskId: string, result: Record<string, unknown>): string;
declare function completeTask(task: ResourceTask, result?: Record<string, unknown>): ResourceTask;
declare function failTask(task: ResourceTask, error: unknown, result?: Record<string, unknown>): ResourceTask;
declare function deferTask(task: ResourceTask, reason?: string): ResourceTask;
declare function requeueTask(task: ResourceTask, reason?: string): ResourceTask;
declare function updateTaskNotifyStatus(task: ResourceTask, status: string, error?: string): ResourceTask;
declare function cancelTask(taskId: string, actor?: string, reason?: string): boolean;
declare function writeWorkerHeartbeat(workerName: string, state?: Record<string, unknown>): ResourceWorkerState;
declare function listWorkerStates(): ResourceWorkerState[];
declare function removeTaskFile(status: string, kind: string, taskId: string): boolean;
interface CleanupFinishedTasksOptions {
    retentionDays?: number;
    now?: number;
    maxScan?: number;
}
interface CleanupFinishedTasksResult {
    removed: number;
    resultsRemoved: number;
    orphanResultsRemoved: number;
    scanned: number;
}
declare function cleanupFinishedTasks(options?: CleanupFinishedTasksOptions): CleanupFinishedTasksResult;
declare const _default: {
    ensureTaskDirs: typeof ensureTaskDirs;
    writeWorkerEvent: typeof writeWorkerEvent;
    createTaskId: typeof createTaskId;
    submitResourceTask: typeof submitResourceTask;
    getResourceTaskById: typeof getResourceTaskById;
    getResourceTaskByIdForKind: typeof getResourceTaskByIdForKind;
    findResourceTaskByKindAndChannel: typeof findResourceTaskByKindAndChannel;
    listResourceTasks: typeof listResourceTasks;
    countResourceTasks: typeof countResourceTasks;
    countResourceTasksByKind: typeof countResourceTasksByKind;
    getTaskQueueSummary: typeof getTaskQueueSummary;
    claimNextTask: typeof claimNextTask;
    claimTaskById: typeof claimTaskById;
    markTaskRunning: typeof markTaskRunning;
    failIsolatedClaimingTask: typeof failIsolatedClaimingTask;
    updateTaskStep: typeof updateTaskStep;
    writeTaskResult: typeof writeTaskResult;
    completeTask: typeof completeTask;
    failTask: typeof failTask;
    deferTask: typeof deferTask;
    requeueTask: typeof requeueTask;
    updateTaskNotifyStatus: typeof updateTaskNotifyStatus;
    cancelTask: typeof cancelTask;
    writeWorkerHeartbeat: typeof writeWorkerHeartbeat;
    listWorkerStates: typeof listWorkerStates;
    removeTaskFile: typeof removeTaskFile;
    cleanupFinishedTasks: typeof cleanupFinishedTasks;
    registerTaskCompletedCallback: typeof registerTaskCompletedCallback;
    unregisterTaskCompletedCallback: typeof unregisterTaskCompletedCallback;
};
export = _default;
