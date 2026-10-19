/**
 * MODULE: 日报完整分类与原话候选协议。
 * 职责: 验证明确分类账本，保留首轮合法材料，并绑定永久来源和本人。
 * 边界: 不请求模型、不生成摘要、不猜补分类、不读写缓存。
 * 状态: 仅处理当前批次，无全局Map或持久化状态。
 */
import { AnalysisUnitCoverageError } from './complete-input';
import type { AnalysisUnitRecovery } from './complete-input';
import type { EvidenceBatch, EvidenceFragment, ReportEvidence } from './report-evidence';
interface GroupRecord {
    kind: 'event' | 'interaction';
    category: string;
    title: string;
    summary: string;
    refs: string[];
}
interface QuoteRecord {
    kind: 'quote';
    ref: string;
    reason: string;
}
export type ClassificationRecord = GroupRecord | QuoteRecord;
export interface ReportCandidate {
    id: string;
    kind: 'event' | 'interaction' | 'quote';
    title: string;
    summary: string;
    category: string;
    facts: CandidateFact[];
    rawFacts: CandidateFact[];
    titleParts: never[];
    interactionParts: never[];
    fragments: EvidenceFragment[];
    reason: string;
    rawSourceMaterial: true;
    localSegment?: {
        recordIndex: number;
        segmentIndex: number;
    };
}
interface CandidateFact {
    parts: Array<string | {
        memberId: string;
    }>;
    fragments: EvidenceFragment[];
}
export declare function getReportClassificationInstructions(): string;
export declare function getReportClassificationSchema(input: string): Record<string, unknown>;
export declare class ClassificationCoverageError extends AnalysisUnitCoverageError {
    readonly value: ClassificationRecord[];
    readonly allowed: string[];
    readonly missing: string[];
    constructor(value: ClassificationRecord[], allowed: string[], missing: string[]);
}
export declare function readReportClassification(text: string, batch: EvidenceBatch): ClassificationRecord[];
export declare function createReportClassificationRepair(error: unknown, batch: EvidenceBatch): AnalysisUnitRecovery<ClassificationRecord[]> | undefined;
export declare function createReportCandidates(records: ClassificationRecord[], batch: EvidenceBatch, prefix: string): ReportCandidate[];
export declare function createImageReportCandidates(snapshot: ReportEvidence): ReportCandidate[];
export {};
