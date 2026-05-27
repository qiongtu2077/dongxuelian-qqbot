interface ChatToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
interface ChatToolOptions {
    channel?: string;
    toolChannel?: string;
    randomTriggered?: boolean;
    userText?: string;
    currentText?: string;
}
interface ChatToolCall {
    id?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
}
interface ChatToolContext extends ChatToolOptions {
    userId?: string;
    channelKey?: string;
    allowParsedReminderAction?: boolean;
    maxToolCalls?: number | string;
    [key: string]: unknown;
}
interface ChatToolResultMessage {
    tool_call_id?: string;
    role: 'tool';
    content: string;
}
interface ChatToolCallResult {
    results: ChatToolResultMessage[];
    heavyTools: ChatToolCall[];
}
declare function resolveChatToolChannel(options?: ChatToolOptions): string;
declare function isChatToolAllowed(channel: string, name: string): boolean;
declare function getChatToolDefinitions(options?: ChatToolOptions): ChatToolDefinition[];
declare function isLightweightTool(name: string): boolean;
declare function isHeavyTool(name: string): boolean;
declare function executeChatTool(toolCall: ChatToolCall, context?: ChatToolContext): Promise<unknown>;
declare function handleChatToolCalls(toolCalls?: ChatToolCall[], context?: ChatToolContext): Promise<ChatToolCallResult>;
declare function getChatToolSystemHint(channelKey?: string, options?: ChatToolOptions): string;
declare const _default: {
    getChatToolDefinitions: typeof getChatToolDefinitions;
    resolveChatToolChannel: typeof resolveChatToolChannel;
    isChatToolAllowed: typeof isChatToolAllowed;
    isLightweightTool: typeof isLightweightTool;
    isHeavyTool: typeof isHeavyTool;
    executeChatTool: typeof executeChatTool;
    handleChatToolCalls: typeof handleChatToolCalls;
    getChatToolSystemHint: typeof getChatToolSystemHint;
    CHAT_TOOLS_TOTAL_DEADLINE_MS: number;
};
export = _default;
