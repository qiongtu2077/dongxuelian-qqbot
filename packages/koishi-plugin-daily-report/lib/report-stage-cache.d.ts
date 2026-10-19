import { PagedReportStore } from './report-storage';
import type { ReportSnapshotContext } from './report-snapshots';
import type { ReportEvidence } from './report-evidence';
import type { AnalysisUnitAttempt, AnalysisUnitRecovery } from './complete-input';
import type { ReportStageBindings } from './report-stage-bindings';
import type { ReportCacheModelPolicy, ReportCacheActualAttempt } from './report-cache-provenance';
export type ReportCachedStage = 'grouping' | 'selection' | 'overview' | 'quotes' | 'portraits' | 'review';
export type ReportStageCachePolicies = Record<ReportCachedStage, ReportCacheModelPolicy>;
export interface ReportStageCacheRequest {
    stage: ReportCachedStage;
    mode: 'ordinary' | 'detailed';
    system: string;
    input: string;
    maxTokens: number;
    bindings: ReportStageBindings;
    requireNormalFinish?: boolean;
}
interface StageCacheMetadata {
    version: 'stage-cache-1';
    stage: ReportCachedStage;
    mode: ReportStageCacheRequest['mode'];
    requestIdentity: string;
    policyIdentity: string;
    sourceSnapshotCommit: string;
    origin: {
        taskId: string;
        deadlineMs: number;
    };
    productIdentity: string;
    actualAttempts: ReportCacheActualAttempt[];
}
export interface ReportStageCacheHistory {
    stage: ReportCachedStage;
    commitId: string;
    sourceSnapshotCommit: string;
    origin: StageCacheMetadata['origin'];
    actualAttempts: ReportCacheActualAttempt[];
}
interface StageCacheOptions {
    store: PagedReportStore;
    snapshot: ReportEvidence;
    snapshotCommit: string;
    context: ReportSnapshotContext;
    policies: ReportStageCachePolicies;
    onDiagnostic?: (code: string, id: string, message: string) => void;
}
export declare class ReportStageCache {
    private readonly options;
    readonly taskIdentity: PagedReportStore['taskIdentity'];
    readonly enabled: boolean;
    private readonly policies;
    private readonly candidates;
    constructor(options: StageCacheOptions);
    private diagnostic;
    private identity;
    private validate;
    private validateSource;
    read<T>(snapshot: ReportEvidence, request: ReportStageCacheRequest, validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): {
        value: T;
        history: ReportStageCacheHistory;
    } | null;
    save<T>(snapshot: ReportEvidence, request: ReportStageCacheRequest, attempts: readonly AnalysisUnitAttempt[], result: T, validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): string | null;
}
export {};
