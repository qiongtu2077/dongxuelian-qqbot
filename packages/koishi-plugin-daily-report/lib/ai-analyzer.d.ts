declare const createReportAnalysisDiagnostics: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis").createReportAnalysisDiagnostics;
type AnalysisRuntime = import('./complete-input').AnalysisRuntime;
interface AnalysisOptions {
    deadlineMs?: number;
    workDeadlineMs?: number;
    stageSoftDeadlinesMs?: AnalysisRuntime['stageSoftDeadlinesMs'];
    signal?: AbortSignal;
    now?: () => number;
    onProgress?: AnalysisRuntime['onProgress'];
}
interface ReportMessage {
    analysisId?: number;
    ts?: number;
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
    windowMessageCount?: number;
    sourceCompleteness?: AnalysisMeta['sourceCompleteness'];
    reportPeriod?: AnalysisMeta['reportPeriod'];
    periodBackfilled?: boolean;
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
type AnalysisMeta = ReturnType<typeof createReportAnalysisDiagnostics>;
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
declare function analyzeWithAI(data: ReportData, full?: boolean, options?: AnalysisOptions): Promise<AnalysisResult>;
declare const _default: {
    analyzeWithAI: typeof analyzeWithAI;
    buildFallbackFullAnalysis: typeof buildFallbackFullAnalysis;
    buildFallbackBasicAnalysis: typeof buildFallbackBasicAnalysis;
};
export = _default;
