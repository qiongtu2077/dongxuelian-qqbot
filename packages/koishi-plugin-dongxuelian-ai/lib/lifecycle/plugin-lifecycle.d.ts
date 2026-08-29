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
interface LifecycleBotLike {
    selfId?: string;
    userId?: string;
    sendPrivateMessage?: (target: string, content: string) => Promise<unknown> | unknown;
    sendMessage?: (target: string, content: unknown) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (target: string, segments: unknown) => Promise<unknown> | unknown;
        sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown;
    };
}
interface LifecycleLoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
interface LifecycleContext {
    bots?: LifecycleBotLike[];
    bot?: LifecycleBotLike | null;
    on(event: 'ready' | 'dispose', handler: () => unknown): void;
    logger(name: string): LifecycleLoggerLike;
}
interface LifecycleAgentEngine {
    run: typeof import('../agent/engine').run;
}
interface PluginLifecycleOptions {
    agentEngine?: LifecycleAgentEngine | null;
    configureAgentQueue?: (queueConfig: unknown) => void;
    chat?: unknown;
    retellAgentResult?: unknown;
}
interface StartupRecoveryState {
    pid: number;
    bootId: string;
    startedAt: string;
}
declare function restoreTodayCacheEntry(key: string, data: TodayCacheSnapshot | null | undefined): void;
declare function restoreTodayCache(): void;
declare function readLinuxBootId(): string;
declare function classifyStartupRecovery(previous: StartupRecoveryState | null, currentBootId: string): string;
declare function discardInterruptedRuntimeState(bootId?: string): Record<string, unknown>;
declare function registerPluginLifecycle(ctx: LifecycleContext, options?: PluginLifecycleOptions): void;
declare const _default: {
    LINUX_BOOT_ID_FILE: string;
    STARTUP_RECOVERY_STATE_FILE: any;
    restoreTodayCacheEntry: typeof restoreTodayCacheEntry;
    restoreTodayCache: typeof restoreTodayCache;
    readLinuxBootId: typeof readLinuxBootId;
    classifyStartupRecovery: typeof classifyStartupRecovery;
    discardInterruptedRuntimeState: typeof discardInterruptedRuntimeState;
    registerPluginLifecycle: typeof registerPluginLifecycle;
};
export = _default;
