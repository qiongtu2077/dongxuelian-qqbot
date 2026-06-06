interface HttpSearchEndpoint {
    name: string;
    url: (query: string) => string;
}
interface HttpSearchLimitOptions {
    timeoutMs?: unknown;
    totalTimeoutMs?: unknown;
    maxBytes?: unknown;
    queryLimit?: unknown;
    pageLimit?: unknown;
    pageMaxBytes?: unknown;
    pageTextChars?: unknown;
}
interface HttpSearchLimits {
    timeoutMs: number;
    totalTimeoutMs: number;
    maxBytes: number;
    queryLimit: number;
    pageLimit: number;
    pageMaxBytes: number;
    pageTextChars: number;
}
interface SearchCandidate {
    title?: string;
    url?: string;
    snippet?: string;
    text?: string;
    score?: number;
    sourceType?: string;
}
interface OpenedSearchPage {
    title?: string;
    url?: string;
    finalUrl?: string;
    status?: number;
    contentType?: string;
    text?: string;
    textQuality?: string;
    reason?: string;
    truncated?: boolean;
    sourceType?: string;
    error?: string;
}
interface PageReadResult {
    pages: OpenedSearchPage[];
    failures: string[];
}
interface HttpSearchRunResult {
    ok: boolean;
    text: string;
    failures: string[];
    status: 'usable_hit' | 'weak_hit' | 'hard_fail';
    query?: string;
    engine?: string;
    pages?: OpenedSearchPage[];
    candidates?: SearchCandidate[];
}
interface SearchPassResult {
    usable: boolean;
    weak: boolean;
    text?: string;
    query?: string;
    engine?: string;
    pages: OpenedSearchPage[];
    ranked: SearchCandidate[];
    allCandidates: SearchCandidate[];
    score?: number;
}
declare function decodeHttpSearchEntities(value?: unknown): string;
declare function stripHttpSearchTags(html?: unknown): string;
declare function extractHttpPageText(html?: unknown, maxChars?: number): string;
declare function resolveHttpSearchUrl(rawUrl?: unknown, baseUrl?: string): string;
declare function extractHttpSearchCandidates(html?: unknown, baseUrl?: string): SearchCandidate[];
declare function readHttpResultPage(url: unknown, limits: HttpSearchLimits, remainingMs: number): Promise<OpenedSearchPage & {
    ok: boolean;
}>;
declare function fetchHttpResultPage(url: unknown, limits: HttpSearchLimits, remainingMs: number): Promise<string>;
declare function readTopResultPages(results: SearchCandidate[] | undefined, limits: HttpSearchLimits, startedAt: number): Promise<PageReadResult>;
declare function mergeHttpSearchCandidates(...groups: SearchCandidate[][]): SearchCandidate[];
declare function formatCandidateList(candidates?: SearchCandidate[]): string;
declare function formatSearchWithPages(query?: unknown, ranked?: SearchCandidate[], pageReads?: Partial<PageReadResult>): string;
declare function runHttpSearch(queries?: unknown[] | unknown, options?: HttpSearchLimitOptions): Promise<HttpSearchRunResult>;
declare function buildRetryQueries(keywords: unknown[] | undefined, originalQuery: unknown, usedQueries: Set<string>): string[];
declare function runSearchPass(queryList: string[], limits: HttpSearchLimits, startedAt: number, failures: string[]): Promise<SearchPassResult>;
declare const _default: {
    HTTP_SEARCH_ENDPOINTS: HttpSearchEndpoint[];
    decodeHttpSearchEntities: typeof decodeHttpSearchEntities;
    stripHttpSearchTags: typeof stripHttpSearchTags;
    resolveHttpSearchUrl: typeof resolveHttpSearchUrl;
    extractHttpSearchCandidates: typeof extractHttpSearchCandidates;
    extractHttpPageText: typeof extractHttpPageText;
    readHttpResultPage: typeof readHttpResultPage;
    fetchHttpResultPage: typeof fetchHttpResultPage;
    readTopResultPages: typeof readTopResultPages;
    mergeHttpSearchCandidates: typeof mergeHttpSearchCandidates;
    formatCandidateList: typeof formatCandidateList;
    formatSearchWithPages: typeof formatSearchWithPages;
    runHttpSearch: typeof runHttpSearch;
    runSearchPass: typeof runSearchPass;
    buildRetryQueries: typeof buildRetryQueries;
};
export = _default;
