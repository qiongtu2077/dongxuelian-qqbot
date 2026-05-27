interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
interface ToolContext {
    channel?: string;
    channelKey?: string;
    userId?: string;
    userName?: string;
    bot?: unknown;
}
interface AgentTool {
    definition: ToolDefinition;
    execute: (params?: Record<string, unknown>, context?: ToolContext) => Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
}
declare const _default: {
    createPlanTool: AgentTool;
    updateTaskStatusTool: AgentTool;
    checkPlanStatusTool: AgentTool;
    finishPlanTool: AgentTool;
    abandonPlanTool: AgentTool;
    tools: AgentTool[];
};
export = _default;
