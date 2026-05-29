interface LoggerLike {
    info(...args: unknown[]): void;
}
interface ContextLike {
    on(event: 'ready', handler: () => void): unknown;
    middleware(handler: MiddlewareLike): unknown;
    logger(name: string): LoggerLike;
}
interface HelpSessionLike {
    content?: string;
}
type MiddlewareNext = () => unknown;
type MiddlewareLike = (session: HelpSessionLike, next: MiddlewareNext) => unknown;
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export = _default;
