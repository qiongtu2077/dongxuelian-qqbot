declare function loadRuntimeSettings(force?: boolean): Promise<void>;
declare function getRandomTriggerBaseRate(channelKey: string): number;
declare function getRandomWhitelistStatus(channelKey: string): boolean;
declare const _default: {
    randomWhitelistCache: Set<string>;
    randomRateCache: Map<string, number>;
    loadRuntimeSettings: typeof loadRuntimeSettings;
    getRandomTriggerBaseRate: typeof getRandomTriggerBaseRate;
    getRandomWhitelistStatus: typeof getRandomWhitelistStatus;
    getFileFingerprint: (filePath: string) => Promise<string>;
};
export = _default;
