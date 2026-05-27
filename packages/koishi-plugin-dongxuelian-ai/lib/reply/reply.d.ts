interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
interface ReplyContext {
    logger(name: string): LoggerLike;
}
interface InternalBotLike {
    sendPrivateMsg?: (userId: string, message: unknown) => Promise<SendResultLike> | SendResultLike;
    sendGroupMsg?: (guildId: string, message: unknown) => Promise<SendResultLike> | SendResultLike;
}
interface ReplySessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        nick?: string;
        name?: string;
        id?: string;
    };
    bot?: {
        selfId?: string;
        internal?: InternalBotLike;
    };
    send(message: string): Promise<SendResultLike> | SendResultLike;
}
interface SendResultLike {
    messageId?: string;
    message_id?: string;
    id?: string;
    message_id_string?: string;
    data?: {
        message_id?: string;
    };
}
interface SendReplyOptions {
    noQuote?: boolean;
    noReplyTo?: boolean;
    forceQuote?: boolean;
    quoteMessageId?: string | number;
    personaName?: string;
    now?: () => number;
    time?: {
        now?: () => number;
    };
}
declare function loadStickerCache(): void;
declare function sendReply(ctx: ReplyContext, session: ReplySessionLike, reply: string, isRandom?: boolean, options?: SendReplyOptions): Promise<number>;
declare const _default: {
    loadStickerCache: typeof loadStickerCache;
    sendReply: typeof sendReply;
};
export = _default;
