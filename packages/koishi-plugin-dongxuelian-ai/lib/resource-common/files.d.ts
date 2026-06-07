interface ListJsonOptions {
    recursive?: boolean;
    maxFiles?: number;
}
declare function nowIso(): string;
declare function sanitizeId(value: unknown, fallback?: string): string;
declare function ensureDir(dir: string): void;
declare function writeJsonAtomic(file: string, data: unknown): void;
declare function readJsonFile<T = unknown>(file: string, fallback?: T | null, maxBytes?: number): T | null;
declare function appendJsonlEvent(file: string, event: Record<string, unknown>): void;
declare function listJsonFiles(dir: string, options?: ListJsonOptions): string[];
declare function removePath(target: string): boolean;
declare function renameFileAtomic(src: string, dst: string): boolean;
declare function readRecentJsonlEvents(dir: string, prefix: string, limit?: number): unknown[];
declare function isProcessAlive(pid: unknown): boolean;
declare const _default: {
    nowIso: typeof nowIso;
    sanitizeId: typeof sanitizeId;
    ensureDir: typeof ensureDir;
    writeJsonAtomic: typeof writeJsonAtomic;
    readJsonFile: typeof readJsonFile;
    appendJsonlEvent: typeof appendJsonlEvent;
    listJsonFiles: typeof listJsonFiles;
    removePath: typeof removePath;
    renameFileAtomic: typeof renameFileAtomic;
    readRecentJsonlEvents: typeof readRecentJsonlEvents;
    isProcessAlive: typeof isProcessAlive;
};
export = _default;
