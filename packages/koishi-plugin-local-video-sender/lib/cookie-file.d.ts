declare const fs: typeof import("fs");
export type CookieValidationResult = {
    ok: true;
    recordCount: number;
} | {
    ok: false;
    code: string;
    line?: number;
};
export type StrictBase64DecodeResult = {
    ok: true;
    buffer: Buffer;
} | {
    ok: false;
    code: 'invalid_base64' | 'file_too_large' | 'empty_file';
};
export interface BiliCookieHealth {
    ok: boolean;
    path: string;
    recordCount: number;
    size: number;
    mtimeMs: number;
    code: string;
}
export interface AtomicCookieWriteOptions {
    fsApi?: typeof fs;
    randomBytes?: (size: number) => Buffer;
}
export interface AtomicCookieWriteResult {
    path: string;
    size: number;
    recordCount: number;
    mode: number;
}
export declare const MAX_BILI_COOKIE_FILE_BYTES: number;
export declare function resolveBiliCookiePath(dataDir: string, envValue?: unknown): string;
export declare function validateNetscapeCookieFile(buffer: Buffer): CookieValidationResult;
export declare function decodeStrictBase64(input: unknown, maxBytes: number): StrictBase64DecodeResult;
export declare function getBiliCookieHealth(filePath: string): BiliCookieHealth;
export declare function clearBiliCookieHealthCache(): void;
export declare function replaceBiliCookieFileAtomic(filePath: string, buffer: Buffer, options?: AtomicCookieWriteOptions): AtomicCookieWriteResult;
export {};
