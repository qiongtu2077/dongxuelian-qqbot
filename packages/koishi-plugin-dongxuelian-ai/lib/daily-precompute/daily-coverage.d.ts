declare function readDailyCoverage(date: string, channelKey: string): Record<string, unknown>;
declare function refreshDailyCoverage(date: string, channelKey: string): Record<string, unknown>;
declare const _default: {
    readDailyCoverage: typeof readDailyCoverage;
    refreshDailyCoverage: typeof refreshDailyCoverage;
};
export = _default;
