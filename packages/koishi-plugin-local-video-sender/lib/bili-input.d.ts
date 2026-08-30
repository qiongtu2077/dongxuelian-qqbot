interface RedirectResponse {
    statusCode: number;
    location: string;
}
export interface ResolvedBiliInput {
    keys: string[];
    p1Url: string;
}
export interface ResolveBiliInputOptions {
    url: string;
    source: string;
    resolveShortLink?: typeof resolveBiliShortLink;
    onError?: (message: string) => void;
}
export declare function normalizeSharedText(input?: string): string;
export declare function uniqueStrings(values?: unknown[]): string[];
export declare function extractBiliUrl(input?: string): string | null;
export declare function buildBiliKeys(input?: string): string[];
export declare function extractBvId(input?: string): string;
export declare function normalizeBiliP1Url(input?: string): string;
export declare function isAllowedBiliRedirectUrl(input: string): boolean;
export declare function isPrivateIpAddress(address: string): boolean;
declare function requestRedirectLocation(input: string, timeoutMs: number): Promise<RedirectResponse>;
export declare function resolveBiliShortLink(input: string, requestRedirect?: typeof requestRedirectLocation): Promise<string>;
export declare function resolveBiliInput(options: ResolveBiliInputOptions): Promise<ResolvedBiliInput>;
export declare function getBiliInputCacheSize(): number;
export declare function clearBiliInputCache(): void;
export {};
