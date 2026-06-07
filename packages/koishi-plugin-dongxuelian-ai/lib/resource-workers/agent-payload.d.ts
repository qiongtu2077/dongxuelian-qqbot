/**
 * MODULE: S2 Agent worker payload helpers.
 * Responsibility: build and validate serializable Agent payloads for standalone workers.
 * Boundary: no Agent execution, no queue state changes, no bot/session references.
 */
type AgentWorkerAction = 'run' | 'resume_pending';
interface AgentWorkerPayload {
    action: AgentWorkerAction;
    entry: string;
    engineInput?: Record<string, unknown>;
    resumeInput?: Record<string, unknown>;
    pendingSnapshot?: Record<string, unknown> | null;
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
