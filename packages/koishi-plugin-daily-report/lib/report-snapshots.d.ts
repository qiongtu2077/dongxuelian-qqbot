import type { ReportEvidence } from './report-evidence';
import type { PagedReportStore } from './report-storage';
declare const createReportPeriod: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period").createReportPeriod;
export interface ReportSnapshotContext {
    period: ReturnType<typeof createReportPeriod>;
    sourceCompleteness: 'complete' | 'legacy_unknown';
    statistics: Record<string, unknown>;
}
export declare function decodeReportSnapshot(metadata: unknown, records: readonly unknown[]): {
    evidence: ReportEvidence;
    context: ReportSnapshotContext;
};
export declare function saveReportSnapshot(store: PagedReportStore, evidence: ReportEvidence, context: ReportSnapshotContext): string;
export declare function readReportSnapshot(store: PagedReportStore, id: string, current: ReportEvidence, context: ReportSnapshotContext): ReportEvidence | null;
export {};
