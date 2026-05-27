interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
interface AutoRouteContext {
    logger(name: string): LoggerLike;
    [key: string]: unknown;
}
interface AutoRouteSession {
    userId?: string;
    selfId?: string;
    content?: string;
    author?: {
        id?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
        message?: unknown[] | {
            elements?: unknown[];
            content?: unknown[];
        };
    };
    bot?: {
        selfId?: string;
    };
}
interface AgentEngineLike {
    run(input: Record<string, unknown>): Promise<unknown>;
}
interface AgentTaskInput {
    channelKey: string;
    userId: string;
    timeoutMs?: number;
    fn: () => Promise<unknown>;
}
interface HandleAgentAutoRouteInput {
    ctx: AutoRouteContext;
    liveSession: AutoRouteSession;
    channelKey: string;
    currentUserId: string;
    userName: string;
    userText: string;
    randomTriggered?: boolean;
    recentUserMessages?: string[];
    searchContext?: Record<string, unknown>;
    resolveBot: () => unknown;
    chat: unknown;
    agentEngine: AgentEngineLike;
    enqueueAgentTask: (input: AgentTaskInput) => Promise<unknown>;
    configureAgentQueue: (queue: Record<string, unknown>) => void;
    retellAgentResult: (result: unknown, input: Record<string, unknown>) => Promise<string>;
}
interface HandleAgentAutoRouteResult {
    handled: boolean;
    reply?: string;
}
declare function handleAgentAutoRoute({ ctx, liveSession, channelKey, currentUserId, userName, userText, randomTriggered, recentUserMessages, searchContext, resolveBot, chat, agentEngine, enqueueAgentTask, configureAgentQueue, retellAgentResult, }: HandleAgentAutoRouteInput): Promise<HandleAgentAutoRouteResult>;
declare const _default: {
    handleAgentAutoRoute: typeof handleAgentAutoRoute;
};
export = _default;
