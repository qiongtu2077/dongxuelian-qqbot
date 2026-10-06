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
    content: string;
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
/** 引用表只存在于程序内，不把真实来源集合交给模型搬运。 */
export interface ExchangeContext {
    items: Map<string, DigestTopic>;
    requiredRefs: string[];
    quotes: Map<string, QuoteReference>;
    input: string;
}
export interface AnalysisRuntime {
    deadlineMs: number;
    workDeadlineMs?: number;
    stageSoftDeadlinesMs?: Record<string, number>;
    signal?: AbortSignal;
    now?: () => number;
    onProgress?: (diagnostics: Diagnostics) => void;
    topicRange?: {
        min: number;
        max: number;
    };
    request(system: string, input: string, maxTokens: number, extra: Record<string, unknown>): Promise<string>;
}
export declare function packInputBatches(messages: InputMessage[]): InputBatch[];
export declare function selectRepresentativeMessages(messages: InputMessage[], userId: string, maxSamples?: number): InputMessage[];
export declare function parseExchangeObject(text: string): Record<string, unknown>;
export declare function parseExchangeRecords(text: string): Record<string, unknown>[];
export declare function assertExchangeFields(value: Record<string, unknown>, fields: string[], path: string): void;
export declare function assertExchangeRef(value: unknown, allowed: Map<string, unknown>, path: string): string;
export declare function createDigestExchange(topics: DigestTopic[], quotes: QuoteReference[], messages: InputMessage[]): ExchangeContext;
export declare function readExchange(text: string, context: ExchangeContext, maxTextChars?: number, preserveUnselected?: boolean): {
    topics: DigestTopic[];
    quoteRefs: QuoteReference[];
    retainedRefs: string[];
};
export declare function exchangeInstructions(maxTextChars: number): string;
export declare function requestAnalysisUnit<T>(runtime: AnalysisRuntime, diagnostics: Diagnostics, unit: {
    id: string;
    stage: string;
    sourceIds: number[];
    timestamps: number[];
    onSubmitted?: () => void;
}, system: string, input: string, maxTokens: number, timeoutMs: number, validate: (text: string) => T): Promise<T>;
export declare function summarizeCompleteInput(messages: InputMessage[], diagnostics: Diagnostics, runtime: AnalysisRuntime): Promise<{
    digest: string;
    topics: DigestTopic[];
    sourceIds: Set<number>;
    quoteRefs: QuoteReference[];
}>;
export {};
