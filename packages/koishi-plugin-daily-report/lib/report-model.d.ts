import type { GroundedReportOptions } from './report-runner';
import type { ReportClassificationCachePolicy } from './report-classification-cache';
import type { ReportStageCachePolicies } from './report-stage-cache';
export declare function createGroundedModelRequest(options?: {
    onlyConfiguredModel?: string;
    configuredNode?: {
        provider: string;
        model: string;
    };
}): Promise<{
    policyIdentity: string;
    routing: readonly {
        provider: string;
        model: string;
        baseURL: string;
        protocol: string;
    }[];
    classificationCachePolicy: ReportClassificationCachePolicy;
    stageCachePolicies: ReportStageCachePolicies;
    request: GroundedReportOptions['request'];
}>;
