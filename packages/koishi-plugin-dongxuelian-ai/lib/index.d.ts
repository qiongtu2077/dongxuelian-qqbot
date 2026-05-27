interface IndexLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
interface IndexBot {
    selfId?: string;
    sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (id: string, message: string) => Promise<unknown> | unknown;
    };
}
interface IndexContext {
    [key: string]: unknown;
    bots?: IndexBot[];
    bot?: IndexBot;
    logger(name: string): IndexLogger;
    middleware(handler: (session: IndexSession, next: () => unknown | Promise<unknown>) => unknown | Promise<unknown>): unknown;
    on(event: 'ready' | 'dispose', handler: () => unknown): void;
}
interface IndexSession {
    [key: string]: unknown;
    content?: string;
    selfId?: string;
    userId?: string;
    username?: string;
    isDirect?: boolean;
    guildId?: string;
    channelId?: string;
    messageId?: string;
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
        selfId?: string;
        message?: IndexSegment[];
    };
    quote?: {
        content?: string;
        elements?: unknown[];
    };
    bot?: IndexBot;
    elements?: unknown[];
    _skipVision?: boolean;
    send(message: unknown): Promise<unknown>;
}
interface IndexSegment {
    type?: string;
    data?: {
        url?: unknown;
        file?: unknown;
        [key: string]: unknown;
    };
    attrs?: unknown;
    [key: string]: unknown;
}
interface IndexRepeatSession {
    isDirect?: boolean;
    content?: string;
    event?: {
        message?: unknown[] | {
            elements?: unknown[];
            content?: unknown[];
        };
    };
}
interface IndexRepeatAnalysis {
    hasFile?: boolean;
    hasEmbed?: boolean;
    hasMessageRecordCue?: boolean;
    hasVisual?: boolean;
}
interface IndexRepeatCandidate {
    key: string;
    reply: string;
    kind: string;
    supported: boolean;
    reason?: string;
}
type IndexBuildRepeatCandidate = (session: IndexRepeatSession, plain: string, analyzed?: IndexRepeatAnalysis) => IndexRepeatCandidate;
type IndexCheckGroupRepeat = (session: IndexRepeatSession, candidate: IndexRepeatCandidate | null | undefined, channelKey: string, currentUserId: string, now?: number) => IndexRepeatCandidate | null;
declare function apply(ctx: IndexContext): void;
declare const _default: {
    name: string;
    buildRepeatCandidate: IndexBuildRepeatCandidate;
    checkGroupRepeat: IndexCheckGroupRepeat;
    apply: typeof apply;
};
export = _default;
