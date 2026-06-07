interface AgentResourceRunOptions<T> {
    channel?: string;
    channelKey: string;
    userId: string;
    source?: string;
    taskKind?: string;
    priority?: number;
    timeoutMs?: number;
    step?: string;
    payload?: Record<string, unknown>;
    run: () => Promise<T> | T;
}
declare function runAgentWithResourceGate<T>(options: AgentResourceRunOptions<T>): Promise<T>;
declare const _default: {
    runAgentWithResourceGate: typeof runAgentWithResourceGate;
};
export = _default;
