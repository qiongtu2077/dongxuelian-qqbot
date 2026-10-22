/**
 * MODULE: 正式日报有据链的专用配置、一次收集与可信存储接线。
 * 边界: 调用方持有S0和有效任务领取；本模块不投递、不建后台总账。
 * 启用: 专用开关默认关闭；前后台共用同一显式模型节点。
 */
import collector = require('./data-collector');
import type { EvidenceMessage } from './report-evidence';
import type { GroundedReportOptions } from './report-runner';
type ReportPeriod = NonNullable<Parameters<typeof collector.collectReportData>[1]>;
export interface GroundedReportConfiguration {
    provider: string;
    model: string;
}
export interface CollectedGroundedReport {
    data: ReturnType<typeof collector.collectReportData>;
    fullMessages: EvidenceMessage[];
    cacheEligible: boolean;
}
interface GroundedEntryOptions extends Omit<GroundedReportOptions, 'request' | 'classificationCatalog' | 'classificationCache' | 'stageCache' | 'concurrency'> {
    taskId: string;
    channelKey: string;
    configuration: GroundedReportConfiguration;
    periodBackfilled?: boolean;
    assertActive(): void;
    assertLease(): void;
}
export declare function readGroundedReportConfiguration(): GroundedReportConfiguration | null;
export declare function collectGroundedReportInput(channelKey: unknown, period: ReportPeriod, assertActive: () => void): CollectedGroundedReport;
export declare function analyzeGroundedReport(input: CollectedGroundedReport, full: boolean, options: GroundedEntryOptions): Promise<{
    analysis: import("./report-runner").GroundedReportResult;
    storage: {
        snapshotCommit: string;
        catalogCommit: string | null;
        crossTaskCacheEligible: boolean;
        policyIdentity: string;
        routing: readonly {
            provider: string;
            model: string;
            baseURL: string;
            protocol: string;
        }[];
    };
}>;
export {};
