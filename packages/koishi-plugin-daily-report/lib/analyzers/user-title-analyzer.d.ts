declare function analyzeUserTitles(aiClient: {
    callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
}, messages: Array<{
    userId?: unknown;
    user?: unknown;
    content?: unknown;
}>, topMembers: Array<{
    userId: string;
    name: string;
    msgCount: number;
}>): Promise<{
    userTitles: Array<{
        name: string;
        userId: string;
        title: string;
        reason: string;
        mbti: string;
    }>;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}>;
declare const _default: {
    analyzeUserTitles: typeof analyzeUserTitles;
};
export = _default;
