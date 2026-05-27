interface SearchSessionLike {
    guildId?: string;
    subtype?: string;
    isDirect?: boolean;
    channelId?: string;
    userId?: string;
}
interface SearchHistoryMessage {
    role?: string;
    content?: unknown;
    ts?: number;
    createdAt?: number;
    timestamp?: number;
}
interface PrivateSearchContextOptions {
    now?: number;
    currentText?: string;
}
interface SearchContextHint {
    text: string;
    ts: number;
    source: string;
    interrupted: boolean;
    metaTurn: boolean;
    confidence: 'hot' | 'warm_weak' | 'cold';
}
interface PrivateSearchContext {
    recentUserMessages: string[];
    searchContextHints: SearchContextHint[];
    searchReadiness: string;
    queryCandidate: string;
    gateReason: string;
    blockedReason: string;
}
declare function looksLikeActionOnlyFollowUp(text?: string): boolean;
declare function hasConcreteSearchSubject(text?: string): boolean;
declare function isPotentialSearchFollowUp(text?: string): boolean;
declare function buildPrivateSearchContext(session: SearchSessionLike, history?: SearchHistoryMessage[], options?: PrivateSearchContextOptions): PrivateSearchContext;
declare function mergeSearchContext(base?: Partial<PrivateSearchContext>, override?: Partial<PrivateSearchContext>): PrivateSearchContext;
declare const _default: {
    PRIVATE_ACTIVE_HOT_MS: number;
    PRIVATE_ACTIVE_WARM_MS: number;
    PRIVATE_ACTIVE_COLD_MS: number;
    buildPrivateSearchContext: typeof buildPrivateSearchContext;
    mergeSearchContext: typeof mergeSearchContext;
    hasConcreteSearchSubject: typeof hasConcreteSearchSubject;
    isPotentialSearchFollowUp: typeof isPotentialSearchFollowUp;
    looksLikeActionOnlyFollowUp: typeof looksLikeActionOnlyFollowUp;
};
export = _default;
