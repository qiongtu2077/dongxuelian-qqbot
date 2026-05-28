type TextQuality = 'empty' | 'garbage' | 'short' | 'usable' | 'error';
interface DnsAddress {
    address: string;
    family: number;
}
interface FetchLimitInput {
    timeoutMs?: unknown;
    maxBytes?: unknown;
    maxChars?: unknown;
    redirects?: unknown;
}
interface FetchLimits {
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
    redirects: number;
}
interface HeadersLike {
    get?: (name: string) => string | null;
}
interface BodyReaderLike {
    read: () => Promise<{
        done?: boolean;
        value?: Uint8Array;
    }>;
    cancel: () => Promise<unknown> | unknown;
}
interface BodyLike {
    getReader?: () => BodyReaderLike;
}
interface ResponseLike {
    headers?: HeadersLike;
    body?: BodyLike | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    text?: () => Promise<string>;
    status?: number;
    url?: string;
    ok?: boolean;
}
interface ResponseBytesResult {
    bytes: Buffer;
    truncated: boolean;
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
interface CandidateTextQuality {
    textQuality: TextQuality;
    reason: string;
    reliable: boolean;
}
interface ClassifyCandidateOptions {
    minTextChars?: unknown;
}
interface ReadCandidatePageOptions extends FetchLimitInput {
    limits?: FetchLimits;
    extractText?: (body: string, maxChars: number, page: FetchPage) => string;
    minTextChars?: unknown;
}
interface ReadCandidatePageResult extends FetchPage {
    ok: boolean;
    url: string;
    text: string;
    textQuality: TextQuality;
    reason: string;
    reliable: boolean;
    error?: string;
}
declare function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number;
declare function getFetchLimits(params?: FetchLimitInput): FetchLimits;
declare function getResponseHeader(response: ResponseLike, name: string): string;
declare function isAllowedContentType(contentType?: unknown): boolean;
declare function normalizeCharset(charset?: unknown): string;
declare function decodeBytes(bytes?: Uint8Array, contentType?: unknown): string;
declare function readResponseBytesLimited(response: ResponseLike, maxBytes: number): Promise<ResponseBytesResult>;
declare function extractTitle(html?: unknown): string;
declare function isLikelyGarbagePageText(text?: unknown): boolean;
declare function classifyCandidateText(text?: unknown, page?: Partial<FetchPage>, options?: ClassifyCandidateOptions): CandidateTextQuality;
declare function defaultExtractCandidateText(body?: unknown, maxChars?: number): string;
declare function readCandidatePage(rawUrl: unknown, options?: ReadCandidatePageOptions): Promise<ReadCandidatePageResult>;
declare function fetchWithManualRedirect(rawUrl: unknown, limits?: FetchLimits): Promise<FetchPage>;
declare function fetchReadableUrl(rawUrl: unknown, params?: FetchLimitInput): Promise<FetchPage>;
declare const _default: {
    FETCH_READER_USER_AGENT: string;
    DEFAULT_TIMEOUT_MS: number;
    DEFAULT_MAX_BYTES: number;
    DEFAULT_MAX_CHARS: number;
    DEFAULT_REDIRECTS: number;
    DEFAULT_MIN_RELIABLE_TEXT_CHARS: number;
    parsePositiveInt: typeof parsePositiveInt;
    getFetchLimits: typeof getFetchLimits;
    normalizeHostname: (hostname?: unknown) => string;
    isPrivateHostname: (hostname?: unknown) => boolean;
    isPrivateIp: (ip?: unknown) => boolean;
    validatePublicHttpUrl: (rawUrl: unknown) => URL;
    resolveAndValidateHostname: (url: string | URL) => Promise<DnsAddress[]>;
    getResponseHeader: typeof getResponseHeader;
    isAllowedContentType: typeof isAllowedContentType;
    normalizeCharset: typeof normalizeCharset;
    decodeBytes: typeof decodeBytes;
    readResponseBytesLimited: typeof readResponseBytesLimited;
    extractTitle: typeof extractTitle;
    isLikelyGarbagePageText: typeof isLikelyGarbagePageText;
    classifyCandidateText: typeof classifyCandidateText;
    defaultExtractCandidateText: typeof defaultExtractCandidateText;
    fetchWithManualRedirect: typeof fetchWithManualRedirect;
    fetchReadableUrl: typeof fetchReadableUrl;
    readCandidatePage: typeof readCandidatePage;
};
export = _default;
