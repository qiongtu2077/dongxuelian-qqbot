type ExpressionPoolStatus = 'candidate' | 'reviewed' | 'archived';
type AppendMode = 'created' | 'merged' | 'rejected';
interface ExpressionEntry {
    id: string;
    channelKey: string;
    situation: string;
    style: string;
    count: number;
    contributors: string[];
    status: ExpressionPoolStatus;
    createdAt: number;
    lastUsedAt: number;
    lastMergedAt: number;
}
interface ExpressionPool {
    entries: ExpressionEntry[];
    updatedAt: number;
    channelKey: string;
}
interface ExpressionCandidate {
    situation?: string;
    style?: string;
    contributors?: string[];
}
interface AppendOptions {
    now?: number;
    similarityThreshold?: number;
}
interface AppendResult {
    mode: AppendMode;
    reason?: string;
    entry: ExpressionEntry | null;
    score?: number;
}
declare function expressionPoolFilePath(channelKey: string): string;
declare function loadExpressionPool(channelKey: string): ExpressionPool;
declare function computeSituationStyleSimilarity(left?: Partial<ExpressionEntry>, right?: Partial<ExpressionEntry>): number;
declare function appendExpressionCandidate(channelKey: string, candidate: ExpressionCandidate, options?: AppendOptions): Promise<AppendResult>;
declare function archiveByContributor(channelKey: string, userId: string): Promise<{
    archived: number;
}>;
declare const _default: {
    EXPRESSION_POOL_STORE_VERSION: number;
    EXPRESSION_POOL_SIMILARITY_MERGE_THRESHOLD: number;
    EXPRESSION_POOL_MAX_ENTRIES_PER_CHANNEL: number;
    EXPRESSION_POOL_MIN_USE_COUNT: number;
    EXPRESSION_POOL_MAX_FILE_BYTES: number;
    EXPRESSION_POOL_MAX_CONTRIBUTORS: number;
    EXPRESSION_POOL_MAX_TEXT_LEN: number;
    EXPRESSION_POOL_STATUS: Readonly<Record<ExpressionPoolStatus, ExpressionPoolStatus>>;
    EXPRESSION_POOL_APPEND_MODES: Readonly<Record<AppendMode, AppendMode>>;
    loadExpressionPool: typeof loadExpressionPool;
    appendExpressionCandidate: typeof appendExpressionCandidate;
    archiveByContributor: typeof archiveByContributor;
    computeSituationStyleSimilarity: typeof computeSituationStyleSimilarity;
    expressionPoolSafeChannelKey: (value?: string) => string;
    expressionPoolFilePath: typeof expressionPoolFilePath;
};
export = _default;
