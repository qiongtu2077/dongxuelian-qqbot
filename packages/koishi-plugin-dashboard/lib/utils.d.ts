import type { IncomingMessage, ServerResponse } from 'http';
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
type BodyCallback = (body: string) => void | Promise<void>;
declare function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number;
declare function json(res: ServerResponse, data: unknown, status?: number): void;
declare function log(msg: unknown): void;
declare function getRemoteAddress(req: IncomingMessage | null | undefined): string;
declare function isLoopbackAddress(address: unknown): boolean;
declare function shellQuote(value: unknown): string;
declare function commandQuote(value: unknown): string;
declare function isInsidePath(parent: string, child: string): boolean;
declare function sleepSync(ms: number): void;
declare function describeFsError(e: unknown, fallback?: string): string;
declare function pathConflictError(conflictPath: string, message?: string): FsError;
declare function isRetriableFsError(error: unknown): boolean;
declare function assertParentDirectories(targetPath: string): void;
declare function removePathWithRetry(targetPath: string, options?: RemovePathOptions): boolean;
declare function ensureCleanDirectory(dir: string): void;
declare function ensureWritableDir(dir: string): void;
declare function copyRecursiveSync(src: string, dst: string): void;
declare function listFilesRecursive(root: string, predicate?: (filePath: string) => boolean): string[];
declare function uniquePaths(paths: string[]): string[];
declare function readFileContent(p: string, maxBytes?: number): string;
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
declare function writeFileSyncSafe(p: string, content: unknown): void;
declare function readFileSyncSafe(p: string, maxBytes?: number): string;
declare function collectBody(req: IncomingMessage, res: ServerResponse, callback: BodyCallback, options?: CollectBodyOptions): void;
