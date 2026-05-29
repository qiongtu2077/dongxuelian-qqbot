interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
interface ContextLike {
    logger(name: string): LoggerLike;
    on(event: 'ready' | 'dispose', handler: () => unknown): unknown;
}
interface PluginConfig {
    port?: number;
}
declare function apply(ctx: ContextLike, config?: PluginConfig): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export = _default;
