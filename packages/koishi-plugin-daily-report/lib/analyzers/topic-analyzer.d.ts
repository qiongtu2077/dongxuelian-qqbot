declare function analyzeTopics(aiClient: {
    callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
}, messages: Array<{
    time?: unknown;
    user?: unknown;
    content?: unknown;
}>): Promise<{
    topics: Array<{
        id: number;
        title: string;
        summary: string;
        participants: string[];
    }>;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}>;
declare const _default: {
    analyzeTopics: typeof analyzeTopics;
};
export = _default;
