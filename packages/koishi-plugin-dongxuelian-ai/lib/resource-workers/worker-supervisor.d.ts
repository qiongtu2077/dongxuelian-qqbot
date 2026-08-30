type ResourceWorkerState = import('./task-types').ResourceWorkerState;
interface WorkerLaunchSpec {
    type: string;
    name: string;
    generation: string;
    startToken: string;
    maxOldSpaceMb: number;
    command: string;
    args: string[];
}
interface SupervisorOptions {
    start?: boolean;
    once?: boolean;
    types?: string[];
    generation?: string;
}
declare function clearOwnedWorkerProcesses(): void;
declare function stopOwnedWorkerProcesses(timeoutMs?: number): Promise<Record<string, unknown>>;
declare function recoverZombieWorker(worker: ResourceWorkerState): boolean;
declare function buildWorkerLaunchSpec(type: string, generation?: string): WorkerLaunchSpec;
declare function startWorkerProcess(type: string, generation?: string): Record<string, unknown>;
declare function selectWorkerTypesToStart(types: string[], activeNames: Set<string>, snapshot: Record<string, unknown>): string[];
declare function ensureWorkerProcesses(types?: string[], options?: SupervisorOptions): unknown[];
declare function auditStaleRunningTasks(staleMs?: number): number;
declare function auditTimedOutRunningTasks(now?: number): number;
declare function auditStaleClaimingTasks(staleMs?: number): number;
declare function auditDeferredTasks(limit?: number): Record<string, number>;
declare function getSupervisorStatus(): Record<string, unknown>;
declare function runSupervisorOnce(options?: SupervisorOptions): Record<string, unknown>;
declare const _default: {
    buildWorkerLaunchSpec: typeof buildWorkerLaunchSpec;
    startWorkerProcess: typeof startWorkerProcess;
    recoverZombieWorker: typeof recoverZombieWorker;
    clearOwnedWorkerProcesses: typeof clearOwnedWorkerProcesses;
    stopOwnedWorkerProcesses: typeof stopOwnedWorkerProcesses;
    selectWorkerTypesToStart: typeof selectWorkerTypesToStart;
    ensureWorkerProcesses: typeof ensureWorkerProcesses;
    auditTimedOutRunningTasks: typeof auditTimedOutRunningTasks;
    auditStaleRunningTasks: typeof auditStaleRunningTasks;
    auditStaleClaimingTasks: typeof auditStaleClaimingTasks;
    auditDeferredTasks: typeof auditDeferredTasks;
    getSupervisorStatus: typeof getSupervisorStatus;
    runSupervisorOnce: typeof runSupervisorOnce;
};
export = _default;
