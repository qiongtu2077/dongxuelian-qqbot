interface SubmitAgentWorkerTaskOptions {
    channel?: string;
    channelKey: string;
    userId: string;
    source?: string;
    taskKind?: string;
    priority?: number;
    timeoutMs?: number;
    maxActivePerUser?: number;
    payload: Record<string, unknown>;
}
interface AgentWorkerSubmissionResult {
    accepted: boolean;
    task?: ResourceTaskLike;
    admission?: AdmissionDecisionLike;
    taskId?: string;
    message: string;
    status: number;
}
interface ResourceTaskLike extends Record<string, unknown> {
    id?: string;
}
interface AdmissionDecisionLike {
    decision?: string;
    reason?: unknown;
}
declare function countActiveAgentWorkerTasks(kind: string, channelKey: string, userId: string): number;
declare function submitAgentWorkerTask(options: SubmitAgentWorkerTaskOptions): AgentWorkerSubmissionResult;
declare const _default: {
    submitAgentWorkerTask: typeof submitAgentWorkerTask;
    countActiveAgentWorkerTasks: typeof countActiveAgentWorkerTasks;
};
export = _default;
