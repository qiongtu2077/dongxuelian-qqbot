declare const handled: (response?: unknown) => {
    matched: true;
    response?: unknown;
}, notHandled: () => {
    matched: false;
};
type HandlerCommandResult = ReturnType<typeof handled> | ReturnType<typeof notHandled>;
interface HandlerLogger {
    info?: (message: string) => void;
    warn: (message: string) => void;
    error?: (message: string) => void;
}
interface HandlerContext {
    logger: (name: string) => HandlerLogger;
}
interface HandlerSession {
    userId?: string;
    selfId?: string;
    username?: string;
    content?: string;
    isDirect?: boolean;
    guildId?: string;
    channelId?: string;
    type?: string;
    subtype?: string;
    author?: {
        id?: string;
        nick?: string;
        name?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
        sender?: {
            role?: string;
        };
    };
    bot?: {
        selfId?: string;
    };
    quote?: {
        content?: string;
        elements?: unknown[];
    };
    send: (content: unknown) => unknown | Promise<unknown>;
}
interface HandlerModelMessage {
    role: string;
    content: string;
}
interface HandlerRuntimeConfig {
    provider: string;
    model: string;
    baseURL: string;
    searchEnabled: boolean;
}
interface HandlerTodayMessage {
    time?: string;
    ts?: number;
    user?: string;
    content?: string;
    userId?: string;
    messageId?: string;
    mentionUserIds?: string[];
}
interface HandlerTodayCache {
    date: string;
    messages: HandlerTodayMessage[];
}
interface HandlerEmotionCacheItem {
    response?: unknown;
    text?: string;
    ts: number;
}
interface HandlerState {
    plain: string;
    inGuild: boolean;
    channelKey: string;
    currentUserId: string;
    adminCommandMatched?: boolean;
    loadConfig: (force?: boolean) => HandlerRuntimeConfig | Promise<HandlerRuntimeConfig>;
    loadRuntimeSettings: (force?: boolean) => unknown | Promise<unknown>;
    loadSkills: (force?: boolean) => unknown | Promise<unknown>;
    loadSkillsContentCache: (force?: boolean) => unknown | Promise<unknown>;
    callOpenAI: (messages: HandlerModelMessage[], stream?: boolean, options?: Record<string, unknown>) => Promise<unknown>;
    setRepeatEnabled: (channelKey: string, enabled: boolean) => unknown;
    getRandomTriggerBaseRate: (channelKey: string) => number;
    getRandomWhitelistStatus: (channelKey: string) => boolean;
    getThinkingEnabled: () => boolean;
    setThinkingEnabled: (enabled: boolean) => unknown;
    resetConfigCache: () => unknown;
    getSkillsCount: () => number;
    channelMissCount: Map<string, unknown>;
    repeatEnabledCache: Record<string, boolean | undefined>;
    channelTodayCache: Map<string, HandlerTodayCache>;
    lastEmotionCache: Map<string, HandlerEmotionCacheItem>;
}
declare function handleOperationalCommandDomain(session: HandlerSession, ctx: HandlerContext, state: HandlerState): Promise<HandlerCommandResult>;
declare function handleConversationCommandDomain(session: HandlerSession, ctx: HandlerContext, state: HandlerState): Promise<HandlerCommandResult>;
declare function handleCommand(session: HandlerSession, ctx: HandlerContext, state: HandlerState): Promise<HandlerCommandResult>;
declare const _default: {
    handleCommand: typeof handleCommand;
    _test: {
        handleOperationalCommandDomain: typeof handleOperationalCommandDomain;
        handleConversationCommandDomain: typeof handleConversationCommandDomain;
    };
};
export = _default;
