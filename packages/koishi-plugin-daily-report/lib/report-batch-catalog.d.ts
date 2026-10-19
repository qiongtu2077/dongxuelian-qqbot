import type { EvidenceBatch, EvidenceFragment, ReportEvidence } from './report-evidence';
import type { PagedReportStore } from './report-storage';
declare const createReportPeriod: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period").createReportPeriod;
interface CatalogSource {
    messageId: string;
    identity: string;
    arrival: number;
    ts: number;
    parts: string[];
}
interface CatalogBatch {
    id: string;
    sequence: number;
    revision: number;
    parts: string[];
    firstTimestampMs: number;
    sealed: boolean;
    sealedAtMs: number | null;
    sealReason: 'capacity' | 'age' | 'window_end' | null;
}
export interface ReportBatchCatalog {
    version: 'report-batch-catalog-1';
    ruleIdentity: string;
    scope: {
        channelKey: string;
        reportDate: string;
        periodStartMs: number;
        periodEndMs: number;
    };
    baselineIdentity: string | null;
    initialMessageId: string | null;
    nextSequence: number;
    sources: CatalogSource[];
    batches: CatalogBatch[];
}
export interface CatalogUpdateContext {
    channelKey: string;
    period: ReturnType<typeof createReportPeriod>;
    nowMs: number;
    sourceCompleteness: 'complete';
    inputScope: 'full_business_window';
}
export interface CatalogBatchView {
    catalogId: string;
    revision: number;
    ruleIdentity: string;
    identity: string;
    complete: boolean;
    sealed: boolean;
    batch: EvidenceBatch | null;
    deterministic: EvidenceFragment[];
    fragments: EvidenceFragment[];
}
interface CatalogRecoveryAudit {
    version: 'catalog-range-recovery-1';
    fromCommit: string;
    damagedPages: number[];
    replacedSlots: number[];
    preservedBatchCount: number;
    entireRange: boolean;
}
export interface LatestReportBatchCatalog {
    id: string;
    generation: number;
    value: ReportBatchCatalog;
}
export declare function validateReportBatchCatalog(catalog: ReportBatchCatalog): void;
export declare function updateReportBatchCatalog(previous: ReportBatchCatalog | null, snapshot: ReportEvidence, context: CatalogUpdateContext): ReportBatchCatalog;
export declare function selectReportCatalogBatches(catalog: ReportBatchCatalog, snapshot: ReportEvidence): CatalogBatchView[];
export declare function saveReportBatchCatalog(store: PagedReportStore, catalog: ReportBatchCatalog, previousCommit?: string | null, recovery?: CatalogRecoveryAudit): string;
export declare function readReportBatchCatalog(store: PagedReportStore, id: string): ReportBatchCatalog | null;
export declare function readLatestReportBatchCatalog(store: PagedReportStore, scope: ReportBatchCatalog['scope']): LatestReportBatchCatalog | null;
export declare function updateStoredReportBatchCatalog(store: PagedReportStore, snapshot: ReportEvidence, context: CatalogUpdateContext): LatestReportBatchCatalog & {
    recovery: CatalogRecoveryAudit | null;
};
export {};
