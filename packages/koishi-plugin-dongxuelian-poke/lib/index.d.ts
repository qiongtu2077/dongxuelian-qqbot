interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
interface ContextLike {
    on(event: 'notice', handler: (session: NoticeSessionLike) => Promise<void> | void): unknown;
    logger(name: string): LoggerLike;
}
interface NapcatInternalLike {
    _request(action: string, params: Record<string, unknown>): Promise<unknown>;
}
interface BotLike {
    selfId?: string | number;
    internal?: Partial<NapcatInternalLike>;
}
interface NoticeSessionLike {
    subtype?: string;
    sub_type?: string;
    selfId?: string | number;
    targetId?: string | number;
    target_id?: string | number;
    userId?: string | number;
    guildId?: string | number;
    bot?: BotLike;
}
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export = _default;
