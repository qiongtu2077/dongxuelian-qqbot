interface ChatLoggerLike {
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
}
interface ChatContextLike {
    logger(name: string): ChatLoggerLike;
}
interface ChatAuthorLike {
    id?: string;
    nick?: string;
    name?: string;
}
interface ChatBotLike {
    selfId?: string;
    user?: {
        name?: string;
    };
    username?: string;
}
interface ChatSessionLike {
    content?: string;
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    selfId?: string;
    messageId?: string;
    type?: string;
    subtype?: string;
    author?: ChatAuthorLike;
    bot?: ChatBotLike;
    event?: {
        selfId?: string;
        message?: unknown[];
        sender?: {
            role?: string;
        };
    };
    quote?: {
        messageId?: string;
        content?: string;
        elements?: unknown;
    };
    _skipVision?: boolean;
    [key: string]: unknown;
}
interface ChatRunOptions {
    randomTriggered?: boolean;
    isAgentResult?: boolean;
    agentResultText?: string;
    sharedContextNote?: string;
    activeSceneNote?: string;
    quotedMessageNote?: string;
    forwardSummaryText?: string;
    replyToId?: string;
    directAt?: boolean;
    nameMentioned?: boolean;
    mentionUserIds?: unknown[];
    meta?: Record<string, unknown>;
    [key: string]: unknown;
}
interface ChatMessageLike {
    role?: string;
    content?: string | null | Array<Record<string, unknown>>;
    tool_calls?: unknown;
    tool_call_id?: string;
}
interface ChatToolCallReplyLike {
    type?: string;
    tool_calls?: unknown[];
    message?: {
        content?: string | null;
    };
    content?: string;
    reasoning?: string;
}
interface ChatHeavyToolRequest {
    name?: string;
    args: Record<string, unknown>;
}
interface ChatHeavyToolResult {
    text: unknown;
    heavyToolsRequested: ChatHeavyToolRequest[];
}
interface PublicRuntimeConfig {
    apiKey: string;
    model: string;
    baseURL: string;
    provider: string;
    searchEnabled: boolean;
    [key: string]: unknown;
}
type ChatModelReply = string | ChatToolCallReplyLike;
type ChatResult = string | ChatHeavyToolResult;
type PublicLoadConfig = (force?: boolean) => Promise<PublicRuntimeConfig>;
type PublicGetThinkingArgs = (config: PublicRuntimeConfig) => Record<string, unknown>;
declare function callOpenAI(messages: ChatMessageLike[], isRandom: boolean, extraBody?: Record<string, unknown>, tools?: unknown): Promise<ChatModelReply>;
declare function chat(session: ChatSessionLike, userText: string, ctx: ChatContextLike, options?: ChatRunOptions): Promise<ChatResult>;
declare const _default: {
    chat: typeof chat;
    loadConfig: PublicLoadConfig;
    resetConfigCache: () => void;
    loadSkills: () => Promise<string[]>;
    loadSkillsContentCache: () => Promise<void>;
    refreshSkillsContentCacheIfChanged: () => Promise<boolean>;
    callOpenAI: typeof callOpenAI;
    getThinkingArgs: PublicGetThinkingArgs;
    getSkillsCount: () => number;
    getThinkingEnabled: () => boolean;
    setThinkingEnabled: (value: boolean) => void;
};
export = _default;
