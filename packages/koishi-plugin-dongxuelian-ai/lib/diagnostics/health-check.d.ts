interface HealthProviderResult {
    provider: string;
    status: 'ok' | 'skip' | 'fail';
    reason?: string;
    latency: number;
}
interface HealthReport {
    ts: number;
    activeProvider: string | undefined;
    activeModel: string;
    results: HealthProviderResult[];
}
declare function runHealthCheck(force?: boolean): Promise<HealthReport>;
declare function formatHealthReport(report: HealthReport): string;
declare function resetHealthCache(): void;
declare const _default: {
    runHealthCheck: typeof runHealthCheck;
    formatHealthReport: typeof formatHealthReport;
    resetHealthCache: typeof resetHealthCache;
};
export = _default;
