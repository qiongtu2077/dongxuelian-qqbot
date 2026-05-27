/**
 * MODULE: Agent 会话索引。
 * 职责: 记录 Agent 调用产生的会话摘要，供 Dashboard 查询。
 * 边界: 不保存普通聊天历史，不调用 AI API，不执行工具。
 * 状态: sessions (Map，最多 100 个会话，每会话最多 20 条记录)。
 */
interface AgentSessionTurn {
    at: number;
    userMessage: string;
    reply: string;
    toolCalls: number;
    pendingId: string | null;
}
interface AgentSession {
    id: string;
    channel: string;
    channelKey: string;
    userId: string;
    userName: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    turns: AgentSessionTurn[];
    toolCalls: number;
    pendingId?: string | null;
    lastMessage?: string;
    lastReply?: string;
}
interface RecordAgentSessionInput {
    channel?: string;
    channelKey?: string;
    userId?: string;
    userName?: string;
    userMessage?: string;
    reply?: string;
    toolCalls?: number;
    pendingId?: string | null;
}
interface AgentSessionSummary {
    id: string;
    channel: string;
    channelKey: string;
    userId: string;
    userName: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    turns: number;
    toolCalls: number;
    pendingId: string | null;
    lastMessage: string;
    lastReply: string;
}
declare function buildAgentSessionId(channelKey: unknown, userId: unknown, channel?: unknown): string;
declare function recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply, toolCalls, pendingId }?: RecordAgentSessionInput): string;
declare function listAgentSessions(): AgentSessionSummary[];
declare function getAgentSession(id: unknown): AgentSession | null;
declare function clearAgentSessions(): void;
declare const _default: {
    buildAgentSessionId: typeof buildAgentSessionId;
    recordAgentSession: typeof recordAgentSession;
    listAgentSessions: typeof listAgentSessions;
    getAgentSession: typeof getAgentSession;
    clearAgentSessions: typeof clearAgentSessions;
};
export = _default;
