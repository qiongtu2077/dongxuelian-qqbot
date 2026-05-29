/**
 * MODULE: 聊天质量分析器。
 * 职责: 分析群聊氛围，生成质量锐评。
 * 边界: 只做分析，不调API，通过 aiClient.callAI 间接调用。
 */
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
