import { ReportPeriod } from './report-period';
export interface ReportRecord extends Record<string, unknown> {
    messageId: string;
    timestamp: number;
    userId: string;
    userName: string;
    text: string;
    media: Array<Record<string, unknown>>;
    recordVersion?: 2;
    realMessageId?: boolean;
    bodyComplete?: boolean;
    incompleteReason?: string;
}
export interface ReportRecordInput {
    messageId?: string;
    timestamp: number;
    userId?: string;
    userName?: string;
    text?: string;
    media?: Array<Record<string, unknown>>;
}
export interface ReportRecordsResult {
    records: Array<ReportRecord & {
        analysisId: number;
    }>;
    windowMessageCount: number;
    selectedMessageCount: number;
    excludedByLimitCount: number;
    sourceCompleteness: 'complete' | 'incomplete' | 'legacy_unknown';
}
export declare const REPORT_INDEX_ROOT: string;
export declare function getReportIndexFile(date: string, channelKey: string): string;
export declare function appendReportRecord(date: string, channelKey: string, input: ReportRecordInput): ReportRecord;
export declare function scanReportIndex(file: string, consume: (record: ReportRecord) => void): void;
export declare function readReportRecords(channelKey: string, period: ReportPeriod, options?: {
    maxMessages?: number;
    onRecord?: (record: ReportRecord) => void;
}): ReportRecordsResult;
export declare function cleanupReportRecords(options?: {
    now?: number;
    maxFiles?: number;
}): Promise<{
    scanned: number;
    removed: number;
    retained: number;
    changed: number;
    skipped: boolean;
}>;
