interface LearningMessage {
    role?: string;
    userId?: string;
    content?: string;
    ts?: number;
    messageId?: string;
    mentionUserIds?: Array<string | number>;
}
interface LearningOptions {
    repeatWindowMs?: number;
    repeatMinUsers?: number;
    sensitiveTopicWindowMs?: number;
    selfUserIds?: string[];
    botUserIds?: string[];
    botName?: string;
}
interface FilteredLearningMessage {
    userId: string;
    content: string;
    ts: number | null;
    messageId: string;
    mentionUserIds: string[];
}
interface FilterExpressionResult {
    kept: FilteredLearningMessage[];
    skipped: Record<string, number>;
    total: number;
}
declare function filterExpressionLearningMessages(messages?: LearningMessage[], options?: LearningOptions): FilterExpressionResult;
declare const _default: {
    EXPRESSION_LEARNER_VERSION: number;
    EXPRESSION_LEARNER_SKIP_REASONS: Readonly<{
        selfBot: "selfBot";
        emptyText: "emptyText";
        hasImageOrEmoji: "hasImageOrEmoji";
        mentionsBot: "mentionsBot";
        sensitiveKeyword: "sensitiveKeyword";
        repeatWindow: "repeatWindow";
        sensitiveTopicWindow: "sensitiveTopicWindow";
    }>;
    EXPRESSION_LEARNER_REPEAT_WINDOW_MS: number;
    EXPRESSION_LEARNER_REPEAT_MIN_USERS: number;
    EXPRESSION_LEARNER_SENSITIVE_TOPIC_WINDOW_MS: number;
    EXPRESSION_LEARNER_SENSITIVE_TOPIC_KEYWORDS: readonly string[];
    filterExpressionLearningMessages: typeof filterExpressionLearningMessages;
};
export = _default;
