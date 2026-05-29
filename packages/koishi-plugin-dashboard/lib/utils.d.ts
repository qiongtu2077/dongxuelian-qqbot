interface FsError extends Error {
    code?: string;
    path?: string;
}
interface RemovePathOptions {
    retries?: number;
    delayMs?: number;
}
interface CollectBodyOptions {
    maxBytes?: number;
}
declare function parsePositiveInt(value: any, fallback: any, min: any, max: any): any;
declare function json(res: any, data: any, status?: number): void;
declare function log(msg: any): void;
declare function getRemoteAddress(req: any): string;
declare function isLoopbackAddress(address: any): boolean;
declare function shellQuote(value: any): string;
declare function commandQuote(value: any): string;
declare function isInsidePath(parent: any, child: any): boolean;
declare function sleepSync(ms: any): void;
declare function describeFsError(e: unknown, fallback?: string): string;
declare function pathConflictError(conflictPath: any, message?: string): FsError;
declare function isRetriableFsError(error: unknown): boolean;
declare function assertParentDirectories(targetPath: any): void;
declare function removePathWithRetry(targetPath: any, options?: RemovePathOptions): boolean;
declare function ensureCleanDirectory(dir: any): void;
declare function ensureWritableDir(dir: any): void;
declare function copyRecursiveSync(src: any, dst: any): void;
declare function listFilesRecursive(root: any, predicate: any): any[];
declare function uniquePaths(paths: any): any;
declare function readFileContent(p: any, maxBytes?: number): any;
declare const _default: {
    parsePositiveInt: typeof parsePositiveInt;
    json: typeof json;
    log: typeof log;
    getRemoteAddress: typeof getRemoteAddress;
    isLoopbackAddress: typeof isLoopbackAddress;
    shellQuote: typeof shellQuote;
    commandQuote: typeof commandQuote;
    isInsidePath: typeof isInsidePath;
    sleepSync: typeof sleepSync;
    describeFsError: typeof describeFsError;
    pathConflictError: typeof pathConflictError;
    isRetriableFsError: typeof isRetriableFsError;
    assertParentDirectories: typeof assertParentDirectories;
    removePathWithRetry: typeof removePathWithRetry;
    ensureCleanDirectory: typeof ensureCleanDirectory;
    ensureWritableDir: typeof ensureWritableDir;
    copyRecursiveSync: typeof copyRecursiveSync;
    listFilesRecursive: typeof listFilesRecursive;
    uniquePaths: typeof uniquePaths;
    readFileContent: typeof readFileContent;
    collectBody: typeof collectBody;
    writeFileSyncSafe: typeof writeFileSyncSafe;
    readFileSyncSafe: typeof readFileSyncSafe;
};
export = _default;
declare function writeFileSyncSafe(p: any, content: any): void;
declare function readFileSyncSafe(p: any, maxBytes?: number): any;
declare function collectBody(req: any, res: any, callback: any, options?: CollectBodyOptions): void;
