interface CoverageItemLike extends Record<string, unknown> {
    file?: string;
    updatedAt?: string;
}
type DailyFinalInputLike = Record<string, unknown>;
declare function listDailyCoverage(limit?: number): CoverageItemLike[];
declare function readDailyFinalInput(date: string, channelKey: string): DailyFinalInputLike | null;
declare function getPrecomputeSummary(): Record<string, unknown>;
declare const _default: {
    PRECOMPUTE_ROOT: string;
    INDEX_ROOT: string;
    COVERAGE_ROOT: string;
    SLOTS_ROOT: string;
    FINAL_INPUT_ROOT: string;
    listDailyCoverage: typeof listDailyCoverage;
    readDailyFinalInput: typeof readDailyFinalInput;
    getPrecomputeSummary: typeof getPrecomputeSummary;
};
export = _default;
