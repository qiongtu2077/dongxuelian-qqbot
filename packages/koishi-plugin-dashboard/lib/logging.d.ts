interface LoggingConfig {
    enabled?: unknown;
    debug?: unknown;
    updatedAt?: unknown;
    modules?: Record<string, unknown>;
}
interface LogFilterOptions {
    levels?: unknown;
    module?: unknown;
    q?: unknown;
    errorsOnly?: unknown;
    limit?: unknown;
    since?: unknown;
    filterKey?: unknown;
}
interface RawLogItem {
    id?: number;
    text?: string;
}
interface LogEntry {
    id: number;
    level: string;
    levelName: string;
    module: string;
    time: string;
    message: string;
    text: string;
}
declare function normalizeLoggingConfig(input?: LoggingConfig): {
    enabled: boolean;
    updatedAt: unknown;
    modules: {};
};
declare function readLoggingConfig(): {
    enabled: boolean;
    updatedAt: unknown;
    modules: {};
};
declare function writeLoggingConfig(data: LoggingConfig): {
    enabled: boolean;
    updatedAt: unknown;
    modules: {};
};
declare function clampLogLimit(value: any): number;
declare function readLastLogItems(file: any, limit?: any): RawLogItem[];
declare function readLastLogLines(file: any, limit: any): string[];
declare function classifyLogLevel(line?: string): "D" | "E" | "W" | "I";
declare function detectLogModule(line?: string): string;
declare function parseLogLine(item: RawLogItem | string, index: any): LogEntry;
declare function getFilteredLogEntries(options?: LogFilterOptions): {
    entries: LogEntry[];
    lines: string[];
    total: number;
    limit: number;
    file: any;
    config: {
        enabled: boolean;
        updatedAt: unknown;
        modules: {};
    };
    filterKey: string;
    filterChanged: boolean;
    lastId: number;
    newEntries: LogEntry[];
    newCount: number;
    truncated: boolean;
};
declare const _default: {
    normalizeLoggingConfig: typeof normalizeLoggingConfig;
    readLoggingConfig: typeof readLoggingConfig;
    writeLoggingConfig: typeof writeLoggingConfig;
    clampLogLimit: typeof clampLogLimit;
    readLastLogItems: typeof readLastLogItems;
    readLastLogLines: typeof readLastLogLines;
    classifyLogLevel: typeof classifyLogLevel;
    detectLogModule: typeof detectLogModule;
    parseLogLine: typeof parseLogLine;
    getFilteredLogEntries: typeof getFilteredLogEntries;
};
export = _default;
