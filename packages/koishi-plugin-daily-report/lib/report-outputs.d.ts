/**
 * MODULE: 简明有据的金句、本人画像和锐评协议。
 * 职责: 完整原话恢复、本人证据、合法不足状态及程序统计引用。
 * 边界: 不调用模型、不推断人格、不从昵称或摘要反解析身份。
 */
import { AnalysisUnitCoverageError } from './complete-input';
import type { AnalysisUnitRecovery } from './complete-input';
import type { ReportEvidence } from './report-evidence';
interface OutputSource {
    sourceId: number;
    userId: string;
    name: string;
    time: string;
    text: string;
    excerptOnly: boolean;
    role: 'primary' | 'auxiliary';
}
interface OutputMember {
    userId: string;
    name: string;
    refs: string[];
}
export interface GroundedOutputContext {
    input: string;
    sources: Map<string, OutputSource>;
    members: Map<string, OutputMember>;
    statistics: Map<string, string>;
    people: Map<string, {
        userId: string;
        name: string;
    }>;
}
export interface GroundedQuote {
    ref: string;
    sourceId: number;
    userId: string;
    sender: string;
    content: string;
    reason: string;
}
export interface GroundedPortrait {
    member: string;
    userId: string;
    name: string;
    title: string;
    reason: string;
    mbti: string;
    refs: string[];
}
export interface GroundedPortraitResult {
    portraits: GroundedPortrait[];
    completedMembers: string[];
    insufficientMembers: string[];
}
export interface GroundedReview {
    title: string;
    summary: string;
    refs: string[];
    statRefs: string[];
    dimensions: Array<{
        name: string;
        percentage: number;
        comment: string;
        refs: string[];
        statRefs: string[];
    }>;
}
export declare const GROUNDED_OUTPUT_VERSION = "grounded-report-1";
export declare const GROUNDED_QUOTE_CHARACTERS = 90;
export declare function createGroundedOutputContext(snapshot: ReportEvidence, entries: readonly {
    sourceId: number;
    text?: string;
    role?: 'primary' | 'auxiliary';
}[], statistics?: readonly {
    ref: string;
    text: string;
}[]): GroundedOutputContext;
export declare function getGroundedOutputInstructions(module: 'quotes' | 'portraits' | 'review'): string;
export declare function readGroundedQuotes(text: string, context: GroundedOutputContext): GroundedQuote[];
export declare class GroundedPortraitCoverageError extends AnalysisUnitCoverageError {
    readonly value: GroundedPortraitResult;
    readonly missing: string[];
    constructor(value: GroundedPortraitResult, missing: string[], allowed: string[]);
}
export declare function readGroundedPortraits(text: string, context: GroundedOutputContext): GroundedPortraitResult;
export declare function createGroundedPortraitRepair(error: unknown, context: GroundedOutputContext): AnalysisUnitRecovery<GroundedPortraitResult> | undefined;
export declare function readGroundedReview(text: string, context: GroundedOutputContext): GroundedReview | null;
export {};
