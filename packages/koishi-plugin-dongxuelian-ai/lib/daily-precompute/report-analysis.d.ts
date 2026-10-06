/** 日报分析诊断契约：输入覆盖、阶段结果与明确失败分类共用同一口径。 */
import { ReportPeriod } from './report-period';
export type ReportFailureKind = 'generation_failed' | 'total_timeout';
export interface FailedReportUnit {
    id: string;
    stage: string;
    firstSourceId: number | null;
    lastSourceId: number | null;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    attempts: number;
    error: string;
}
export interface ReportAnalysisDiagnostics {
    reportPolicyVersion: 2;
    reportPeriod?: ReportPeriod;
    periodBackfilled: boolean;
    windowMessageCount: number;
    selectedMessageCount: number;
    excludedByLimitCount: number;
    submittedMessageCount: number;
    summarizedMessageCount: number;
    topicInputMessageCount: number;
    omittedMessageCount: number;
    coverageRate: number | null;
    batchCount: number;
    failedBatches: FailedReportUnit[];
    unprocessedCount: number;
    mergeLevels: number;
    requestCount: number;
    reportCallCount: number;
    retryCount: number;
    inputChars: number;
    outputChars: number;
    usageReadableRequests: number;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    stageDurationsMs: Record<string, number>;
    failureKind: ReportFailureKind | null;
    failureStage: string;
    error: string;
    sourceCompleteness: 'complete' | 'incomplete' | 'legacy_unknown';
    analysisState: 'not_started' | 'processing' | 'complete' | 'failed' | 'total_timeout';
    warnings: string[];
    stages: {
        compression: string;
        basic: string;
        full: string;
    };
}
export declare const REPORT_FAILURE_TEXT = "\u65E5\u62A5\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF0C\u6216\u8054\u7CFBBot\u7BA1\u7406\u5458\u5904\u7406";
export declare const REPORT_TIMEOUT_TEXT = "\u65E5\u62A5\u751F\u6210\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF0C\u6216\u8054\u7CFBBot\u7BA1\u7406\u5458\u5904\u7406";
export declare function sanitizeReportDiagnosticText(value: string, limit?: number): string;
export declare function sanitizeReportAnalysisDiagnostics(value: unknown): ReportAnalysisDiagnostics;
export declare class ReportRuntimeTimeoutError extends Error {
    readonly code = "DAILY_REPORT_TOTAL_TIMEOUT";
    constructor(message?: string);
}
export declare function isReportTotalTimeoutError(error: unknown): boolean;
export declare function createReportAnalysisDiagnostics(input: {
    windowMessageCount: number;
    selectedMessageCount: number;
    sourceCompleteness: ReportAnalysisDiagnostics['sourceCompleteness'];
    reportPeriod?: ReportPeriod;
    periodBackfilled?: boolean;
}): ReportAnalysisDiagnostics;
export declare class ReportAnalysisError extends Error {
    readonly code: 'DAILY_REPORT_GENERATION_FAILED' | 'DAILY_REPORT_TOTAL_TIMEOUT';
    readonly diagnostics: ReportAnalysisDiagnostics;
    constructor(message: string, kind: ReportFailureKind, stage: string, diagnostics: ReportAnalysisDiagnostics);
}
