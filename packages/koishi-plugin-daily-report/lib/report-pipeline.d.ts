interface DailyReportPipelineOptions {
    taskId?: string;
    channelKey: unknown;
    detail?: boolean;
    outputDir: string;
    renderImage?: boolean;
    onStep?: (step: string) => unknown;
}
interface DailyReportPipelineResult extends Record<string, unknown> {
    ok: boolean;
    taskId: string;
    kind: string;
    level: string;
    mode: string;
    reason: string;
    textPath: string;
    imagePath: string | null;
    warnings: string[];
}
interface TopMemberLike {
    name?: string;
    msgCount?: number;
}
interface ReportDataLike {
    date?: string;
    totalMessages?: number;
    activeMembers?: number;
    emojiCount?: number;
    totalChars?: number;
    peakHour?: string;
    topMembers?: TopMemberLike[];
    messages?: unknown[];
    precomputedCoverageRate?: number;
}
interface AnalysisLike {
    topics?: Array<{
        title?: string;
        summary?: string;
    }>;
    goldenQuotes?: Array<{
        sender?: string;
        content?: string;
        reason?: string;
    }>;
    userTitles?: Array<{
        name?: string;
        title?: string;
        reason?: string;
    }>;
    qualityReview?: {
        title?: string;
        summary?: string;
    } | null;
    meta?: {
        warnings?: unknown;
    };
}
declare function composeDailyReportText(data: ReportDataLike, analysis: AnalysisLike, options?: {
    detail?: boolean;
    reason?: string;
}): string;
declare function generateDailyReportResult(options: DailyReportPipelineOptions): Promise<DailyReportPipelineResult>;
declare const _default: {
    composeDailyReportText: typeof composeDailyReportText;
    generateDailyReportResult: typeof generateDailyReportResult;
};
export = _default;
