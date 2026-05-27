/**
 * MODULE: Agent 消息构建。
 * 职责: 组装稳定 system、动态 systemExtra、历史和当前用户输入。
 * 边界: 不调用 AI API、不执行工具、不写对话历史。
 * 状态: 无。
 */
type AgentMessageRole = 'system' | 'user' | 'assistant';
interface AgentMessage {
    role: AgentMessageRole;
    content: string;
}
interface BuildAgentMessagesInput {
    userMessage: string;
    userName?: string;
    tools?: unknown[];
    systemExtra?: AgentMessage[];
    history?: unknown;
    agentMode?: boolean;
}
declare function sanitizeAgentHistory(history?: unknown): AgentMessage[];
declare function buildAgentMessages({ userMessage, userName, tools, systemExtra, history, agentMode }: BuildAgentMessagesInput): AgentMessage[];
declare const _default: {
    buildAgentMessages: typeof buildAgentMessages;
    sanitizeAgentHistory: typeof sanitizeAgentHistory;
};
export = _default;
