/**
 * MODULE: 日报选中事件的完整原话复核协议。
 * 职责: 绑定当前实际供料、连续标题/摘录、逐来源已读账本和唯一缺漏恢复。
 * 边界: 不请求模型、不猜事件关联、不生成解释、不读取缓存。
 * 状态: 每个请求独立来源与成员表，无全局状态。
 */
import { AnalysisUnitCoverageError } from './complete-input';
import type { AnalysisUnitRecovery } from './complete-input';
import type { ReportEvidence, EvidenceFragment } from './report-evidence';
interface ReadingSource {
    kind: 'source';
    parts: [{
        memberId: string;
    }, string];
    fragments: [EvidenceFragment];
}
export interface ReportReadingContext {
    input: string;
    allowed: Map<string, ReadingSource>;
    members: Map<string, {
        userId: string;
        name: string;
    }>;
    allowEmptyTopic?: boolean;
}
export interface ReportReadingTopic {
    title: string;
    summary: string;
    summaryParts: Array<string | {
        memberId: string;
    }>;
    fragments: EvidenceFragment[];
}
export interface ReportReadingResult {
    topic: ReportReadingTopic;
    excerpts: Record<string, string>;
    reviewed: string[];
}
export declare function createReportExcerptContext(snapshot: ReportEvidence, entries: readonly {
    fragment: EvidenceFragment;
    excerpt: string;
}[]): ReportReadingContext;
export declare function createReportReadingContext(snapshot: ReportEvidence, fragments: readonly EvidenceFragment[]): ReportReadingContext;
export declare function getReportReadingInstructions(): string;
export declare function getReportReadingSchema(input: string): Record<string, unknown>;
export declare class ReportReadingCoverageError extends AnalysisUnitCoverageError {
    readonly value: ReportReadingResult;
    readonly allowed: string[];
    readonly missing: string[];
    constructor(value: ReportReadingResult, allowed: string[], missing: string[]);
}
export declare function readReportReading(text: string, context: ReportReadingContext): ReportReadingResult;
export declare function createReportReadingRepair(error: unknown, context: ReportReadingContext): AnalysisUnitRecovery<ReportReadingResult> | undefined;
export {};
