interface WebSearchParams {
    query?: unknown;
    queries?: unknown;
    [key: string]: unknown;
}
interface SearchCandidate {
    title?: string;
    url?: string;
    snippet?: string;
    sourceType?: string;
}
interface FetchedSearchPage {
    ok: boolean;
    title?: string;
    url?: string;
    finalUrl?: string;
    status?: number;
    contentType?: string;
    text?: string;
    textQuality?: string;
    reason?: string;
    truncated?: boolean;
}
interface ApiSearchVerificationResult {
    ok: boolean;
    status: 'usable_hit' | 'weak_hit';
    text: string;
    candidates?: SearchCandidate[];
    pages?: FetchedSearchPage[];
    failures?: string[];
}
declare function extractUrlsFromSearchText(text?: unknown): string[];
declare function buildApiSearchCandidates(text?: unknown, query?: string): SearchCandidate[];
declare function verifyApiSearchWithFetch(apiText?: unknown, queries?: string[]): Promise<ApiSearchVerificationResult>;
declare function getAvailableMemoryMb(): number;
declare function getBrowserSearchBlockReason(): string;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                queries: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: WebSearchParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
    getAvailableMemoryMb: typeof getAvailableMemoryMb;
    getBrowserSearchBlockReason: typeof getBrowserSearchBlockReason;
    extractUrlsFromSearchText: typeof extractUrlsFromSearchText;
    buildApiSearchCandidates: typeof buildApiSearchCandidates;
    verifyApiSearchWithFetch: typeof verifyApiSearchWithFetch;
};
export = _default;
