interface ForwardLogger {
    info?: (message: string) => void;
}
interface ForwardContext {
    logger?: (name: string) => ForwardLogger;
}
interface ForwardSession {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface ResolveForwardOptions {
    callGetForwardMsg?: ForwardGetter;
}
type ForwardGetter = (forwardId: string) => Promise<unknown[] | unknown | null>;
declare function resolveForwardSummary(session: ForwardSession, content: unknown, ctx: ForwardContext | null | undefined, options?: ResolveForwardOptions): Promise<string>;
declare const _default: {
    resolveForwardSummary: typeof resolveForwardSummary;
};
export = _default;
