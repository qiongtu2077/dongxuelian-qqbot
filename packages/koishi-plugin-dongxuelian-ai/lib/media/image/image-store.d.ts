interface ImageEntry {
    url: string;
    file: string | null;
    conversationKey: string;
    userId: string;
    ts: number;
    analyzed: boolean;
    analysis: string | null;
    sourceRole: 'assistant' | 'user';
    sentByBot: boolean;
    analysisStatus: string;
    analysisKind: string;
}
interface RecentImage extends ImageEntry {
    messageId: string;
}
interface ImageMeta {
    conversationKey?: unknown;
    userId?: unknown;
    sourceRole?: unknown;
    sentByBot?: unknown;
    url?: unknown;
    file?: unknown;
    ts?: unknown;
}
interface StorageCleanupResult {
    channels: number;
    removedRecords: number;
    removedFiles: number;
}
declare function storeImageUrl(channelKey: string, messageId: string, url: unknown, file: unknown, meta?: ImageMeta): Promise<boolean>;
declare function getImageEntry(channelKey: string, messageId: string): Promise<ImageEntry | null>;
declare function getRecentImages(channelKey: string, limit?: number): Promise<RecentImage[]>;
declare function getRecentImagesCached(channelKey: string, limit?: number): RecentImage[];
declare function markAnalyzed(channelKey: string, messageId: string, analysis: unknown): Promise<boolean>;
declare function markAnalysisUnavailable(channelKey: string, messageId: string, status?: string): Promise<boolean>;
declare function markAnalysisPending(channelKey: string, messageId: string, isStillQueued?: () => boolean): Promise<boolean>;
declare function finishImageAnalysisStatus(channelKey: string, messageId: string, status: 'completed' | 'failed' | 'cancelled', canFinish: () => boolean): Promise<boolean>;
declare function storeAssistantImageAnchor(channelKey: string, messageId: string, meta?: ImageMeta): Promise<boolean>;
declare function isAlreadyAnalyzed(channelKey: string, messageId: string): Promise<boolean>;
declare function getCachedAnalysis(channelKey: string, messageId: string): Promise<string | null>;
declare function replaceImagePlaceholder(channelKey: string, messageId: string, analysis: string): Promise<boolean>;
declare function cacheImageFile(channelKey: string, messageId: string, buffer: Buffer): Promise<string | null>;
declare function readCachedImage(channelKey: string, messageId: string): Promise<string | null>;
declare function enforceChannelCacheLimit(channelKey: string): Promise<void>;
declare function cleanupImageStorage(): Promise<StorageCleanupResult>;
declare const _default: {
    storeImageUrl: typeof storeImageUrl;
    getImageEntry: typeof getImageEntry;
    getRecentImages: typeof getRecentImages;
    getRecentImagesCached: typeof getRecentImagesCached;
    finishImageAnalysisStatus: typeof finishImageAnalysisStatus;
    markAnalyzed: typeof markAnalyzed;
    markAnalysisUnavailable: typeof markAnalysisUnavailable;
    markAnalysisPending: typeof markAnalysisPending;
    storeAssistantImageAnchor: typeof storeAssistantImageAnchor;
    isAlreadyAnalyzed: typeof isAlreadyAnalyzed;
    getCachedAnalysis: typeof getCachedAnalysis;
    replaceImagePlaceholder: typeof replaceImagePlaceholder;
    cacheImageFile: typeof cacheImageFile;
    readCachedImage: typeof readCachedImage;
    enforceChannelCacheLimit: typeof enforceChannelCacheLimit;
    cleanupImageStorage: typeof cleanupImageStorage;
    IMAGE_HISTORY_DIR: string;
    IMAGE_CACHE_DIR: string;
};
export = _default;
