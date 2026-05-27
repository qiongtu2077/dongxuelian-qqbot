interface ToolFunctionDefinition {
    name: string;
    description?: string;
}
interface ToolDefinition {
    type: 'function';
    function: ToolFunctionDefinition;
}
interface ToolResultItem {
    name: string;
    result: string;
}
interface RoundSummary {
    round: number;
    reasoning: string;
    toolCalls: Array<{
        id: string;
        name: string;
        args: unknown;
    }>;
    toolResults: Array<{
        name: string;
        result: string;
        status: string;
    }>;
}
interface AgentRunResult {
    reply: string;
    toolCalls: number;
    pendingId: string | null;
    toolResults: ToolResultItem[];
    rounds?: RoundSummary[];
}
interface AgentPendingResult {
    ok?: boolean;
    message?: string;
    error?: string;
    pending?: unknown;
    reply?: string;
}
interface ContextPolicy {
    allowExternalTools: boolean;
    allowedTools: string[];
}
interface RunAgentOptions {
    userMessage?: unknown;
    userName?: unknown;
    userId?: unknown;
    channelKey?: unknown;
    channel?: unknown;
    systemExtra?: unknown;
    history?: unknown;
    forceTools?: unknown;
    preExecuteTools?: unknown;
    onProgress?: ProgressHandler;
    bot?: unknown;
    enableThinking?: unknown;
    agentMode?: unknown;
    scheduledTask?: unknown;
    contextPolicy?: unknown;
    isAdmin?: unknown;
}
interface ResumePendingOptions {
    channelKey?: unknown;
    userId?: unknown;
    channel?: unknown;
    expectedId?: unknown;
    onProgress?: ProgressHandler;
    bot?: unknown;
    isAdmin?: unknown;
}
interface ProgressMessage {
    type: string;
    round: number;
    toolCount: number;
    estimatedTokens: number;
}
type ProgressHandler = (message: ProgressMessage, round?: number) => unknown;
declare function normalizeContextPolicy(policy?: unknown): ContextPolicy;
declare function applyContextPolicyToTools(tools?: ToolDefinition[], contextPolicy?: unknown): ToolDefinition[];
declare function runAgent({ userMessage, userName, userId, channelKey, channel, systemExtra, history, forceTools, preExecuteTools, onProgress, bot, enableThinking, agentMode, scheduledTask, contextPolicy, isAdmin }: RunAgentOptions): Promise<AgentRunResult>;
declare function resumePending({ channelKey, userId, channel, expectedId, onProgress, bot, isAdmin }: ResumePendingOptions): Promise<AgentRunResult | AgentPendingResult>;
declare const _default: {
    run: typeof runAgent;
    resumePending: typeof resumePending;
    normalizeContextPolicy: typeof normalizeContextPolicy;
    applyContextPolicyToTools: typeof applyContextPolicyToTools;
};
export = _default;
