declare function readImageSource(channelKey: string, messageId: string): Promise<string | null>;
declare function cleanupImageSourceLocks(): Promise<number>;
declare const _default: {
    readImageSource: typeof readImageSource;
    cleanupImageSourceLocks: typeof cleanupImageSourceLocks;
};
export = _default;
