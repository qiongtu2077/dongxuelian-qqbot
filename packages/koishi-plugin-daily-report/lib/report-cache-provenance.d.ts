import type { AnalysisUnitAttempt } from './complete-input';
interface ReportCacheModelNode {
    routeIdentity: string;
    routeRevision: string;
    provider: string;
    model: string;
    protocol: string;
}
export interface ReportCacheModelPolicy {
    identity: string;
    first: ReportCacheModelNode;
    recovery: ReportCacheModelNode;
}
export interface ReportCacheActualAttempt {
    attempt: number;
    execution: NonNullable<AnalysisUnitAttempt['execution']>;
}
export declare function reportCacheDigest(value: unknown): string;
export declare function assertReportCachePolicy(policy: ReportCacheModelPolicy): void;
export declare function assertReportCacheAttempts(attempts: readonly ReportCacheActualAttempt[], policy: ReportCacheModelPolicy): void;
export declare function verifyReportCacheAttempts(attempts: readonly AnalysisUnitAttempt[], policy: ReportCacheModelPolicy, system: string, input: string, maxTokens: number): ReportCacheActualAttempt[];
export {};
