interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
interface ContextLike {
    logger: (name: string) => LoggerLike;
    [key: string]: unknown;
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
    bot?: unknown;
    send?: (message: unknown) => Promise<unknown> | unknown;
}
interface ChatMeta {
    rareConfirmed?: boolean;
    [key: string]: unknown;
}
interface RandomSendOptions {
    [key: string]: unknown;
}
type ResolveBotFn = () => unknown;
type SafeSendReplyWithFreshness = (ctx: ContextLike, session: SessionLike, reply: string, randomTriggered: boolean, resolveBot?: ResolveBotFn, options?: Record<string, unknown>) => Promise<unknown>;
interface TrySendRandomVoiceOptions {
    ctx: ContextLike;
    liveSession: SessionLike;
    channelKey: string;
    currentUserId: string;
    reply: string;
    randomTriggered: boolean;
    inGuild: boolean;
    chatMeta: ChatMeta;
    randomSendOptions: RandomSendOptions;
}
interface SendChatReplyFlowOptions extends TrySendRandomVoiceOptions {
    userText: string;
    currentPersonaName?: string;
    resolveBot?: ResolveBotFn;
    safeSendReplyWithFreshness: SafeSendReplyWithFreshness;
}
declare function sendChatReplyFlow({ ctx, liveSession, channelKey, currentUserId, userText, reply, randomTriggered, inGuild, chatMeta, randomSendOptions, currentPersonaName, resolveBot, safeSendReplyWithFreshness, }: SendChatReplyFlowOptions): Promise<unknown>;
declare const _default: {
    sendChatReplyFlow: typeof sendChatReplyFlow;
};
export = _default;
