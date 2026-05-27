interface AgentToolDefinition {
    name: string;
    description?: string;
}
interface AgentTool {
    definition: AgentToolDefinition;
    execute: (params?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown> | unknown;
    dangerous?: boolean;
    defaultChannels?: string[];
}
interface ToolExecuteResult {
    ok: boolean;
    text: string;
    error?: string;
    fallbackTool?: unknown;
}
interface ToolSummary {
    name: string;
    description: string;
    dangerous: boolean;
    readOnly: boolean;
    write: boolean;
    external: boolean;
    defaultChannels: string[];
    channels: Record<string, boolean>;
    enabled?: boolean;
}
/** 按渠道过滤，返回 OpenAI 标准格式的工具定义 */
declare function getToolDefinitions(channel?: string): Array<{
    type: 'function';
    function: AgentToolDefinition;
}>;
declare function executeTool(toolName: string, params?: Record<string, unknown>, context?: Record<string, unknown>): Promise<ToolExecuteResult>;
declare function getToolCount(): number;
declare function getToolSummaries(channel?: string): ToolSummary[];
declare const _default: {
    getToolDefinitions: typeof getToolDefinitions;
    executeTool: typeof executeTool;
    toolRegistry: Record<string, AgentTool>;
    getToolCount: typeof getToolCount;
    getToolSummaries: typeof getToolSummaries;
};
export = _default;
