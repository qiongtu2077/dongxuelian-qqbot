import type { EvidenceFragment, ReportEvidence } from './report-evidence';
import type { TopicContext } from './report-topics';
import type { GroundedOutputContext } from './report-outputs';
interface StagePermanentFragment {
    key: string;
    messageId: string;
    sourceIdentity: string;
    memberId: string;
    part: number;
    partCount: number;
}
interface StageSourceAlias {
    alias: string;
    role: 'raw' | 'summary' | 'primary' | 'auxiliary';
    fragments: string[];
    author: string | null;
    textIdentity: string;
    range: {
        utf16Start: number;
        utf16End: number;
    } | null;
}
export interface ReportStageBindings {
    version: 'stage-bindings-1';
    material: 'topic-raw' | 'topic-summary' | 'topic-comparison' | 'output';
    provenance: string[];
    fragments: StagePermanentFragment[];
    sources: StageSourceAlias[];
    candidates: Array<{
        alias: string;
        fragments: string[];
        kind: string | null;
        category: string | null;
    }>;
    members: Array<{
        alias: string;
        memberId: string;
        primarySources: string[];
    }>;
    targets: string[];
    statistics: Array<{
        alias: string;
        textIdentity: string;
    }>;
}
export declare function bindTopicStageRequest(snapshot: ReportEvidence, context: TopicContext, provenance: readonly EvidenceFragment[]): ReportStageBindings | null;
export declare function bindOutputStageRequest(snapshot: ReportEvidence, context: GroundedOutputContext, provenance: readonly EvidenceFragment[]): ReportStageBindings | null;
export declare function verifyReportStageOrigin(snapshot: ReportEvidence, bindings: ReportStageBindings): void;
export {};
