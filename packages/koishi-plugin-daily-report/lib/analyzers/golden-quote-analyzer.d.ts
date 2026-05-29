declare function analyzeGoldenQuotes(aiClient: {
    callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
}, messages: Array<{
    time?: unknown;
    user?: unknown;
    content?: unknown;
}>): Promise<{
    goldenQuotes: Array<{
        content: string;
        sender: string;
        reason: string;
        userId: string;
    }>;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}>;
declare const _default: {
    analyzeGoldenQuotes: typeof analyzeGoldenQuotes;
};
export = _default;
