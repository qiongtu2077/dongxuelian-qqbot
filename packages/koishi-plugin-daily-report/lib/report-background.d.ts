/**
 * MODULE: 日报单个封闭分类批次的后台协调器。
 * 职责: 精确跳过可信产物、原九十秒内分类/唯一恢复、先计额后提交与可信发布。
 * 边界: 不注册调度、不初始化总账、不投递；入口依赖调用方已有S0和有效任务。
 */
import { PagedReportStore } from './report-storage';
import type { ReportBatchCatalog } from './report-batch-catalog';
import type { ReportEvidence } from './report-evidence';
import type { ReportSnapshotContext } from './report-snapshots';
import type { GroundedReportOptions } from './report-runner';
import { ReportRequestBoundaryError } from './report-request-pool';
import type { ReportCacheModelPolicy } from './report-cache-provenance';
interface BackgroundOptions {
    store: PagedReportStore;
    snapshot: ReportEvidence;
    snapshotCommit: string;
    context: ReportSnapshotContext;
    catalog: ReportBatchCatalog;
    startedAtMs: number;
    policy: ReportCacheModelPolicy;
    request: GroundedReportOptions['request'];
    hasForegroundPending(): boolean;
    signal?: AbortSignal;
    onDiagnostic?: (code: string, id: string, message: string) => void;
    classifyQuotaFailure?: (error: ReportRequestBoundaryError) => 'none' | 'group' | 'global';
}
export interface ReportBackgroundResult {
    status: 'complete' | 'idle';
    reason: 'classified' | 'no_unfinished_closed_batch';
    catalogId: string | null;
    commitId: string | null;
    requestCount: number;
    recoveryCount: number;
    skippedCached: number;
    processedMessageCount: number;
}
export declare function runReportBackgroundBatch(options: BackgroundOptions): Promise<ReportBackgroundResult>;
export {};
