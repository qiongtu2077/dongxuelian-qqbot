/**
 * MODULE: 今日情绪命令。
 * 边界: 只处理群聊情绪报告命令、情绪历史读写与图片渲染回退；不改聊天主流程，不写 conversation。
 * 状态: 复用 index.js 注入的 channelTodayCache / lastEmotionCache，不自建跨模块全局状态。
 */
declare const handled: (response?: unknown) => {
    matched: true;
    response?: unknown;
}, notHandled: () => {
    matched: false;
};
interface LoggerLike {
    warn: (message: string) => void;
    info?: (message: string) => void;
}
interface EmotionContextLike {
    logger: (name: string) => LoggerLike;
}
interface EmotionSessionLike {
    send: (content: unknown) => unknown | Promise<unknown>;
}
interface ModelMessage {
    role: string;
    content: string;
}
type CallOpenAI = (messages: ModelMessage[], stream?: boolean, options?: Record<string, unknown>) => Promise<unknown>;
interface EmotionMessage {
    time?: unknown;
    user?: unknown;
    content?: unknown;
    userId?: unknown;
}
interface EmotionTodayCache {
    date: string;
    messages: EmotionMessage[];
}
interface EmotionStats {
    messageCount: number;
    userCount: number;
}
interface EmotionAnalysis {
    score: number;
    confidence: number;
    mood: string;
    summary: string;
    reasons: string[];
    keywords: string[];
}
interface EmotionHistoryItem {
    date: string;
    score: number;
    mood: string;
    summary: string;
}
interface EmotionCacheItem {
    response?: unknown;
    text?: string;
    ts: number;
}
type EmotionImageRenderer = (analysis: EmotionAnalysis, stats: EmotionStats, history: EmotionHistoryItem[]) => Promise<unknown>;
interface EmotionCommandState {
    plain: string;
    inGuild: boolean;
    channelKey: string;
    loadConfig: (force?: boolean) => unknown | Promise<unknown>;
    callOpenAI: CallOpenAI;
    channelTodayCache: Map<string, EmotionTodayCache>;
    lastEmotionCache: Map<string, EmotionCacheItem>;
    renderEmotionImage?: EmotionImageRenderer;
}
declare function handleEmotionCommand(session: EmotionSessionLike, ctx: EmotionContextLike, state: EmotionCommandState): Promise<ReturnType<typeof handled> | ReturnType<typeof notHandled>>;
declare const _default: {
    handleEmotionCommand: typeof handleEmotionCommand;
};
export = _default;
