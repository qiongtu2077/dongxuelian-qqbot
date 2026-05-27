interface FileEntry {
    fileName: string;
    fileSize: number;
    mimeType: string;
    ext: string;
    url: string;
    fileId: string | null;
    conversationKey: string;
    userId: string;
    ts: number;
    skipped: boolean;
    skipReason: string | null;
    analyzed: boolean;
    analysis: string | null;
    localPath: string | null;
}
interface StoredFileInfo {
    fileName?: unknown;
    fileSize?: unknown;
    mimeType?: unknown;
    ext?: unknown;
    url?: unknown;
    fileId?: unknown;
    conversationKey?: unknown;
    userId?: unknown;
    skipped?: unknown;
    skipReason?: unknown;
}
interface RecentFile extends FileEntry {
    messageId: string;
}
declare function storeFile(channelKey: string, messageId: string, fileInfo: StoredFileInfo): Promise<boolean>;
declare function getFileEntry(channelKey: string, messageId: string): Promise<FileEntry | null>;
declare function markFileAnalyzed(channelKey: string, messageId: string, analysis: unknown): Promise<boolean>;
declare function markFileSkipped(channelKey: string, messageId: string, reason: unknown): Promise<boolean>;
declare function setLocalPath(channelKey: string, messageId: string, localPath: string): Promise<boolean>;
declare function getRecentFiles(channelKey: string, limit?: number): Promise<RecentFile[]>;
declare function getRecentFilesCached(channelKey: string, limit?: number): RecentFile[];
declare function cacheFileLocally(channelKey: string, messageId: string, buffer: Buffer, ext: string): Promise<string | null>;
declare const _default: {
    storeFile: typeof storeFile;
    getFileEntry: typeof getFileEntry;
    markFileAnalyzed: typeof markFileAnalyzed;
    markFileSkipped: typeof markFileSkipped;
    setLocalPath: typeof setLocalPath;
    getRecentFiles: typeof getRecentFiles;
    getRecentFilesCached: typeof getRecentFilesCached;
    cacheFileLocally: typeof cacheFileLocally;
    FILE_HISTORY_DIR: string;
    FILE_CACHE_DIR: string;
};
export = _default;
