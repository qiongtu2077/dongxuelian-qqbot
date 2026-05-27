interface SearchContext {
    searchReadiness?: unknown;
    queryCandidate?: unknown;
    recentUserMessages?: unknown;
    searchContext?: unknown;
    [key: string]: unknown;
}
interface RouterOptions extends SearchContext {
    recentUserMessages?: unknown;
    searchContext?: SearchContext | unknown;
}
interface HeuristicRouteResult {
    useAgent: boolean;
    reason: string;
}
interface AgentRunOptions {
    systemExtra?: Array<{
        role: 'system';
        content: string;
    }>;
    forceTools?: string[];
    preExecuteTools?: Array<{
        name: string;
        args: Record<string, unknown>;
    }>;
    agentUserMessage?: string;
}
declare function extractHttpUrls(text?: unknown): string[];
declare function extractSingleUrl(text?: unknown): string;
declare function isExplicitUrlFetchRequest(text?: unknown): boolean;
declare function getStructuredSearchContext(options?: RouterOptions | SearchContext): SearchContext;
declare function canUseStructuredSearchContext(context?: SearchContext): boolean;
declare function isStructuredSearchBlocked(context?: SearchContext): boolean;
declare function isExecutableSearchQuery(query?: unknown): boolean;
declare function isGeneralSearchIntent(text?: unknown): boolean;
declare function isSearchFollowUpRequest(text?: unknown): boolean;
declare function isSearchRefinementRequest(text?: unknown): boolean;
declare function hasSearchableRecentContext(recentUserMessages?: unknown): boolean;
declare function pickRecentSearchContext(current?: unknown, recentUserMessages?: unknown): string[];
declare function buildContextualSearchQuery(userText?: unknown, recentUserMessages?: unknown, options?: RouterOptions | SearchContext): string;
declare function buildSearchAgentUserMessage(userText?: unknown, recentUserMessages?: unknown, options?: RouterOptions | SearchContext): string;
declare function heuristicRoute(userText?: unknown, channel?: string, options?: RouterOptions): HeuristicRouteResult;
declare function buildExplicitUrlFetchRunOptions(userText?: unknown): AgentRunOptions;
declare function buildExplicitSearchRunOptions(userText?: unknown, options?: RouterOptions): AgentRunOptions;
declare const _default: {
    heuristicRoute: typeof heuristicRoute;
    buildExplicitSearchRunOptions: typeof buildExplicitSearchRunOptions;
    buildExplicitUrlFetchRunOptions: typeof buildExplicitUrlFetchRunOptions;
    buildContextualSearchQuery: typeof buildContextualSearchQuery;
    buildSearchAgentUserMessage: typeof buildSearchAgentUserMessage;
    isExecutableSearchQuery: typeof isExecutableSearchQuery;
    getStructuredSearchContext: typeof getStructuredSearchContext;
    canUseStructuredSearchContext: typeof canUseStructuredSearchContext;
    isStructuredSearchBlocked: typeof isStructuredSearchBlocked;
    extractHttpUrls: typeof extractHttpUrls;
    extractSingleUrl: typeof extractSingleUrl;
    isExplicitUrlFetchRequest: typeof isExplicitUrlFetchRequest;
    isGeneralSearchIntent: typeof isGeneralSearchIntent;
    isSearchFollowUpRequest: typeof isSearchFollowUpRequest;
    isSearchRefinementRequest: typeof isSearchRefinementRequest;
    isPreviousSearchContextQuestion: (text?: unknown) => boolean;
    hasSearchableRecentContext: typeof hasSearchableRecentContext;
    pickRecentSearchContext: typeof pickRecentSearchContext;
    isExplicitSearchRequest: (text?: unknown) => boolean;
};
export = _default;
