interface AgentReplyCompleteInput {
    userId?: unknown;
    channel?: unknown;
    messages?: unknown;
}
interface AutoMemoryStats {
    counters: Record<string, number>;
    interval: number;
    memoryDir: string;
}
declare function shouldTrigger(userId: unknown): boolean;
declare function getDailyTotalSize(userId: unknown): Promise<number>;
declare function onAgentReplyComplete({ userId, channel, messages }?: AgentReplyCompleteInput): Promise<void>;
declare function resetAutoMemoryCounter(userId: unknown): void;
declare function getAutoMemoryStats(): AutoMemoryStats;
declare const _default: {
    DASHBOARD_MEMORY_DIR: string;
    DAILY_DIR: string;
    onAgentReplyComplete: typeof onAgentReplyComplete;
    resetAutoMemoryCounter: typeof resetAutoMemoryCounter;
    getAutoMemoryStats: typeof getAutoMemoryStats;
    shouldTrigger: typeof shouldTrigger;
    getDailyTotalSize: typeof getDailyTotalSize;
    safeUserId: (value?: string) => string;
};
export = _default;
