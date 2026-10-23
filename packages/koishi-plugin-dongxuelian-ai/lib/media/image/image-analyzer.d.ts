interface ImageAnalysisOptions {
    source?: 'explicit-image' | 'random-image' | 'history-tool';
    question?: string;
    force?: boolean;
    randomAuthorization?: unknown;
}
declare function enqueueAnalysis(channelKey: string, messageId: string, options?: ImageAnalysisOptions): Promise<void>;
declare function analyzeImageNow(channelKey: string, messageId: string, options?: ImageAnalysisOptions): Promise<string | null>;
declare const _default: {
    enqueueAnalysis: typeof enqueueAnalysis;
    analyzeImageNow: typeof analyzeImageNow;
};
export = _default;
