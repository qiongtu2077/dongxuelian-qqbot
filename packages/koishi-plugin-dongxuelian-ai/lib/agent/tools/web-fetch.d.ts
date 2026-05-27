/**
 * MODULE: Agent web_fetch 工具。
 * 职责: 读取指定公开 http/https URL 的轻量正文，包含 SSRF/redirect/大小/超时防线。
 * 边界: 不执行 JavaScript、不启动浏览器、不改写 web_search 链路。
 * 状态: 无。
 */
interface WebFetchParams {
    url?: unknown;
    maxChars?: unknown;
    [key: string]: unknown;
}
interface WebFetchContext {
    channel?: string;
    channelKey?: string;
    userId?: string;
}
interface FetchLimits {
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
    redirects: number;
}
interface FetchPage {
    originalUrl: string;
    finalUrl: string;
    status: number;
    contentType: string;
    body: string;
    title: string;
    truncated: boolean;
}
interface FetchedPage {
    ok: boolean;
    body?: string;
    text?: string;
    reason?: string;
    originalUrl?: string;
    url?: string;
    finalUrl?: string;
    status?: number;
    contentType?: string;
    title?: string;
    textQuality?: string;
    truncated?: boolean;
}
interface WebFetchResult {
    ok: boolean;
    text: string;
    error?: string;
}
interface WebFetchRateLimitAllowed {
    allowed: true;
    key: string;
    remaining: number;
}
interface WebFetchRateLimitDenied {
    allowed: false;
    key: string;
    retryAfterMs: number;
    retryAfterSeconds: number;
}
type WebFetchRateLimitResult = WebFetchRateLimitAllowed | WebFetchRateLimitDenied;
declare function getResponseHeader(response: unknown, name: string): string;
declare function readResponseBytesLimited(response: unknown, maxBytes: number): Promise<{
    bytes: Buffer;
    truncated: boolean;
}>;
declare function checkWebFetchRateLimit(context?: WebFetchContext, now?: number): WebFetchRateLimitResult;
declare function resetWebFetchRateLimitForTests(): void;
declare function normalizeFetchedText(text?: string, contentType?: string, maxChars?: number): string;
declare function executeWebFetch(params?: WebFetchParams, context?: WebFetchContext): Promise<WebFetchResult>;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                url: {
                    type: string;
                    description: string;
                };
                maxChars: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute: typeof executeWebFetch;
    dangerous: boolean;
    defaultChannels: string[];
    parsePositiveInt: (value: unknown, fallback: number, min: number, max: number) => number;
    isPrivateHostname: (hostname?: unknown) => boolean;
    isPrivateIp: (ip?: unknown) => boolean;
    validatePublicHttpUrl: (url: unknown) => URL;
    resolveAndValidateHostname: (url: string | URL) => Promise<Array<{
        address: string;
        family: number;
    }>>;
    getResponseHeader: typeof getResponseHeader;
    readResponseBytesLimited: typeof readResponseBytesLimited;
    extractTitle: (html?: unknown) => string;
    normalizeFetchedText: typeof normalizeFetchedText;
    checkWebFetchRateLimit: typeof checkWebFetchRateLimit;
    resetWebFetchRateLimitForTests: typeof resetWebFetchRateLimitForTests;
    fetchWithManualRedirect: (url: unknown, limits?: FetchLimits) => Promise<FetchPage>;
    readCandidatePage: (url: unknown, options: {
        limits?: FetchLimits;
        maxChars?: number;
        minTextChars?: unknown;
        extractText?: (body: string, maxChars: number, page: FetchPage) => string;
    }) => Promise<FetchedPage>;
};
export = _default;
