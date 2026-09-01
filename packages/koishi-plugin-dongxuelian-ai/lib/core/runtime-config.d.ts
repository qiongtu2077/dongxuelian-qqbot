interface RuntimeConfig {
    apiKey: string;
    model: string;
    baseURL: string;
    searchEnabled: boolean;
    provider: string;
    capability?: string;
    chatProtocol?: string;
    priorityIndex?: number;
    _originalConfig?: Pick<RuntimeConfig, 'model' | 'provider' | 'baseURL' | 'apiKey'>;
    _fallbackTried?: number;
    _isOriginalRetry?: boolean;
    [key: string]: unknown;
}
type ThinkingArgs = Record<string, unknown>;
declare function getAdminUserIds(force?: boolean): Set<string>;
declare function isAdminUserId(userId: string): boolean;
declare function getThinkingArgs(config: RuntimeConfig): ThinkingArgs;
declare function loadCapabilityConfig(capability: string, force?: boolean): Promise<RuntimeConfig>;
declare function loadConfig(force?: boolean): Promise<RuntimeConfig>;
declare function resetConfigCache(): void;
declare function getThinkingEnabled(): boolean;
declare function setThinkingEnabled(value: boolean): void;
declare const _default: {
    loadConfig: typeof loadConfig;
    loadCapabilityConfig: typeof loadCapabilityConfig;
    resetConfigCache: typeof resetConfigCache;
    getThinkingArgs: typeof getThinkingArgs;
    getAdminUserIds: typeof getAdminUserIds;
    isAdminUserId: typeof isAdminUserId;
    getThinkingEnabled: typeof getThinkingEnabled;
    setThinkingEnabled: typeof setThinkingEnabled;
};
export = _default;
