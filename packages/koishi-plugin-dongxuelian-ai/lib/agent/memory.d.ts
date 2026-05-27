interface MemoryItem {
    id: string;
    text: string;
    tags?: string[];
    channelKey?: string;
    keywords?: string[];
    createdAt: number;
    updatedAt?: number;
}
interface RememberInput {
    userId?: unknown;
    channelKey?: unknown;
    text?: unknown;
    tags?: unknown;
}
interface SearchMemoryInput {
    userId?: unknown;
    channelKey?: unknown;
    query?: unknown;
    limit?: unknown;
}
interface ForgetMemoryInput {
    userId?: unknown;
    memoryId?: unknown;
}
interface ListMemoryInput {
    userId?: unknown;
    limit?: unknown;
}
interface SearchDashboardMemoryInput {
    userId?: unknown;
    query?: unknown;
}
declare function tokenize(text?: unknown): string[];
declare function remember({ userId, channelKey, text, tags }?: RememberInput): Promise<MemoryItem>;
declare function searchMemory({ userId, channelKey, query, limit }?: SearchMemoryInput): Promise<MemoryItem[]>;
declare function forgetMemory({ userId, memoryId }?: ForgetMemoryInput): Promise<number>;
declare function listMemory({ userId, limit }?: ListMemoryInput): Promise<MemoryItem[]>;
declare function formatMemoryItems(items?: MemoryItem[]): string;
declare function searchDashboardMemory({ userId, query }?: SearchDashboardMemoryInput): Promise<string>;
declare const _default: {
    MEMORY_DIR: string;
    DASHBOARD_MEMORY_DIR: string;
    remember: typeof remember;
    searchMemory: typeof searchMemory;
    searchDashboardMemory: typeof searchDashboardMemory;
    forgetMemory: typeof forgetMemory;
    listMemory: typeof listMemory;
    formatMemoryItems: typeof formatMemoryItems;
    tokenize: typeof tokenize;
    safeUserId: (value?: string) => string;
};
export = _default;
