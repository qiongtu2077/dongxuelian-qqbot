interface TodayCacheSnapshot {
    date?: string;
    messages?: Array<{
        time: string;
        ts: number;
        user: string;
        userId: string;
        content: string;
        messageId: string;
        mentionUserIds: string[];
    }>;
}
interface LifecycleContext {
    bots?: unknown[];
    bot?: unknown;
    on(event: 'ready' | 'dispose', handler: () => unknown): void;
    logger(name: string): {
        info(message: string): void;
        warn(message: string): void;
    };
}
interface LifecycleAgentEngine {
    run: typeof import('../agent/engine').run;
}
interface PluginLifecycleOptions {
    agentEngine?: LifecycleAgentEngine | null;
    configureAgentQueue?: (queueConfig: unknown) => void;
}
declare function restoreTodayCacheEntry(key: string, data: TodayCacheSnapshot | null | undefined): void;
declare function restoreTodayCache(): void;
declare function registerPluginLifecycle(ctx: LifecycleContext, options?: PluginLifecycleOptions): void;
declare const _default: {
    restoreTodayCacheEntry: typeof restoreTodayCacheEntry;
    restoreTodayCache: typeof restoreTodayCache;
    registerPluginLifecycle: typeof registerPluginLifecycle;
};
export = _default;
