interface WorkerTaskResult extends Record<string, unknown> {
    defer?: boolean;
    reason?: string;
    mode?: string;
}
interface AgentWorkerTaskLike {
    id?: string;
    payload?: Record<string, unknown>;
}
declare function runAgentWorkerTask(task: AgentWorkerTaskLike): Promise<WorkerTaskResult>;
declare const _default: {
    runAgentWorkerTask: typeof runAgentWorkerTask;
};
export = _default;
