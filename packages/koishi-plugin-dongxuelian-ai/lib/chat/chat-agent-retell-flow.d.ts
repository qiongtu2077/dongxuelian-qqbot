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
        nick?: string;
        name?: string;
    };
}
interface AgentRetellOptions {
    randomTriggered?: boolean;
}
interface AgentRetellMessage {
    role: string;
    content: string;
}
type CallModelFn = (messages: AgentRetellMessage[], randomTriggered?: boolean, options?: Record<string, unknown>) => Promise<string | {
    content?: unknown;
    message?: {
        content?: unknown;
    };
}>;
interface RetellAgentResultForChatOptions {
    session?: SessionLike;
    ctx: ContextLike;
    options?: AgentRetellOptions;
    agentResultText?: string;
    cleanInput?: string;
    channelKey?: string;
    systemPrompt?: string;
    currentUserMessage?: string;
    userName?: string;
    retaliationLevel?: number;
    callModel: CallModelFn;
    now?: Date;
}
declare function getAgentReplyMaxChars(retaliationLevel?: number): number;
declare function retellAgentResultForChat({ session, ctx, options, agentResultText, cleanInput, channelKey, systemPrompt, currentUserMessage, userName, retaliationLevel, callModel, now, }: RetellAgentResultForChatOptions): Promise<string>;
declare const _default: {
    getAgentReplyMaxChars: typeof getAgentReplyMaxChars;
    retellAgentResultForChat: typeof retellAgentResultForChat;
};
export = _default;
