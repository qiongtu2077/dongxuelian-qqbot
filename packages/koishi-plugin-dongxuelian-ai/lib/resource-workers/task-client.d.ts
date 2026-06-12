interface ResourceTaskLike extends Record<string, unknown> {
    id: string;
    kind: string;
    status: string;
    source: string;
    channelKey: string;
    userId: string;
    priority: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    timeoutMs: number;
    payload: Record<string, unknown>;
    notify: Record<string, unknown>;
}
interface AdmissionDecisionLike {
    decision: string;
    reason?: string;
}
interface ResourceDirectiveLike {
    action: string;
    reason?: string;
}
type SkippedAdmissionDecision = {
    decision: 'run_now';
    reason: string;
};
type SkippedDirective = {
    action: 'pass';
    reason: string;
};
interface SubmitWorkerTaskInput {
    id?: string;
    kind: string;
    source?: string;
    channelKey?: string;
    userId?: string;
    priority?: number;
    expiresAt?: string;
    timeoutMs?: number;
    payload?: Record<string, unknown>;
    notify?: Record<string, unknown>;
}
interface SubmitWorkerTaskOptions {
    checkAdmission?: boolean;
    exclusive?: boolean;
}
interface SubmitWorkerTaskWithAdmissionResult {
    task: ResourceTaskLike;
    admission: AdmissionDecisionLike | SkippedAdmissionDecision;
    directive: ResourceDirectiveLike | SkippedDirective;
    accepted: boolean;
}
declare function buildAdmissionInput(taskId: string, input: SubmitWorkerTaskInput, options?: SubmitWorkerTaskOptions): Record<string, unknown>;
declare function submitWorkerTask(input: SubmitWorkerTaskInput): ResourceTaskLike;
declare function submitWorkerTaskWithAdmission(input: SubmitWorkerTaskInput, options?: SubmitWorkerTaskOptions): SubmitWorkerTaskWithAdmissionResult;
declare const _default: {
    submitWorkerTask: typeof submitWorkerTask;
    submitWorkerTaskWithAdmission: typeof submitWorkerTaskWithAdmission;
    buildAdmissionInput: typeof buildAdmissionInput;
};
export = _default;
