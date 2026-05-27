interface BridgeSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface AgentToolResult {
    name?: string;
    result?: unknown;
}
interface AgentResultLike {
    reply?: unknown;
    pendingId?: unknown;
    toolResults?: AgentToolResult[];
    toolCalls?: number | string;
}
interface RecentAgentContextEntry {
    ts: number;
    userMessage: string;
    reply: string;
    toolCalls: number;
    toolSummary: string;
}
interface RecordAgentChatResultOptions {
    session?: BridgeSessionLike | null;
    userMessage?: string;
    userName?: string;
    userId?: string;
    channelKey?: string;
    agentResult?: AgentResultLike;
}
interface RecentAgentContextOptions {
    channelKey?: string;
    userId?: string;
    userMessage?: string;
}
declare function buildAgentContextKey(channelKey?: string, userId?: string): string;
declare function extractSearchSummary(text?: string): string;
declare function extractFetchSummary(text?: string): string;
declare function summarizeAgentToolResults(toolResults?: AgentToolResult[]): string;
declare function recordAgentChatResult({ session, userMessage, userName, userId, channelKey, agentResult }?: RecordAgentChatResultOptions): RecentAgentContextEntry | null;
declare function isAgentFollowUp(text?: string): boolean;
declare function getRecentAgentContextNote({ channelKey, userId, userMessage }?: RecentAgentContextOptions): string;
declare function clearAgentChatBridge(): void;
declare function clearAgentContextForUser(channelKey: string, userId: string): void;
declare const _default: {
    buildAgentContextKey: typeof buildAgentContextKey;
    summarizeAgentToolResults: typeof summarizeAgentToolResults;
    extractSearchSummary: typeof extractSearchSummary;
    extractFetchSummary: typeof extractFetchSummary;
    recordAgentChatResult: typeof recordAgentChatResult;
    isAgentFollowUp: typeof isAgentFollowUp;
    getRecentAgentContextNote: typeof getRecentAgentContextNote;
    clearAgentChatBridge: typeof clearAgentChatBridge;
    clearAgentContextForUser: typeof clearAgentContextForUser;
};
export = _default;
