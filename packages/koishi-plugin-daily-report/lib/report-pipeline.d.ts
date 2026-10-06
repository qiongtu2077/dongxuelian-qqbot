declare const createReportPeriod: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period").createReportPeriod;
interface DailyReportPipelineOptions {
    taskId?: string;
    channelKey: unknown;
    detail?: boolean;
    outputDir: string;
    renderImage?: boolean;
    onStep?: (step: string) => unknown;
    reportPeriod?: ReturnType<typeof createReportPeriod>;
    periodBackfilled?: boolean;
    deadlineMs?: number;
    startedAtMs?: number;
    signal?: AbortSignal;
    now?: () => number;
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
    sourceCompleteness?: 'complete' | 'incomplete' | 'legacy_unknown';
    windowMessageCount?: number;
    reportPeriod?: ReturnType<typeof createReportPeriod>;
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
        subtitle?: string;
        summary?: string;
        dimensions?: Array<{
            name?: string;
            percentage?: number;
            comment?: string;
        }>;
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
