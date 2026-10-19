import { PagedReportStore } from './report-storage';
import type { ReportSnapshotContext } from './report-snapshots';
import type { PermanentClassification } from './report-bindings';
import type { ReportEvidence, EvidenceBatch } from './report-evidence';
import type { ClassificationRecord } from './report-candidates';
import type { AnalysisUnitAttempt } from './complete-input';
import type { ReportCacheModelPolicy, ReportCacheActualAttempt } from './report-cache-provenance';
export type ReportClassificationCachePolicy = ReportCacheModelPolicy;
type SavedAttempt = ReportCacheActualAttempt;
interface CacheMetadataBase {
    requestIdentity: string;
    policyIdentity: string;
    batchRuleIdentity: string;
    sourceSnapshotCommit: string;
    origin: {
        taskId: string;
        deadlineMs: number;
    };
    productIdentity: string;
    actualAttempts: SavedAttempt[];
}
type CacheMetadata = CacheMetadataBase & ({
    version: 'classification-cache-1';
    bindings: Omit<PermanentClassification, 'records'>;
} | {
    version: 'classification-cache-2';
    bindingVersion: PermanentClassification['version'];
    coreCount: number;
    memberCount: number;
    classificationCount: number;
});
export interface CachedReportClassification {
    commitId: string;
    sourceSnapshotCommit: string;
    origin: CacheMetadata['origin'];
    actualAttempts: SavedAttempt[];
    records: ClassificationRecord[];
}
interface CacheOptions {
    store: PagedReportStore;
    snapshot: ReportEvidence;
    snapshotCommit: string;
    context: ReportSnapshotContext;
    policy: ReportClassificationCachePolicy;
    onDiagnostic?: (code: string, id: string, message: string) => void;
}
export declare class ReportClassificationCache {
    private readonly options;
    readonly taskIdentity: PagedReportStore['taskIdentity'];
    private readonly candidates;
    private readonly policy;
    readonly enabled: boolean;
    constructor(options: CacheOptions);
    private diagnostic;
    private requestIdentity;
    private validateUnit;
    private validateOrigin;
    read(snapshot: ReportEvidence, batch: EvidenceBatch, ruleIdentity: string): CachedReportClassification | null;
    save(snapshot: ReportEvidence, batch: EvidenceBatch, ruleIdentity: string, attempts: readonly AnalysisUnitAttempt[], records: readonly ClassificationRecord[]): string | null;
}
export {};
