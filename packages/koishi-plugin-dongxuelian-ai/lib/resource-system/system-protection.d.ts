interface TerminateProcessTreeOptions {
    reason?: string;
    source?: string;
    taskId?: string;
    kind?: string;
    owner?: string;
    timeoutMs?: number;
}
interface TerminateRecordedProcessPidsOptions extends TerminateProcessTreeOptions {
    eventNames?: string[];
    limit?: number;
}
declare function terminateProcessTree(pidValue: unknown, options?: TerminateProcessTreeOptions): Record<string, unknown>;
declare function terminateRecordedProcessPids(options?: TerminateRecordedProcessPidsOptions): Record<string, unknown>;
declare function checkWorkerMemoryLimit(workerName: string, limitMb?: number): Record<string, unknown>;
declare function collectProcessMetrics(extra?: Record<string, unknown>): Record<string, unknown>;
declare function writeProcessCleanupEvent(data: Record<string, unknown>): void;
declare function getSystemProtectionStatus(): Record<string, unknown>;
declare const _default: {
    RESOURCE_SYSTEM_ROOT: any;
    collectProcessMetrics: typeof collectProcessMetrics;
    checkWorkerMemoryLimit: typeof checkWorkerMemoryLimit;
    writeProcessCleanupEvent: typeof writeProcessCleanupEvent;
    terminateProcessTree: typeof terminateProcessTree;
    terminateRecordedProcessPids: typeof terminateRecordedProcessPids;
    getSystemProtectionStatus: typeof getSystemProtectionStatus;
};
export = _default;
