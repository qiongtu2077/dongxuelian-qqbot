/**
 * MODULE: Agent 搜索查询规划。
 * 职责: 规范化用户显式搜索请求，生成更可靠的搜索 query 和结果可信度排序。
 * 边界: 不执行联网搜索、不调用浏览器、不调用 AI API。
 * 状态: 无。
 */
interface SearchCandidate {
    title?: string;
    url?: string;
    snippet?: string;
    text?: string;
}
type ScoredSearchCandidate<T extends SearchCandidate> = T & {
    score: number;
};
declare function cleanExplicitSearchQuery(text?: unknown): string;
declare function isWuwaLatestRoleQuery(query?: unknown): boolean;
declare function isMinecraftUpdateQuery(query?: unknown): boolean;
declare function isHotVideoQuery(query?: unknown): boolean;
declare function isResourceVideoQuery(query?: unknown): boolean;
declare function buildSearchQueries(rawQuery?: unknown): string[];
declare function getDirectSearchCandidates(query?: unknown): SearchCandidate[];
declare function getSearchHostname(url?: unknown): string;
declare function scoreSearchResult(item?: SearchCandidate, query?: string): number;
declare function isLowQualitySearchResult(item?: SearchCandidate): boolean;
declare function sortSearchResults<T extends SearchCandidate>(results?: T[], query?: string): Array<ScoredSearchCandidate<T>>;
declare const _default: {
    cleanExplicitSearchQuery: typeof cleanExplicitSearchQuery;
    buildSearchQueries: typeof buildSearchQueries;
    getDirectSearchCandidates: typeof getDirectSearchCandidates;
    isWuwaLatestRoleQuery: typeof isWuwaLatestRoleQuery;
    isMinecraftUpdateQuery: typeof isMinecraftUpdateQuery;
    isHotVideoQuery: typeof isHotVideoQuery;
    isResourceVideoQuery: typeof isResourceVideoQuery;
    getSearchHostname: typeof getSearchHostname;
    scoreSearchResult: typeof scoreSearchResult;
    isLowQualitySearchResult: typeof isLowQualitySearchResult;
    sortSearchResults: typeof sortSearchResults;
};
export = _default;
