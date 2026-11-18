import { ChatTurnBudget } from '../lifecycle/chat-turn-budget';
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
    quote?: {
        content?: string;
    };
    _forwardImageMessages?: Array<{
        messageId: string;
        message: Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
    }>;
}
interface ResolveForwardOptions {
    callGetForwardMsg?: ForwardGetter;
    turn?: ChatTurnBudget;
}
type ForwardGetter = (forwardId: string, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown[] | unknown | null>;
declare function resolveForwardSummary(session: ForwardSession, content: unknown, ctx: ForwardContext | null | undefined, options?: ResolveForwardOptions): Promise<string>;
declare const _default: {
    resolveForwardSummary: typeof resolveForwardSummary;
};
export = _default;
