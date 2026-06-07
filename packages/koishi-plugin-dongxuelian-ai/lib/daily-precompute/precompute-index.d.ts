interface PrecomputeIndexInput {
    date?: string;
    channelKey: string;
    messageId?: string;
    timestamp?: number;
    userId?: string;
    userName?: string;
    text?: string;
    media?: Array<Record<string, unknown>>;
}
interface PrecomputeRecord extends Record<string, unknown> {
    messageId: string;
    timestamp: number;
    userId: string;
    userName: string;
    text: string;
    media: Array<Record<string, unknown>>;
}
declare function precomputeEventFile(date?: Date): string;
declare function writePrecomputeEvent(event: string, data?: Record<string, unknown>): void;
declare function getPrecomputeIndexFile(date: string, channelKey: string): string;
declare function getPrecomputeCoverageFile(date: string, channelKey: string): string;
declare function appendPrecomputeIndex(input: PrecomputeIndexInput): PrecomputeRecord | null;
declare function readPrecomputeIndex(date: string, channelKey: string, limit?: number): PrecomputeRecord[];
declare function updatePrecomputeCoverage(date: string, channelKey: string): Record<string, unknown>;
declare const _default: {
    PRECOMPUTE_ROOT: string;
    INDEX_ROOT: string;
    COVERAGE_ROOT: string;
    precomputeEventFile: typeof precomputeEventFile;
    writePrecomputeEvent: typeof writePrecomputeEvent;
    getPrecomputeIndexFile: typeof getPrecomputeIndexFile;
    getPrecomputeCoverageFile: typeof getPrecomputeCoverageFile;
    appendPrecomputeIndex: typeof appendPrecomputeIndex;
    readPrecomputeIndex: typeof readPrecomputeIndex;
    updatePrecomputeCoverage: typeof updatePrecomputeCoverage;
};
export = _default;
