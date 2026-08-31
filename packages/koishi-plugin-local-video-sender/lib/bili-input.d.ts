export interface RedirectResponse {
    statusCode: number;
    location: string;
}
interface ResolvedHost {
    address: string;
    family: number;
}
export type ShortLinkFailureCode = 'dns_empty' | 'dns_private_address' | 'request_timeout' | 'request_failed' | 'http_not_redirect' | 'missing_location' | 'redirect_limit' | 'redirect_outside_allowlist' | 'final_url_not_bv';
export type ShortLinkResolutionResult = {
    ok: true;
    p1Url: string;
    hops: number;
} | {
    ok: false;
    code: ShortLinkFailureCode;
    hops: number;
    statusCode?: number;
};
export interface ShortLinkHopEvent {
    hop: number;
    statusCode?: number;
    finalHost: string;
    finalPath: string;
    failureCode?: ShortLinkFailureCode;
    elapsedMs: number;
}
export interface ShortLinkResolutionOptions {
    lookup?: (hostname: string) => Promise<ResolvedHost[]>;
    requestRedirect?: (input: string, timeoutMs: number, destination: ResolvedHost) => Promise<RedirectResponse>;
    now?: () => number;
    onHop?: (event: ShortLinkHopEvent) => void;
}
export interface ResolvedBiliInput {
    keys: string[];
    p1Url: string;
    shortLink?: ShortLinkResolutionResult;
}
export interface ResolveBiliInputOptions {
    url: string;
    source: string;
    resolveShortLink?: typeof resolveBiliShortLink;
    onShortLinkHop?: (event: ShortLinkHopEvent) => void;
    onError?: (failure: Extract<ShortLinkResolutionResult, {
        ok: false;
    }>) => void;
}
export declare function normalizeSharedText(input?: string): string;
export declare function uniqueStrings(values?: unknown[]): string[];
export declare function isBilibiliCardInput(input?: string): boolean;
export declare function extractBiliUrl(input?: string): string | null;
export declare function buildBiliKeys(input?: string): string[];
export declare function extractBvId(input?: string): string;
export declare function normalizeBiliP1Url(input?: string): string;
export declare function isAllowedBiliRedirectUrl(input: string): boolean;
export declare function isPrivateIpAddress(address: string): boolean;
export declare function resolveBiliShortLink(input: string, options?: ShortLinkResolutionOptions): Promise<ShortLinkResolutionResult>;
export declare function resolveBiliInput(options: ResolveBiliInputOptions): Promise<ResolvedBiliInput>;
export declare function getBiliInputCacheSize(): number;
export declare function clearBiliInputCache(): void;
export {};
