interface WorkerLaunchSpec {
    type: string;
    name: string;
    maxOldSpaceMb: number;
    command: string;
    args: string[];
}
interface SupervisorOptions {
    start?: boolean;
    once?: boolean;
    types?: string[];
}
interface ResourceWorkerStateLike {
    name?: string;
    pid?: unknown;
    alive?: boolean;
    heartbeatAt?: string;
    heartbeatLagMs?: number | null;
    step?: string;
    kind?: string;
    loopIterations?: unknown;
    lastClaimAttemptAt?: string;
    lastTaskFinishedAt?: string;
    currentTaskId?: string;
    currentTaskStartedAt?: string;
    parked?: unknown;
    parkSleepMs?: unknown;
}
declare function clearOwnedWorkerProcesses(): void;
declare function recoverZombieWorker(worker: ResourceWorkerStateLike): boolean;
declare function buildWorkerLaunchSpec(type: string): WorkerLaunchSpec;
declare function startWorkerProcess(type: string): Record<string, unknown>;
declare function ensureWorkerProcesses(types?: string[]): unknown[];
declare function auditStaleRunningTasks(staleMs?: number): number;
declare function auditStaleClaimingTasks(staleMs?: number): number;
declare function auditDeferredTasks(limit?: number): Record<string, number>;
declare function getSupervisorStatus(): Record<string, unknown>;
declare function runSupervisorOnce(options?: SupervisorOptions): Record<string, unknown>;
declare const _default: {
    buildWorkerLaunchSpec: typeof buildWorkerLaunchSpec;
    startWorkerProcess: typeof startWorkerProcess;
    recoverZombieWorker: typeof recoverZombieWorker;
    clearOwnedWorkerProcesses: typeof clearOwnedWorkerProcesses;
    ensureWorkerProcesses: typeof ensureWorkerProcesses;
    auditStaleRunningTasks: typeof auditStaleRunningTasks;
    auditStaleClaimingTasks: typeof auditStaleClaimingTasks;
    auditDeferredTasks: typeof auditDeferredTasks;
    getSupervisorStatus: typeof getSupervisorStatus;
    runSupervisorOnce: typeof runSupervisorOnce;
};
export = _default;
