type AgentWorkerAction = 'run' | 'resume_pending';
interface AgentRunWorkerInput {
    userMessage?: unknown;
    userName?: unknown;
    userId?: unknown;
    channelKey?: unknown;
    channel?: unknown;
    systemExtra?: unknown;
    history?: unknown;
    forceTools?: unknown;
    preExecuteTools?: unknown;
    enableThinking?: unknown;
    agentMode?: unknown;
    scheduledTask?: unknown;
    contextPolicy?: unknown;
    isAdmin?: unknown;
}
interface AgentResumeWorkerInput {
    channelKey?: unknown;
    userId?: unknown;
    channel?: unknown;
    expectedId?: unknown;
    isAdmin?: unknown;
}
interface AgentPendingSnapshot {
    id?: unknown;
    toolName?: unknown;
    args?: unknown;
    userId?: unknown;
    channelKey?: unknown;
    channel?: unknown;
    expireAt?: unknown;
    resume?: unknown;
}
interface AgentWorkerPayload {
    action: AgentWorkerAction;
    entry: string;
    engineInput?: AgentRunWorkerInput;
    resumeInput?: AgentResumeWorkerInput;
    pendingSnapshot?: AgentPendingSnapshot | null;
    warnings?: string[];
}
interface AgentWorkerTaskLike {
    payload?: unknown;
}
declare function toJsonSafe(value: unknown, depth?: number): unknown;
declare function createAgentRunWorkerPayload(entry: string, input?: Record<string, unknown>, warnings?: string[]): AgentWorkerPayload;
declare function createAgentResumeWorkerPayload(entry: string, input?: Record<string, unknown>, pendingSnapshot?: Record<string, unknown> | null, warnings?: string[]): AgentWorkerPayload;
declare function getAgentWorkerPayload(task: AgentWorkerTaskLike | null | undefined): AgentWorkerPayload | null;
declare function getAgentWorkerPayloadStatus(task: AgentWorkerTaskLike | null | undefined): {
    executable: boolean;
    reason: string;
    payload: AgentWorkerPayload | null;
};
declare const _default: {
    createAgentRunWorkerPayload: typeof createAgentRunWorkerPayload;
    createAgentResumeWorkerPayload: typeof createAgentResumeWorkerPayload;
    getAgentWorkerPayload: typeof getAgentWorkerPayload;
    getAgentWorkerPayloadStatus: typeof getAgentWorkerPayloadStatus;
    toJsonSafe: typeof toJsonSafe;
};
export = _default;
