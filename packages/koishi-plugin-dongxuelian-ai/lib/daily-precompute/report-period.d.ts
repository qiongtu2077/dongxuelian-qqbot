/** 日报专用四点业务日契约；不改变聊天系统其他功能的自然日。 */
export interface ReportPeriod {
    reportPolicyVersion: 2;
    reportDate: string;
    periodStartMs: number;
    periodEndMs: number;
    cutoffMs: number;
}
export declare function createReportPeriod(submittedAtMs: number): ReportPeriod;
export declare function resolveReportPeriod(payload: Record<string, unknown>, createdAt: string): ReportPeriod & {
    periodBackfilled: boolean;
};
export declare function isTimestampInReportPeriod(timestamp: number, period: ReportPeriod): boolean;
export declare function getReportIndexDates(period: ReportPeriod): string[];
export declare function getReportRecordExpiryMs(timestamp: number): number;
