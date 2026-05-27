declare function enqueueFileAnalysis(channelKey: string, messageId: string): Promise<void>;
declare function downloadFile(url: string, destPath: string, redirectCount?: number): Promise<string>;
declare function analyzeFileNow(channelKey: string, messageId: string): Promise<string | null>;
declare const _default: {
    enqueueFileAnalysis: typeof enqueueFileAnalysis;
    analyzeFileNow: typeof analyzeFileNow;
    downloadFile: typeof downloadFile;
};
export = _default;
