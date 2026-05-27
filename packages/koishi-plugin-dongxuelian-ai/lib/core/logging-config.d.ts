interface DebugLogConfig {
    enabled: boolean;
    debug: boolean;
    modules: Record<string, boolean>;
    updatedAt: number;
    source?: 'file' | 'env';
}
declare function normalizeDebugLogConfig(input?: Partial<DebugLogConfig> & {
    debug?: boolean;
}): DebugLogConfig;
declare function readDebugLogConfig(force?: boolean): DebugLogConfig;
declare function writeDebugLogConfig(input?: Partial<DebugLogConfig>): Promise<DebugLogConfig>;
declare function isDebugLogEnabled(moduleName?: string): boolean;
declare function logDebug(ctx: {
    logger?: (name: string) => {
        info?: (message: string) => void;
    };
} | null | undefined, moduleName: string, message: string): void;
declare const _default: {
    DEBUG_LOG_CONFIG_FILE: string;
    normalizeDebugLogConfig: typeof normalizeDebugLogConfig;
    readDebugLogConfig: typeof readDebugLogConfig;
    writeDebugLogConfig: typeof writeDebugLogConfig;
    isDebugLogEnabled: typeof isDebugLogEnabled;
    logDebug: typeof logDebug;
};
export = _default;
