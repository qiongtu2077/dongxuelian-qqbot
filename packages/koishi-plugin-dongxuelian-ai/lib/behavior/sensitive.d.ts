interface SensitiveSession {
    userId?: string;
    author?: {
        id?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
    };
    send(message: string): Promise<unknown>;
}
interface SensitiveAnalyzed {
    hasVisual?: boolean;
}
interface SensitiveParams {
    inGuild?: boolean;
    channelKey?: string;
    analyzed?: SensitiveAnalyzed;
    plain?: string;
    userName?: string;
    currentUserId?: string;
    lastEmotionCache?: {
        delete(key: string): unknown;
    };
}
interface SensitiveCounterEntry {
    count: number;
    ts: number;
}
declare function getPoliticalDetectList(): Promise<Set<string>>;
declare function resetPoliticalDetectCache(): void;
declare function clearSensitiveRuntimeState(channelKey: string): void;
declare function trimSensitiveRuntimeMaps(now?: number): void;
declare function notifySensitiveHandlers(session: SensitiveSession, channelKey: string, options?: {
    throttle?: boolean;
    message?: string;
}): Promise<boolean>;
declare function handleSensitiveMessage(session: SensitiveSession, ctx: unknown, params?: SensitiveParams): Promise<{
    isDetectOn: boolean;
}>;
declare const _default: {
    getPoliticalDetectList: typeof getPoliticalDetectList;
    resetPoliticalDetectCache: typeof resetPoliticalDetectCache;
    clearSensitiveRuntimeState: typeof clearSensitiveRuntimeState;
    trimSensitiveRuntimeMaps: typeof trimSensitiveRuntimeMaps;
    notifySensitiveHandlers: typeof notifySensitiveHandlers;
    handleSensitiveMessage: typeof handleSensitiveMessage;
    channelMsgCount: Map<string, SensitiveCounterEntry>;
    lastSensitiveAlert: Map<string, number>;
};
export = _default;
