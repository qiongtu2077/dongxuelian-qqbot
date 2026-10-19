/**
 * MODULE: 日报后台预分析的持久化请求总账。
 * 职责: 首次建账/日滚动、先预留、硬额度/间隔与实际用量登记。
 * 边界: 不调度或请求模型、不发送消息；调用方必须持有既有独占资源租约。
 */
import { PagedReportStore } from './report-storage';
import type { ReportCacheModelPolicy } from './report-cache-provenance';
import type { AnalysisUnitAttempt } from './complete-input';
import { ReportRequestBoundaryError } from './report-request-pool';
interface LedgerUsage {
    readable: boolean;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
interface LedgerOptions {
    store: PagedReportStore;
    startedAtMs: number;
    unitIdentity: string;
    policy: ReportCacheModelPolicy;
    hasForegroundPending(): boolean;
}
export interface ReportBackgroundReservation {
    date: string;
    id: string;
}
type RequestStep = NonNullable<AnalysisUnitAttempt['upstreamAttempts']>[number];
export declare class ReportBackgroundLedgerError extends ReportRequestBoundaryError {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function provisionReportBackgroundLedger(store: PagedReportStore): void;
export declare class ReportBackgroundLedger {
    private readonly options;
    private readonly policy;
    private readonly owner;
    private readonly channel;
    constructor(options: LedgerOptions);
    private activeDay;
    private relatedDays;
    schedulingState(): {
        allowed: boolean;
        reason: string;
        lastScheduledAtMs: number | null;
    };
    recordSchedule(): void;
    snapshot(): {
        groupUsed: number;
        globalUsed: number;
        groupPaused: boolean;
        globalPaused: boolean;
        unresolved: number;
    };
    reserve(attempt: 1 | 2, requestIdentity: string, step: RequestStep): ReportBackgroundReservation;
    settle(reservation: ReportBackgroundReservation, status: 'returned' | 'failed' | 'cancelled', usage: LedgerUsage | null, quotaFailure?: 'none' | 'group' | 'global'): void;
}
export {};
