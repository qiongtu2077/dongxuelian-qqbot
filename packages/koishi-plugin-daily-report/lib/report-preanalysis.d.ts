declare const createReportPeriod: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period").createReportPeriod;
interface PreanalysisOptions {
    taskId: string;
    channelKey: string;
    period: ReturnType<typeof createReportPeriod>;
    startedAtMs: number;
    deadlineMs: number;
    signal: AbortSignal;
    assertActive(): void;
    assertLease(): void;
    hasForegroundPending(): boolean;
}
export declare function planReportPreanalysisTask(options: PreanalysisOptions): Promise<{
    ready: boolean;
    reason: string;
    catalogId?: string;
}>;
export declare function runReportPreanalysisTask(options: PreanalysisOptions): Promise<Record<string, unknown>>;
export {};
