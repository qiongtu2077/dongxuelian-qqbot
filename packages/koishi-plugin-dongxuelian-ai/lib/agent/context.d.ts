/**
 * MODULE: Agent 上下文管理。
 * 职责: Token 估算、工具结果截断、临时压缩（Phase 2）。
 * 边界: 不写 conversation.js，不修改传入的 messages。
 * 状态: externalResultCounter (number)。
 */
interface AgentContextMessage {
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
}
interface ContextReport {
    messageCount: number;
    estimatedTokens: number;
    roles: Record<string, number>;
}
interface CompactRequestOptions {
    max_tokens: number;
}
type CompactRequestFn = (messages: Array<{
    role: string;
    content: string;
}>, config: Record<string, unknown>, options: CompactRequestOptions) => Promise<unknown> | unknown;
/** 粗略 token 估算：中文 ~0.5 token/char，英文 ~0.25 */
declare function estimateTokens(messages?: AgentContextMessage[]): number;
/** 工具结果截断，默认 8000 字符 */
declare function truncateToolResult(text?: unknown, maxChars?: number): string;
/** 构建上下文摘要报告 */
declare function buildContextReport(messages?: AgentContextMessage[]): ContextReport;
declare function externalizeToolResult(text?: unknown, toolName?: unknown, maxInlineChars?: number): Promise<string>;
declare function compactMessages(messages?: AgentContextMessage[], maxMessages?: number): AgentContextMessage[];
declare function buildStructuredSummaryPrompt(messages?: AgentContextMessage[]): string;
declare function mergeSummaryIntoMessages(summary: unknown, recentMessages?: AgentContextMessage[]): AgentContextMessage[];
declare function compactWithLLM(messages?: AgentContextMessage[], config?: Record<string, unknown>, requestFn?: CompactRequestFn): Promise<AgentContextMessage[]>;
declare function summarizeToolResult(text?: unknown, toolName?: unknown, maxChars?: number): string;
declare function compactOldToolResults(messages?: AgentContextMessage[], keepRecent?: number, maxToolChars?: number): AgentContextMessage[];
declare function estimateCacheHitRate(systemMessage?: unknown, previousSystemMessage?: unknown): number;
declare const _default: {
    estimateTokens: typeof estimateTokens;
    truncateToolResult: typeof truncateToolResult;
    externalizeToolResult: typeof externalizeToolResult;
    buildContextReport: typeof buildContextReport;
    compactMessages: typeof compactMessages;
    buildStructuredSummaryPrompt: typeof buildStructuredSummaryPrompt;
    mergeSummaryIntoMessages: typeof mergeSummaryIntoMessages;
    compactWithLLM: typeof compactWithLLM;
    compactOldToolResults: typeof compactOldToolResults;
    summarizeToolResult: typeof summarizeToolResult;
    estimateCacheHitRate: typeof estimateCacheHitRate;
};
export = _default;
