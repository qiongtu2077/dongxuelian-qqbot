interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
interface SafeSendContext {
    logger(name: string): LoggerLike;
    bots?: BotLike[];
    bot?: BotLike;
    setTimeout?: typeof setTimeout;
}
interface BotLike {
    selfId?: string;
    sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (id: string, message: unknown) => Promise<unknown> | unknown;
    };
}
interface SafeSendSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    content?: string;
    selfId?: string;
    author?: {
        id?: string;
        nick?: string;
        name?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
        selfId?: string;
    };
    bot?: BotLike;
    send(message: string): Promise<unknown> | unknown;
}
interface SendOptions {
    noQuote?: boolean;
    noReplyTo?: boolean;
    forceQuote?: boolean;
    quoteMessageId?: string | number;
    personaName?: string;
    randomFreshness?: {
        channelKey: string;
        triggerMessageVersion: number;
        explicitVersion: number;
        triggerAt: number;
    };
    now?: () => number;
    time?: {
        now?: () => number;
    };
    [key: string]: unknown;
}
type ResolveBot = (() => BotLike | null | undefined) | null;
type FreshnessChecker = ((isRandom: boolean, sendOptions: SendOptions) => boolean) | null;
declare function logStaleRandomSkip(ctx: SafeSendContext, stage: string, options?: SendOptions): void;
declare function resetSendFailState(): void;
declare function safeSendRepeat(ctx: SafeSendContext, session: SafeSendSessionLike, reply: string): Promise<boolean>;
declare function safeSendReply(ctx: SafeSendContext, session: SafeSendSessionLike, reply: string, isRandom?: boolean, resolveBot?: ResolveBot, sendOptions?: SendOptions, freshnessChecker?: FreshnessChecker): Promise<void>;
/** 尝试发送罕见固定语音；失败时返回 false 交给文字回复回退。 */
declare function safeSendRareVoice(ctx: SafeSendContext, session: SafeSendSessionLike): Promise<boolean>;
declare const _default: {
    logStaleRandomSkip: typeof logStaleRandomSkip;
    safeSendRepeat: typeof safeSendRepeat;
    safeSendReply: typeof safeSendReply;
    safeSendRareVoice: typeof safeSendRareVoice;
    resetSendFailState: typeof resetSendFailState;
};
export = _default;
