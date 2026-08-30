declare function analyzeChatQuality(aiClient: {
    callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
}, data: {
    totalMessages?: unknown;
    activeMembers?: unknown;
    peakHour?: unknown;
    emojiCount?: unknown;
}): Promise<{
    qualityReview: unknown;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}>;
declare const _default: {
    analyzeChatQuality: typeof analyzeChatQuality;
};
export = _default;
