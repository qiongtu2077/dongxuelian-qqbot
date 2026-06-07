interface ReportMessage {
    time?: string;
    user?: string;
    sender?: string;
    nickname?: string;
    userId?: string | number;
    content?: string;
}
interface TopMember {
    userId?: string | number;
    name?: string;
    msgCount?: number;
}
interface ReportData {
    totalMessages?: number;
    activeMembers?: number;
    emojiCount?: number;
    totalChars?: number;
    peakHour?: string;
    topMembers?: TopMember[];
    messages?: ReportMessage[];
    precomputedContext?: string;
    precomputedCoverageRate?: number;
}
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
interface GoldenQuote {
    content: string;
    sender: string;
    reason: string;
    userId: string;
}
interface UserTitle {
    name: string;
    userId: string;
    title: string;
    reason: string;
    mbti: string;
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
    meta?: AnalysisMeta;
}
interface AnalysisMeta {
    warnings: string[];
    stages: {
        compression: string;
        basic: string;
        full: string;
    };
}
interface BasicAnalysis {
    topics: Topic[];
    goldenQuotes: GoldenQuote[];
}
interface FullAnalysis extends BasicAnalysis {
    userTitles: UserTitle[];
    qualityReview: QualityReview;
}
declare function buildFallbackBasicAnalysis(data: ReportData | null | undefined): BasicAnalysis;
declare function buildFallbackFullAnalysis(data: ReportData | null | undefined): FullAnalysis;
declare function analyzeWithAI(data: ReportData, full?: boolean): Promise<AnalysisResult>;
declare const _default: {
    analyzeWithAI: typeof analyzeWithAI;
    buildFallbackFullAnalysis: typeof buildFallbackFullAnalysis;
    buildFallbackBasicAnalysis: typeof buildFallbackBasicAnalysis;
};
export = _default;
