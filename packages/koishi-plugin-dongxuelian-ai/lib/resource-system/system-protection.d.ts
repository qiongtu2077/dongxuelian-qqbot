interface TerminateProcessTreeOptions {
    reason?: string;
    source?: string;
    taskId?: string;
    kind?: string;
    owner?: string;
    timeoutMs?: number;
    allowSingleProcessFallback?: boolean;
    windowsRuntime?: WindowsTerminationRuntime;
}
interface TerminateRecordedProcessPidsOptions extends TerminateProcessTreeOptions {
    eventNames?: string[];
    limit?: number;
}
interface WindowsTaskkillResult {
    status: number | null;
    signal?: string | null;
    error?: unknown;
    stdout?: unknown;
    stderr?: unknown;
}
interface WindowsTerminationRuntime {
    runTaskkill(pid: number, timeoutMs: number): WindowsTaskkillResult;
    isPidAlive(pid: number): boolean;
    killPid(pid: number): void;
}
declare function cleanupOldProcessMetricsFiles(now?: number): number;
declare function terminateProcessTree(pidValue: unknown, options?: TerminateProcessTreeOptions): Record<string, unknown>;
declare function terminateRecordedProcessPids(options?: TerminateRecordedProcessPidsOptions): Record<string, unknown>;
declare function checkWorkerMemoryLimit(workerName: string, limitMb?: number): Record<string, unknown>;
declare function collectProcessMetrics(extra?: Record<string, unknown>): Record<string, unknown>;
declare function writeProcessCleanupEvent(data: Record<string, unknown>): void;
declare function getSystemProtectionStatus(): Record<string, unknown>;
declare const _default: {
    RESOURCE_SYSTEM_ROOT: string;
    PROCESS_METRICS_RETENTION_MS: number;
    MEMORY_BLACK_THRESHOLD_MB: number;
    collectProcessMetrics: typeof collectProcessMetrics;
    checkWorkerMemoryLimit: typeof checkWorkerMemoryLimit;
    writeProcessCleanupEvent: typeof writeProcessCleanupEvent;
    terminateProcessTree: typeof terminateProcessTree;
    terminateRecordedProcessPids: typeof terminateRecordedProcessPids;
    getSystemProtectionStatus: typeof getSystemProtectionStatus;
    cleanupOldProcessMetricsFiles: typeof cleanupOldProcessMetricsFiles;
};
export = _default;
