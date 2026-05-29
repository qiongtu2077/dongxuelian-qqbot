interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
interface ContextLike {
    on(event: 'ready', handler: () => void): unknown;
    on(event: 'guild-member-removed', handler: (session: LeaveSessionLike) => Promise<void> | void): unknown;
    logger(name: string): LoggerLike;
}
interface BotLike {
    sendMessage?(target: string, message: string): Promise<unknown>;
}
interface LeaveSessionLike {
    channelId?: string;
    guildId?: string;
    userId?: string;
    event?: {
        guild?: {
            id?: string;
        };
        channel?: {
            id?: string;
        };
        user?: {
            id?: string;
        };
        member?: {
            user?: {
                id?: string;
            };
        };
    };
    bot?: BotLike;
}
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export = _default;
