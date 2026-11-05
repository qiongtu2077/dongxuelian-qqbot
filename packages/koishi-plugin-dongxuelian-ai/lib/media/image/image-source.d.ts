interface ImageReadResult {
    dataUrl: string | null;
    reason: string;
    bytes?: number;
    mime?: string;
    width?: number;
    height?: number;
    animated?: boolean;
}
declare function readImageSourceResult(channelKey: string, messageId: string, signal?: AbortSignal): Promise<ImageReadResult>;
declare function readImageSource(channelKey: string, messageId: string): Promise<string | null>;
declare function cleanupImageSourceLocks(): Promise<number>;
declare const _default: {
    readImageSource: typeof readImageSource;
    readImageSourceResult: typeof readImageSourceResult;
    cleanupImageSourceLocks: typeof cleanupImageSourceLocks;
};
export = _default;
