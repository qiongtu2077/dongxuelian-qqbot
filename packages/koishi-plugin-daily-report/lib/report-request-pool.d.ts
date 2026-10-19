export interface ReportUpstreamFailure {
    code: string;
    status: number;
    retryable: boolean;
}
export declare class ReportRequestBoundaryError extends Error {
    readonly kind: 'upstream' | 'budget' | 'contract';
    readonly upstreamFailure: Readonly<ReportUpstreamFailure> | null;
    constructor(kind: 'upstream' | 'budget' | 'contract', message: string, upstreamFailure?: ReportUpstreamFailure | null);
}
export declare class ReportRequestPool {
    private readonly limit;
    private active;
    private readonly waiting;
    private readonly idle;
    constructor(limit: 1 | 2);
    run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
    drain(): Promise<void>;
    private acquire;
    private release;
    private notifyIdle;
}
