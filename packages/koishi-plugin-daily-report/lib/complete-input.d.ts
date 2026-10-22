/** 完整入选消息的长度分批、结构化摘要、来源追踪与分层合并。 */
declare const loadManagementModule: typeof import("koishi-plugin-dongxuelian-ai/lib/public/management-runtime").loadManagementModule;
declare const ReportAnalysisError: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis").ReportAnalysisError;
type Diagnostics = ConstructorParameters<typeof ReportAnalysisError>[3];
type ApiExtra = NonNullable<Parameters<ReturnType<typeof loadManagementModule<'core.api'>>['requestChatCompletions']>[2]>;
type ExecutionStep = Parameters<NonNullable<ApiExtra['_onRequestAttempt']>>[0];
type ExecutionMetadata = Parameters<NonNullable<ApiExtra['_onRequestExecution']>>[0];
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
export interface ExchangeResult {
    topics: DigestTopic[];
    quoteRefs: QuoteReference[];
    retainedRefs: string[];
    segments?: ExchangeResult[];
}
export interface ValidatedExchange {
    result: ExchangeResult;
    records: Record<string, unknown>[];
    coveredRefs: string[];
    missingRefs: string[];
}
export interface AnalysisUnitRecovery<T> {
    system: string;
    input: string;
    validate(text: string): T;
}
export interface AnalysisUnitDescriptor {
    id: string;
    stage: string;
    sourceIds: number[];
    timestamps: number[];
}
export interface AnalysisUnitAttempt {
    attempt: number;
    system: string;
    input: string;
    maxTokens: number;
    response: string;
    error: string;
    allowedRefs: string[];
    missingRefs: string[];
    elapsedMs: number;
    upstreamAttempts?: ExecutionStep[];
    execution?: ExecutionMetadata;
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
    maxRequestCount?: number;
    recoveryStepIndex?: (execution: ExecutionStep | undefined) => number | undefined;
    recoveryInstructions?: string;
    requireNormalFinish?: boolean;
    shouldRecover?: (error: unknown) => boolean;
    retryOriginalRequest?: (error: unknown) => boolean;
    onUnitCompleted?: (unit: AnalysisUnitDescriptor, attempts: AnalysisUnitAttempt[], result: unknown) => void;
    onUnitFailed?: (unit: AnalysisUnitDescriptor, attempts: AnalysisUnitAttempt[]) => void;
    request(system: string, input: string, maxTokens: number, extra: Record<string, unknown>): Promise<string>;
}
export declare function packInputBatches(messages: InputMessage[]): InputBatch[];
export declare function selectRepresentativeMessages(messages: InputMessage[], userId: string, maxSamples?: number): InputMessage[];
export declare function parseExchangeObject(text: string): Record<string, unknown>;
export declare function parseExchangeRecords(text: string): Record<string, unknown>[];
export declare function assertExchangeFields(value: Record<string, unknown>, fields: string[], path: string): void;
export declare function assertExchangeRef(value: unknown, allowed: Map<string, unknown>, path: string): string;
export declare function createDigestExchange(topics: DigestTopic[], quotes: QuoteReference[], messages: InputMessage[]): ExchangeContext;
export declare function readValidatedExchange(text: string, context: ExchangeContext, maxTextChars?: number, maxQuoteRecords?: number): ValidatedExchange;
export declare class AnalysisUnitCoverageError extends Error {
    readonly allowedRefs: string[];
    readonly missingRefs: string[];
    constructor(message: string, allowedRefs: string[], missingRefs: string[]);
}
export declare class ExchangeCoverageError extends AnalysisUnitCoverageError {
    readonly validated: ValidatedExchange;
    constructor(validated: ValidatedExchange, allowedRefs: string[]);
}
export declare function readExchange(text: string, context: ExchangeContext, maxTextChars?: number, preserveUnselected?: boolean, maxQuoteRecords?: number): ExchangeResult;
export declare function exchangeInstructions(maxTextChars: number): string;
export declare class AnalysisUnitRequestTimeoutError extends Error {
    constructor();
}
export declare function requestAnalysisUnit<T>(runtime: AnalysisRuntime, diagnostics: Diagnostics, unit: {
    id: string;
    stage: string;
    sourceIds: number[];
    timestamps: number[];
    onSubmitted?: () => void;
}, system: string, input: string, maxTokens: number, timeoutMs: number, validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): Promise<T>;
export declare function summarizeCompleteInput(messages: InputMessage[], diagnostics: Diagnostics, runtime: AnalysisRuntime): Promise<{
    digest: string;
    topics: DigestTopic[];
    sourceIds: Set<number>;
    quoteRefs: QuoteReference[];
}>;
export {};
