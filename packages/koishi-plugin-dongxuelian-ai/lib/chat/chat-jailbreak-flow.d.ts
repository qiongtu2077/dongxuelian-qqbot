interface JailbreakSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        id?: string;
        nick?: string;
        name?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface JailbreakContextLike {
    logger?: (name: string) => {
        warn?: (...args: unknown[]) => void;
    };
}
interface ChatJailbreakOptions {
    systemPrompt?: string;
}
declare function isContextJailbroken(session: JailbreakSessionLike): boolean;
declare function chatJailbreak(session: JailbreakSessionLike, userText: string, ctx?: JailbreakContextLike, options?: ChatJailbreakOptions): Promise<string>;
declare const _default: {
    isContextJailbroken: typeof isContextJailbroken;
    chatJailbreak: typeof chatJailbreak;
};
export = _default;
