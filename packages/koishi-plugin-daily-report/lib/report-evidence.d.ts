import type { InputMessage } from './complete-input';
export interface EvidenceMessage extends InputMessage {
    messageId?: string;
    realMessageId?: boolean;
    replyToId?: string;
}
export interface EvidenceSource {
    readonly sourceId: number;
    readonly messageId: string | null;
    readonly realMessageId: boolean | null;
    readonly userId: string;
    readonly name: string;
    readonly content: string;
    readonly ts: number | null;
    readonly time: string;
    readonly replyToId: string | null;
    readonly identity: string;
}
export interface EvidenceFragment {
    readonly id: string;
    readonly sourceId: number;
    readonly part: number;
    readonly partCount: number;
    readonly text: string;
    readonly permanentKey: string | null;
}
export interface ReportEvidence {
    readonly version: 1;
    readonly sources: readonly EvidenceSource[];
    readonly fragments: readonly EvidenceFragment[];
    readonly byMessageId: ReadonlyMap<string, EvidenceSource>;
    readonly byFragmentId: ReadonlyMap<string, EvidenceFragment>;
    readonly identity: string;
    readonly hasStableMessageIds: boolean;
}
interface EvidenceMember {
    userId: string;
    name: string;
}
export interface EvidenceBatch {
    fragments: readonly EvidenceFragment[];
    core: Map<string, EvidenceFragment & {
        author: string;
    }>;
    members: Map<string, EvidenceMember>;
    auxiliary: Map<string, {
        sourceId: number;
        text: string;
        truncated: boolean;
    }>;
    input: string;
    coreCharacters: number;
    auxiliaryCharacters: number;
}
export declare function createReportEvidence(messages: readonly EvidenceMessage[]): ReportEvidence;
export declare function buildReportEvidenceBatch(snapshot: ReportEvidence, fragments: readonly EvidenceFragment[]): EvidenceBatch;
export declare function partitionReportEvidence(snapshot: ReportEvidence): {
    deterministic: EvidenceFragment[];
    model: EvidenceFragment[];
};
export declare function packReportEvidenceBatches(snapshot: ReportEvidence, overheadCharacters?: number): EvidenceBatch[];
export {};
