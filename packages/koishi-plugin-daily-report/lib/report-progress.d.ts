/**
 * MODULE: 日报完整处理、深读与展示的独立计数。
 * 职责: 根据当前快照与实际核心片段集合生成公开数量。
 * 边界: 不判断语义/缓存资格、不读取正文以外的新消息、不改变旧coverage含义。
 * 状态: 无全局状态，不持久化临时引用。
 */
import type { ManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime';
import type { ReportEvidence } from './report-evidence';
type ReportEvidenceMetrics = NonNullable<ReturnType<ManagementModule<'daily.reportAnalysis'>['createReportAnalysisDiagnostics']>['evidence']>;
export interface ReportProgressInput {
    submitted: readonly string[];
    classified: readonly string[];
    deterministic: readonly string[];
    cached: readonly string[];
    selected: readonly string[];
    deepRead: readonly string[];
    displayed: readonly string[];
}
export declare function createReportEvidenceMetrics(snapshot: ReportEvidence, input: ReportProgressInput): ReportEvidenceMetrics;
export {};
