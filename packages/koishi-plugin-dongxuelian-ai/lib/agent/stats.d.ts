/**
 * MODULE: Agent 调用统计。
 * 职责: 记录工具调用次数、耗时、渠道。
 * 边界: 只计数，不持久化。
 * 状态: calls (Array，最多 500 条)。
 */
interface AgentCallMeta {
    durationMs?: unknown;
    tokens?: unknown;
    ok?: boolean;
}
interface AgentCall {
    tool: string;
    channel: string;
    at: number;
    ok: boolean;
    durationMs: number;
    tokens: number;
}
interface AgentToolDetail {
    total: number;
    success: number;
    failed: number;
    durationMs: number;
    tokens: number;
    avgDurationMs?: number;
    avgTokens?: number;
    successRate?: number;
}
interface AgentStats {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    totalTokens: number;
    avgDurationMs: number;
    avgTokens: number;
    recent: AgentCall[];
    byTool: Record<string, number>;
    byToolDetail: Record<string, AgentToolDetail>;
    byChannel: Record<string, number>;
}
declare function recordCall(toolName: string, channel?: string, meta?: AgentCallMeta): void;
declare function getStats(): AgentStats;
declare const _default: {
    recordCall: typeof recordCall;
    getStats: typeof getStats;
};
export = _default;
