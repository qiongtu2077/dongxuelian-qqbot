interface LoggerLike {
    info(...args: unknown[]): void;
}
interface ContextLike {
    on(event: 'ready', handler: () => void): unknown;
    middleware(handler: MiddlewareLike, prepend?: boolean | {
        prepend?: boolean;
    }): unknown;
    logger(name: string): LoggerLike;
}
interface DefenseSessionLike {
    selfId?: string | number;
    bot?: {
        selfId?: string | number;
    };
    isDirect?: boolean;
    content?: string;
    send(message: string): Promise<unknown>;
}
type MiddlewareNext = () => unknown | Promise<unknown>;
type MiddlewareLike = (session: DefenseSessionLike, next: MiddlewareNext) => unknown | Promise<unknown>;
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
    promptDefense: string;
    promptDefenseAbusive: string;
};
export = _default;
