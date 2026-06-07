interface Topic {
    title?: string;
    summary?: string;
    participants?: string[];
}
interface UserTitle {
    name?: string;
    userId?: string;
    title?: string;
    reason?: string;
    mbti?: string;
}
interface GoldenQuote {
    content?: string;
    sender?: string;
    reason?: string;
    userId?: string;
}
interface QualityDimension {
    name?: string;
    percentage?: number;
    comment?: string;
    color?: string;
}
interface QualityReview {
    title?: string;
    subtitle?: string;
    dimensions?: QualityDimension[];
    summary?: string;
}
interface TokenUsage {
    totalTokens?: number;
}
interface ReportData {
    date?: string;
    totalMessages?: number;
    activeMembers?: number;
    emojiCount?: number;
    totalChars?: number;
    peakHour?: string;
    hourlyActivity?: number[];
}
interface AnalysisResult {
    topics?: Topic[];
    userTitles?: UserTitle[];
    goldenQuotes?: GoldenQuote[];
    qualityReview?: QualityReview | null;
    tokenUsage?: TokenUsage;
}
interface RenderContext {
    taskId?: string;
    source?: string;
}
interface RenderMemoryStatus {
    availableMb: number | null;
    minMb: number;
    forced: boolean;
}
declare function assertEnoughMemoryForRender(): RenderMemoryStatus;
declare function assertRenderEnvironment(): void;
declare function renderHtmlToImage(htmlContent: string, context?: RenderContext): Promise<Buffer>;
declare function renderReport(data: ReportData, analysis: AnalysisResult, context?: RenderContext): Promise<Buffer>;
declare const _default: {
    renderReport: typeof renderReport;
    renderHtmlToImage: typeof renderHtmlToImage;
    assertRenderEnvironment: typeof assertRenderEnvironment;
    assertEnoughMemoryForRender: typeof assertEnoughMemoryForRender;
};
export = _default;
