declare const ReportAnalysisError: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis").ReportAnalysisError;
type Diagnostics = ConstructorParameters<typeof ReportAnalysisError>[3];
export interface InputMessage {
    analysisId?: number;
    ts?: number;
    time?: string;
    user?: string;
    userId?: string | number;
    content?: string;
}
export interface MessageFragment {
    id: string;
    sourceId: number;
    part: number;
    partCount: number;
    text: string;
}
export interface InputBatch {
    id: string;
    fragments: MessageFragment[];
    text: string;
}
export interface DigestTopic {
    title: string;
    summary: string;
    participants: string[];
    sourceIds: number[];
}
export interface QuoteReference {
    sourceId: number;
    reason: string;
}
export interface AnalysisRuntime {
    deadlineMs: number;
    workDeadlineMs?: number;
    stageSoftDeadlinesMs?: Record<string, number>;
    signal?: AbortSignal;
    now?: () => number;
    onProgress?: (diagnostics: Diagnostics) => void;
    request(system: string, input: string, maxTokens: number, extra: Record<string, unknown>): Promise<string>;
}
export declare function packInputBatches(messages: InputMessage[]): InputBatch[];
export declare function selectRepresentativeMessages(messages: InputMessage[], userId: string, maxSamples?: number): InputMessage[];
export declare function requestAnalysisUnit<T>(runtime: AnalysisRuntime, diagnostics: Diagnostics, unit: {
    id: string;
    stage: string;
    sourceIds: number[];
    timestamps: number[];
    onSubmitted?: () => void;
}, system: string, input: string, maxTokens: number, timeoutMs: number, validate: (text: string) => T): Promise<T>;
export declare function summarizeCompleteInput(messages: InputMessage[], diagnostics: Diagnostics, runtime: AnalysisRuntime): Promise<{
    digest: string;
    sourceIds: Set<number>;
    quoteRefs: QuoteReference[];
}>;
export {};
