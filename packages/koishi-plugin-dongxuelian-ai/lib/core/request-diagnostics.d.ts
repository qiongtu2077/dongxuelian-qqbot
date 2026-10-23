interface FailureDetails {
    upstreamCode?: string;
    summary?: string;
    requestId?: string;
    reason?: string;
    finishReason?: string;
    contentLength?: number;
    reasoningLength?: number;
    usage?: Record<string, unknown>;
}
interface DiagnosticEvent {
    requestId: string;
    capability: string;
    purpose: string;
    provider: string;
    model: string;
    status: 'success' | 'failure';
    elapsedMs: number;
    attempt: number;
    fallback: boolean;
    code?: string;
    httpStatus?: number;
    reason?: string;
    summary?: string;
    upstreamCode?: string;
    upstreamRequestId?: string;
    finishReason?: string;
    contentLength?: number;
    reasoningLength?: number;
    maxTokens?: number;
    usageReadable?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    imageSource?: string;
    imageTarget?: string;
    imageDemandId?: string;
}
interface ImageRequestEvent {
    source: 'explicit-image' | 'random-image' | 'history-tool';
    target: string;
    demandId: string;
    event: 'requested' | 'owned' | 'reused' | 'pending' | 'unavailable' | 'completed' | 'failed';
    force?: boolean;
    cache?: 'detail' | 'summary';
}
declare class ModelRequestError extends Error {
    code: string;
    retryable: boolean;
    status: number;
    details: FailureDetails;
    constructor(message: string, code: string, retryable: boolean, status?: number, details?: FailureDetails);
}
declare function sanitizeDiagnosticText(value: unknown, secrets?: string[], limit?: number): string;
declare function formatModelHttpStatus(status: number): string;
declare function assertModelResponseOk(response: Response, secrets?: string[]): Promise<void>;
declare function getModelFailureReason(error: ModelRequestError): string;
declare function getFailedModelUsage(error: unknown): {
    usage: Record<string, unknown> | undefined;
    readable: boolean;
    inputTokens: number;
    outputTokens: number;
    total: number;
};
declare function readImageRequestDiagnostic(value: unknown): {
    source: ImageRequestEvent['source'];
    target: string;
    demandId: string;
} | null;
declare function recordImageRequestEvent(event: ImageRequestEvent): void;
declare function createDiagnosticRequestId(): string;
declare function buildModelFailureNotice(error: unknown, timedOut: boolean, requestId: string, purpose: string): {
    requestId: string;
    purpose: string;
    reason: string;
    status: number;
    code: string;
    summary: string | undefined;
    upstreamCode: string | undefined;
    upstreamRequestId: string | undefined;
};
declare function recordModelDiagnostic(event: DiagnosticEvent): void;
declare function formatRecentModelDiagnostic(): string;
declare const _default: {
    ModelRequestError: typeof ModelRequestError;
    sanitizeDiagnosticText: typeof sanitizeDiagnosticText;
    assertModelResponseOk: typeof assertModelResponseOk;
    getModelFailureReason: typeof getModelFailureReason;
    getFailedModelUsage: typeof getFailedModelUsage;
    formatModelHttpStatus: typeof formatModelHttpStatus;
    createDiagnosticRequestId: typeof createDiagnosticRequestId;
    buildModelFailureNotice: typeof buildModelFailureNotice;
    recordModelDiagnostic: typeof recordModelDiagnostic;
    formatRecentModelDiagnostic: typeof formatRecentModelDiagnostic;
    readImageRequestDiagnostic: typeof readImageRequestDiagnostic;
    recordImageRequestEvent: typeof recordImageRequestEvent;
};
export = _default;
