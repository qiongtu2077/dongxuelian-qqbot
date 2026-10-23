/**
 * MODULE: 全文话题卡、完整目录选题与有据概述的明确协议。
 * 职责: 组织完整来源、核验卡片证据和无淘汰目录；保留旧协议明确读取器。
 * 边界: 不调用模型、不按标题猜合并、不以摘要替代完整处理账本。
 */
import { AnalysisUnitCoverageError } from './complete-input';
import type { AnalysisUnitRecovery } from './complete-input';
import type { ReportEvidence, EvidenceFragment, EvidenceBatch } from './report-evidence';
export interface TopicCandidate {
    id: string;
    fragments: readonly EvidenceFragment[];
    kind?: string;
    category?: string;
    scopeHints?: readonly string[];
    cardRange?: string;
}
export interface TopicContext {
    input: string;
    candidates: Map<string, TopicCandidate>;
    sources: Map<string, readonly EvidenceFragment[]>;
    comparisonLimit?: number;
    cardLimit?: number;
    cardCoverageAllowance?: number;
    deferCardCoverage?: boolean;
    cacheMaterial?: {
        kind: 'raw';
        batch: EvidenceBatch;
    } | {
        kind: 'comparison';
        batch: EvidenceBatch;
        excerpts: ReadonlyMap<string, string>;
    } | {
        kind: 'summary';
        summaries: ReadonlyMap<string, {
            title: string;
            summary: string;
        }>;
    };
}
export interface TopicOverview {
    title: string;
    summary: string;
    refs: string[];
    evidence: EvidenceFragment[];
    submitted: EvidenceFragment[];
}
export interface TopicCard {
    candidate: TopicCandidate;
    leaves: readonly string[];
    status: 'ok' | 'insufficient';
    scope: string;
    parentId?: string;
    evidence: ReadonlyArray<{
        fragment: EvidenceFragment;
        text: string;
        excerptOnly: true;
        truncated: boolean;
        sourceCharacters: number;
    }>;
    unassignedFragments?: readonly EvidenceFragment[];
    formatWarnings?: ReadonlyArray<{
        code: 'ignored_empty_insufficient_child' | 'legacy_evidence_object' | 'evidence_count_normalized';
        parentRef: string;
        childIndex: number;
        providedCount?: number;
        retainedCount?: number;
    } | {
        code: 'unassigned_core_fragments';
        parentRef: string;
        fragmentIds: string[];
    } | {
        code: 'ignored_root_marker';
        marker: 'cards';
    } | {
        code: 'ignored_empty_root_field';
        field: string;
    } | {
        code: 'restored_parent_alias';
        parentRef: string;
        aliasRef: string;
    } | {
        code: 'ignored_empty_unknown_parent' | 'misplaced_parent_container';
        parentRef: string;
    }>;
}
export declare const TOPIC_CATALOG_PROTOCOLS: Readonly<{
    cards: "topic-cards-9";
    directory: "topic-directory-3";
    selection: "topic-selection-3";
}>;
export declare const TOPIC_PROTOCOLS: Readonly<{
    grouping: "neutral-grouping-1";
    selection: "topic-priority-1";
    overview: "neutral-topic-overview-4";
}>;
export declare function createTopicContext(snapshot: ReportEvidence, candidates: readonly TopicCandidate[], layout?: 'references' | 'inline' | 'cards'): TopicContext;
export declare function createTopicOverviewContext(snapshot: ReportEvidence, candidates: readonly TopicCandidate[]): TopicContext;
export declare function createTopicOverviewMergeContext(overviews: readonly TopicOverview[]): TopicContext;
export declare function createTopicComparisonContext(snapshot: ReportEvidence, candidates: readonly TopicCandidate[], priorities: ReadonlyMap<string, number>, limit: 5 | 10): TopicContext;
export declare function getTopicInstructions(stage: keyof typeof TOPIC_PROTOCOLS): string;
export declare function getTopicComparisonInstructions(): string;
export declare function getTopicCatalogInstructions(stage: keyof typeof TOPIC_CATALOG_PROTOCOLS): string;
export declare function createTopicCardContext(snapshot: ReportEvidence, candidates: readonly TopicCandidate[]): TopicContext;
export declare class TopicCardCoverageError extends AnalysisUnitCoverageError {
    readonly cards: TopicCard[];
    readonly missing: string[];
    readonly missingSources: Readonly<Record<string, readonly string[]>>;
    constructor(cards: TopicCard[], missing: string[], allowed: string[], missingSources: Readonly<Record<string, readonly string[]>>, details?: string);
}
export declare function readTopicCards(text: string, context: TopicContext): TopicCard[];
export declare function createTopicCardRepair(error: unknown, context: TopicContext): AnalysisUnitRecovery<TopicCard[]> | undefined;
export declare function createTopicCatalogContext(snapshot: ReportEvidence, cards: readonly TopicCard[], displayLimit?: 5 | 10, compact?: boolean): TopicContext;
export declare function readTopicDirectory(text: string, context: TopicContext, cards: readonly TopicCard[]): TopicCard[];
export declare function readTopicCatalogSelection(text: string, context: TopicContext, limit: 5 | 10): TopicCandidate[];
export declare function readTopicGrouping(text: string, context: TopicContext): TopicCandidate[][];
export declare class TopicPriorityCoverageError extends AnalysisUnitCoverageError {
    readonly priorities: Record<string, number>;
    readonly missing: string[];
    constructor(priorities: Record<string, number>, missing: string[], allowed: string[]);
}
export declare function readTopicPriorities(text: string, context: TopicContext): Record<string, number>;
export declare function createTopicPriorityRepair(error: unknown, context: TopicContext): AnalysisUnitRecovery<Record<string, number>> | undefined;
export declare function selectTopicCandidates(snapshot: ReportEvidence, context: TopicContext, priorities: Readonly<Record<string, number>>, limit: number): {
    selected: TopicCandidate[];
    omitted: TopicCandidate[];
};
export declare function readTopicOverview(text: string, context: TopicContext, submitted?: readonly EvidenceFragment[]): TopicOverview;
