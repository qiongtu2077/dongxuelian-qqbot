interface LoggerLike {
    warn: (...args: unknown[]) => void;
}
interface ContextLike {
    logger: (name: string) => LoggerLike;
}
interface SessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    author?: {
        id?: string;
    };
    bot?: unknown;
}
interface HeavyToolRequest {
    name?: string;
    args?: Record<string, unknown>;
}
interface ChatResultObject {
    text?: string;
    heavyToolsRequested?: HeavyToolRequest[];
}
interface AgentToolResult {
    name?: string;
    result?: unknown;
}
interface AgentResultLike {
    reply?: unknown;
    toolResults?: AgentToolResult[];
    toolCalls?: number;
    pendingId?: unknown;
}
interface SearchContextLike {
    searchReadiness?: string;
    blockedReason?: string;
    recentUserMessages?: string[];
}
type ChatFn = (session: SessionLike, userText: string, ctx: ContextLike, options?: Record<string, unknown>) => Promise<string | ChatResultObject>;
interface RetellToolBlockedOptions {
    ctx: ContextLike;
    session: SessionLike;
    userText: string;
    randomTriggered?: boolean;
    chat: ChatFn;
    reason?: string;
}
interface RetellAgentResultOptions {
    ctx: ContextLike;
    session: SessionLike;
    channelKey: string;
    currentUserId: string;
    userName: string;
    userText: string;
    randomTriggered?: boolean;
    chat: ChatFn;
    emptyText?: string;
}
interface AgentEngineLike {
    run(options: Record<string, unknown>): Promise<AgentResultLike>;
}
interface HandleChatResultOptions extends RetellAgentResultOptions {
    isAdmin?: boolean;
    resolveBot?: (() => unknown) | null;
    searchContext?: SearchContextLike | null;
    agentEngine: AgentEngineLike;
    enqueueAgentTask: (options: {
        channelKey: string;
        userId: string;
        timeoutMs?: number;
        fn: () => Promise<AgentResultLike>;
    }) => Promise<AgentResultLike>;
    configureAgentQueue: (options: Record<string, unknown>) => void;
}
declare function normalizeChatResultText(chatResult: unknown, fallback?: string): string;
declare function retellToolBlockedReply(chatResult: unknown, { ctx, session, userText, randomTriggered, chat, reason, }: RetellToolBlockedOptions): Promise<string>;
declare function retellAgentResult(agentResult: AgentResultLike, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, chat, emptyText, }: RetellAgentResultOptions): Promise<string>;
declare function handleChatResult(chatResult: unknown, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, isAdmin, resolveBot, searchContext, chat, agentEngine, enqueueAgentTask, configureAgentQueue, }: HandleChatResultOptions): Promise<string>;
declare const _default: {
    normalizeChatResultText: typeof normalizeChatResultText;
    retellToolBlockedReply: typeof retellToolBlockedReply;
    retellAgentResult: typeof retellAgentResult;
    handleChatResult: typeof handleChatResult;
};
export = _default;
