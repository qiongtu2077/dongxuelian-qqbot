interface ChatMessage {
    role?: string;
    content?: string;
    tool_calls?: unknown;
}
interface ChatSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    quote?: {
        messageId?: string;
    };
    author?: {
        id?: string;
        nick?: string;
        name?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface ChatContextLike {
    logger: (name: string) => {
        warn: (...args: unknown[]) => void;
    };
}
interface FinalOutputOptions {
    randomTriggered?: boolean;
    replyToId?: string;
    meta?: Record<string, unknown>;
}
type CallModelFn = (messages: ChatMessage[], randomTriggered?: boolean, options?: Record<string, unknown>) => Promise<string>;
interface RetryUnsafeReplyOptions {
    reply?: string;
    messages?: ChatMessage[];
    session?: ChatSessionLike;
    ctx: ChatContextLike;
    options?: FinalOutputOptions;
    cleanInput?: string;
    currentUserId?: string;
    channelKey?: string;
    callModel: CallModelFn;
    usedReminderActionTool?: boolean;
    usedUploadedFileVariantTool?: boolean;
}
interface FinalizeChatReplyOptions extends RetryUnsafeReplyOptions {
    systemPrompt?: string;
    currentUserMessage?: string;
    userName?: string;
    retaliationLevel?: number;
    rareConfirmed?: boolean;
}
interface FinalizeChatReplyResult {
    finalReply: string;
    shouldSend: boolean;
}
declare function getReplyMaxChars(retaliationLevel?: number): number;
declare function retryUnsafeReply({ reply, messages, session, ctx, options, cleanInput, currentUserId, channelKey, callModel, usedReminderActionTool, usedUploadedFileVariantTool, }: RetryUnsafeReplyOptions): Promise<string>;
declare function finalizeChatReply({ reply, messages, session, ctx, options, cleanInput, currentUserId, channelKey, systemPrompt, currentUserMessage, userName, retaliationLevel, rareConfirmed, usedReminderActionTool, usedUploadedFileVariantTool, callModel, }: FinalizeChatReplyOptions): Promise<FinalizeChatReplyResult>;
declare const _default: {
    getReplyMaxChars: typeof getReplyMaxChars;
    retryUnsafeReply: typeof retryUnsafeReply;
    finalizeChatReply: typeof finalizeChatReply;
};
export = _default;
