/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */
interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
interface Topic {
    id: number;
    title: string;
    summary: string;
    participants: string[];
}
interface UserTitle {
    name: string;
    userId: string;
    title: string;
    reason: string;
    mbti: string;
}
interface GoldenQuote {
    content: string;
    sender: string;
    reason: string;
    userId: string;
}
interface QualityDimension {
    name: string;
    percentage: number;
    comment: string;
    color: string;
}
interface QualityReview {
    title: string;
    subtitle: string;
    dimensions: QualityDimension[];
    summary: string;
}
interface AnalysisResult {
    topics: Topic[];
    userTitles: UserTitle[];
    goldenQuotes: GoldenQuote[];
    qualityReview: QualityReview | null;
    tokenUsage: TokenUsage;
    meta?: unknown;
}
/**
 * 创建默认的分析结果
 */
declare function createDefaultAnalysisResult(): AnalysisResult;
/**
 * 创建话题对象
 */
declare function createTopic(id: number, title: string, summary: string, participants: string[]): Topic;
/**
 * 创建用户称号对象
 */
declare function createUserTitle(name: string, userId: string, title: string, reason: string, mbti?: string): UserTitle;
/**
 * 创建金句对象
 */
declare function createGoldenQuote(content: string, sender: string, reason: string, userId?: string): GoldenQuote;
declare const _default: {
    createDefaultAnalysisResult: typeof createDefaultAnalysisResult;
    createTopic: typeof createTopic;
    createUserTitle: typeof createUserTitle;
    createGoldenQuote: typeof createGoldenQuote;
};
export = _default;
