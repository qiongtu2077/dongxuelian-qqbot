declare function enqueueAnalysis(channelKey: string, messageId: string): Promise<void>;
declare function analyzeImageNow(channelKey: string, messageId: string): Promise<string | null>;
declare const _default: {
    enqueueAnalysis: typeof enqueueAnalysis;
    analyzeImageNow: typeof analyzeImageNow;
};
export = _default;
