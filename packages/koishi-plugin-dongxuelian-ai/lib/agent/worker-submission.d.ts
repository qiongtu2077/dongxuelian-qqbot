interface SubmitAgentWorkerTaskOptions {
    channel?: string;
    channelKey: string;
    userId: string;
    source?: string;
    taskKind?: string;
    priority?: number;
    timeoutMs?: number;
    maxActivePerUser?: number;
    notifyTarget?: 'qq-group' | 'dashboard' | 'none' | string;
    acceptedMessageMode?: 'normal' | 'quiet';
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
declare function formatAcceptedMessage(task: ResourceTaskLike | null | undefined, admission: AdmissionDecisionLike | null | undefined, mode?: 'normal' | 'quiet'): string;
declare function submitAgentWorkerTask(options: SubmitAgentWorkerTaskOptions): AgentWorkerSubmissionResult;
declare const _default: {
    submitAgentWorkerTask: typeof submitAgentWorkerTask;
    countActiveAgentWorkerTasks: typeof countActiveAgentWorkerTasks;
    formatAcceptedMessage: typeof formatAcceptedMessage;
};
export = _default;
