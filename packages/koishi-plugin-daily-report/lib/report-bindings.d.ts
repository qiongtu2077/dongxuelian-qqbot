import type { ClassificationRecord } from './report-candidates';
import type { EvidenceBatch, ReportEvidence } from './report-evidence';
interface PermanentCore {
    key: string;
    messageId: string;
    sourceIdentity: string;
    part: number;
    partCount: number;
    memberId: string;
}
type PermanentRecord = {
    kind: 'event' | 'interaction';
    category: string;
    title: string;
    summary: '';
    keys: string[];
} | {
    kind: 'quote';
    key: string;
    memberId: string;
    reason: string;
};
export interface PermanentClassification {
    version: 'permanent-classification-1' | 'permanent-classification-2';
    core: PermanentCore[];
    members: Array<{
        alias: string;
        memberId: string;
    }>;
    records: PermanentRecord[];
}
export interface ClassificationIdentityOptions {
    channelKey: string;
    periodStartMs: number;
    periodEndMs: number;
    sourceCompleteness: 'complete' | 'legacy_unknown' | 'incomplete';
    modelPolicyIdentity: string;
    batchRuleIdentity: string;
    system: string;
    maxTokens: number;
}
export declare function bindReportClassification(snapshot: ReportEvidence, batch: EvidenceBatch, records: readonly ClassificationRecord[]): PermanentClassification | null;
export declare function restoreReportClassification(snapshot: ReportEvidence, batch: EvidenceBatch, value: PermanentClassification): ClassificationRecord[];
export declare function createClassificationRequestIdentity(snapshot: ReportEvidence, batch: EvidenceBatch, options: ClassificationIdentityOptions): string | null;
export {};
