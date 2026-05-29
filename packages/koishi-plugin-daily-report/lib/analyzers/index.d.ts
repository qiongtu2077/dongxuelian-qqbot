declare const _default: {
    analyzeTopics: (aiClient: {
        callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
    }, messages: Array<{
        time?: unknown;
        user?: unknown;
        content?: unknown;
    }>) => Promise<{
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
    analyzeUserTitles: (aiClient: {
        callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
    }, messages: Array<{
        userId?: unknown;
        user?: unknown;
        content?: unknown;
    }>, topMembers: Array<{
        userId: string;
        name: string;
        msgCount: number;
    }>) => Promise<{
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
    analyzeGoldenQuotes: (aiClient: {
        callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
    }, messages: Array<{
        time?: unknown;
        user?: unknown;
        content?: unknown;
    }>) => Promise<{
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
    analyzeChatQuality: (aiClient: {
        callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>;
    }, data: {
        totalMessages?: unknown;
        activeMembers?: unknown;
        peakHour?: unknown;
        emojiCount?: unknown;
    }) => Promise<{
        qualityReview: unknown;
        tokenUsage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
    }>;
};
export = _default;
