interface SearchCandidate {
    title?: string;
    url?: string;
    snippet?: string;
    text?: string;
    score?: number;
}
interface SearchPage {
    text?: string;
}
declare function normalizeResultUrl(url?: unknown): string;
declare function hasQuerySignal(item?: SearchCandidate, query?: unknown): boolean;
declare function getResultDomainSignal(item?: SearchCandidate): boolean;
declare function normalizeSearchCandidate(item?: SearchCandidate): SearchCandidate;
declare function isUsefulSearchResult(item?: SearchCandidate, query?: unknown): boolean;
declare function rankSearchCandidates(candidates?: SearchCandidate[], query?: unknown, limit?: number): SearchCandidate[];
declare function formatSearchResults(query?: unknown, results?: SearchCandidate[]): string;
declare function buildSearchFailureText(query?: unknown, failures?: unknown[]): string;
declare function classifySearchResult(ranked?: SearchCandidate[], pages?: SearchPage[]): string;
declare function extractRetryKeywords(ranked?: SearchCandidate[], pages?: SearchPage[], originalQuery?: unknown): string[];
declare function detectFailurePattern(ranked?: SearchCandidate[], pages?: SearchPage[], allCandidates?: SearchCandidate[]): string;
declare function buildStrategyQueries(failurePattern: unknown, originalQuery: unknown, usedQueries: Set<string>): string[];
declare const _default: {
    normalizeResultUrl: typeof normalizeResultUrl;
    normalizeSearchCandidate: typeof normalizeSearchCandidate;
    isUsefulSearchResult: typeof isUsefulSearchResult;
    hasQuerySignal: typeof hasQuerySignal;
    getResultDomainSignal: typeof getResultDomainSignal;
    rankSearchCandidates: typeof rankSearchCandidates;
    formatSearchResults: typeof formatSearchResults;
    buildSearchFailureText: typeof buildSearchFailureText;
    classifySearchResult: typeof classifySearchResult;
    extractRetryKeywords: typeof extractRetryKeywords;
    detectFailurePattern: typeof detectFailurePattern;
    buildStrategyQueries: typeof buildStrategyQueries;
};
export = _default;
