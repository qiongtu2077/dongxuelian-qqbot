/**
 * MODULE: Agent 消息构建。
 * 职责: 组装稳定 system、动态 systemExtra、历史和当前用户输入。
 * 边界: 不调用 AI API、不执行工具、不写对话历史。
 * 状态: 无。
 */
type AgentMessageRole = 'system' | 'user' | 'assistant';
interface AgentHistoryMessage {
    role: AgentMessageRole;
    content: string;
    images?: string[];
}
type AgentContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: {
        url: string;
    };
};
interface AgentMessage {
    role: AgentMessageRole;
    content: string | AgentContentPart[];
}
interface BuildAgentMessagesInput {
    userMessage: string;
    userImages?: unknown;
    userName?: string;
    tools?: unknown[];
    systemExtra?: AgentMessage[];
    history?: unknown;
    agentMode?: boolean;
}
/** Validates bounded, canonical image data URLs before they enter a worker or model request. */
declare function sanitizeAgentImages(images?: unknown): string[];
/** Retains recent history images within the same budget as the current turn. */
declare function sanitizeAgentHistory(history?: unknown, currentImages?: string[]): AgentHistoryMessage[];
/** Combines trusted system context, sanitized history, and the current text/images. */
declare function buildAgentMessages({ userMessage, userImages, userName, tools, systemExtra, history, agentMode }: BuildAgentMessagesInput): AgentMessage[];
declare const _default: {
    buildAgentMessages: typeof buildAgentMessages;
    sanitizeAgentHistory: typeof sanitizeAgentHistory;
    sanitizeAgentImages: typeof sanitizeAgentImages;
    MAX_AGENT_IMAGE_BYTES: number;
};
export = _default;
