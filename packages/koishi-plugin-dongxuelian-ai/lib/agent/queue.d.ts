/**
 * MODULE: Agent 队列调度。
 * 职责: 管理 Agent 长任务的 per-user 串行、频道深度和全局并发。
 * 边界: 不调用模型、不发送 QQ 消息、不修改普通聊天队列。
 * 状态: activeCount / taskQueues / activeKeys / counters（模块级运行时状态）。
 */
interface QueueOptions {
    maxGlobal: number;
    maxPerChannel: number;
    maxPendingPerUser: number;
    timeoutMs: number;
}
interface EnqueueAgentTaskOptions {
    channelKey?: unknown;
    userId?: unknown;
    fn?: () => Promise<unknown> | unknown;
    timeoutMs?: unknown;
    maxDepth?: unknown;
}
interface AgentQueueStats {
    options: QueueOptions;
    activeCount: number;
    waitingCount: number;
    queuedCount: number;
    completedCount: number;
    rejectedCount: number;
    timeoutCount: number;
    lastError: string;
    byChannel: Record<string, number>;
    activeKeys: string[];
}
declare function configureAgentQueue(nextOptions?: Partial<QueueOptions>): QueueOptions;
declare function withTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number): Promise<T>;
declare function enqueueAgentTask({ channelKey, userId, fn, timeoutMs, maxDepth }?: EnqueueAgentTaskOptions): Promise<unknown>;
declare function clearAgentQueue(channelKey?: unknown, userId?: unknown): number;
declare function getAgentQueueStats(): AgentQueueStats;
declare function resetAgentQueueForTests(): void;
declare const _default: {
    enqueueAgentTask: typeof enqueueAgentTask;
    getAgentQueueStats: typeof getAgentQueueStats;
    clearAgentQueue: typeof clearAgentQueue;
    configureAgentQueue: typeof configureAgentQueue;
    withTimeout: typeof withTimeout;
    resetAgentQueueForTests: typeof resetAgentQueueForTests;
};
export = _default;
