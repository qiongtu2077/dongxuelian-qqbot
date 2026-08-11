type AdmissionDecisionType = 'run_now' | 'queue' | 'downgrade' | 'defer' | 'reject' | 'silent_drop';
type TaskBudgetInput = Record<string, unknown>;
interface TaskBudget {
    taskId: string;
    kind: string;
    source: string;
    channelKey: string;
    userId: string;
    exclusive: boolean;
    priority: number;
    minMemMb: number;
    degradable: boolean;
    deferable: boolean;
    fallbacks: string[];
    queueTimeoutMs: number;
    runTimeoutMs: number;
}
interface ResourceSnapshotLike {
    resourceState: string;
    botMode: string;
    memAvailableMb: number | null;
    locked: boolean;
    running: unknown | null;
}
interface AdmissionDecision {
    decision: AdmissionDecisionType;
    reason: string;
    resourceState: string;
    botMode: string;
    memAvailableMb: number | null;
    fallback?: string;
    budget: unknown;
    snapshot: unknown;
}
declare function admissionEventFile(date?: Date): string;
declare function decideBelowTaskMinMemory(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): AdmissionDecision | null;
declare function decideAdmission(input: TaskBudgetInput, snapshot?: ResourceSnapshotLike): AdmissionDecision;
declare function writeAdmissionEvent(decision: AdmissionDecision): void;
declare function admitTask(input: TaskBudgetInput): AdmissionDecision;
declare const _default: {
    admissionEventFile: typeof admissionEventFile;
    decideAdmission: typeof decideAdmission;
    decideBelowTaskMinMemory: typeof decideBelowTaskMinMemory;
    writeAdmissionEvent: typeof writeAdmissionEvent;
    admitTask: typeof admitTask;
};
export = _default;
