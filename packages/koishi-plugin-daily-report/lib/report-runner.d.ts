import type { AnalysisRuntime } from './complete-input';
import type { EvidenceMessage } from './report-evidence';
import type { ReportBatchCatalog } from './report-batch-catalog';
import type { ReportClassificationCache, CachedReportClassification } from './report-classification-cache';
import type { ReportStageCache, ReportStageCacheHistory } from './report-stage-cache';
declare const createReportAnalysisDiagnostics: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis").createReportAnalysisDiagnostics;
type Diagnostics = ReturnType<typeof createReportAnalysisDiagnostics>;
export type GroundedStage = 'classification' | 'grouping' | 'selection' | 'overview' | 'quotes' | 'portraits' | 'review';
type ModuleState = 'complete' | 'insufficient' | 'not_requested';
export interface GroundedReportInput {
    messages: readonly EvidenceMessage[];
    totalMessages?: number;
    activeMembers?: number;
    peakHour?: string;
    windowMessageCount?: number;
    topMembers?: readonly {
        userId?: string | number;
        msgCount?: number;
    }[];
    sourceCompleteness?: Diagnostics['sourceCompleteness'];
    reportPeriod?: Diagnostics['reportPeriod'];
    periodBackfilled?: boolean;
}
export interface GroundedReportOptions extends Omit<AnalysisRuntime, 'request'> {
    taskId?: string;
    startedAtMs?: number;
    concurrency?: 1 | 2;
    classificationCatalog?: {
        channelKey: string;
        value: ReportBatchCatalog;
    };
    classificationCache?: ReportClassificationCache;
    stageCache?: ReportStageCache;
    request(stage: GroundedStage, attempt: 1 | 2, system: string, input: string, maxTokens: number, extra: Record<string, unknown>): Promise<string>;
}
export interface GroundedReportResult {
    analysisVersion: 'grounded-report-1';
    topics: Array<{
        id: number;
        title: string;
        summary: string;
        participants: string[];
    }>;
    goldenQuotes: Array<{
        content: string;
        sender: string;
        reason: string;
        userId: string;
    }>;
    userTitles: Array<{
        name: string;
        userId: string;
        title: string;
        reason: string;
        mbti: string;
    }>;
    qualityReview: {
        title: string;
        subtitle: string;
        dimensions: Array<{
            name: string;
            percentage: number;
            comment: string;
            color: string;
        }>;
        summary: string;
    } | null;
    tokenUsage: Diagnostics['tokenUsage'];
    meta: Diagnostics;
    audit: {
        snapshotIdentity: string;
        modules: Record<'topics' | 'quotes' | 'portraits' | 'review', ModuleState>;
        candidates: Array<{
            id: string;
            kind: string;
            category: string;
            fragmentIds: string[];
        }>;
        selected: Array<{
            id: string;
            fragmentIds: string[];
        }>;
        overviews: Array<{
            title: string;
            evidence: string[];
            submitted: string[];
        }>;
        topicCards: unknown;
        topicCatalog: unknown;
        firstRequests: number;
        recoveries: number;
        classificationCache: Array<Omit<CachedReportClassification, 'records'>>;
        stageCache: ReportStageCacheHistory[];
    };
}
export declare const GROUNDED_REPORT_LIMITS: Readonly<{
    requestTimeoutMs: 90000;
    runTimeoutMs: 1800000;
    saveReserveMs: 30000;
}>;
export declare function runGroundedReport(data: GroundedReportInput, full: boolean, options: GroundedReportOptions): Promise<GroundedReportResult>;
export {};
