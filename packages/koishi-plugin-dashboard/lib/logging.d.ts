interface LoggingConfig {
    enabled?: unknown;
    debug?: unknown;
    updatedAt?: unknown;
    modules?: Record<string, unknown>;
}
interface NormalizedLoggingConfig {
    enabled: boolean;
    updatedAt: unknown;
    modules: Record<string, boolean>;
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
interface FilteredLogEntries {
    entries: LogEntry[];
    lines: string[];
    total: number;
    limit: number;
    file: string;
    config: NormalizedLoggingConfig;
    filterKey: string;
    filterChanged: boolean;
    lastId: number;
    newEntries: LogEntry[];
    newCount: number;
    truncated: boolean;
}
declare function normalizeLoggingConfig(input?: LoggingConfig): NormalizedLoggingConfig;
declare function readLoggingConfig(): NormalizedLoggingConfig;
declare function writeLoggingConfig(data: LoggingConfig): NormalizedLoggingConfig;
declare function clampLogLimit(value: unknown): number;
declare function readLastLogItems(file: string, limit?: unknown): RawLogItem[];
declare function readLastLogLines(file: string, limit: unknown): string[];
declare function classifyLogLevel(line?: string): string;
declare function detectLogModule(line?: string): string;
declare function parseLogLine(item: RawLogItem | string, index: number): LogEntry;
declare function getFilteredLogEntries(options?: LogFilterOptions): FilteredLogEntries;
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
