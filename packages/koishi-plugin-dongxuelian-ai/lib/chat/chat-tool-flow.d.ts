interface ToolCallLike {
    id?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
}
interface ToolResultLike {
    tool_call_id?: string;
    role?: string;
    content?: unknown;
}
interface ToolCallReply {
    type?: string;
    tool_calls?: ToolCallLike[];
    message?: {
        content?: string | null;
    };
    content?: string;
}
interface ChatMessage {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCallLike[];
    tool_call_id?: string;
}
interface SessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
}
interface ChatToolFlowOptions {
    randomTriggered?: boolean;
    userText?: string;
    currentText?: string;
    [key: string]: unknown;
}
interface ChatToolFlowContext {
    userId?: string;
    channelKey?: string;
    groupId?: string;
    isDirect?: boolean;
    channel: string;
    randomTriggered: boolean;
    maxToolCalls?: number;
    userText: string;
    [key: string]: unknown;
}
interface ChatToolFlowInput {
    reply?: string | ToolCallReply;
    messages?: ChatMessage[];
    options?: ChatToolFlowOptions;
    cleanInput?: string;
    session?: SessionLike;
    currentUserId?: string;
    channelKey?: string;
    activeFileContext?: Record<string, unknown>;
    fileFollowupState?: Record<string, unknown>;
    chatTools?: unknown;
    callModel?: (messages: ChatMessage[], randomTriggered?: boolean, extra?: Record<string, unknown>, tools?: unknown) => Promise<string | ToolCallReply>;
}
interface ChatToolFlowResult {
    reply: string | ToolCallReply | unknown;
    usedAnalyzeFileTool: boolean;
    hasFileToolEvidence: boolean;
    usedReminderActionTool: boolean;
    usedUploadedFileVariantTool: boolean;
    heavyToolsRequested: Array<{
        name?: string;
        args: Record<string, unknown>;
    }> | null;
}
declare function updateChatToolUsageState(toolCalls?: ToolCallLike[], results?: ToolResultLike[]): {
    usedAnalyzeFile: boolean;
    hasFileEvidence: boolean;
    usedReminderAction: boolean;
    usedUploadedFileVariant: boolean;
};
declare function buildQqChatToolContext({ session, currentUserId, channelKey, options, activeFileContext, randomTriggered }?: {
    session?: SessionLike;
    currentUserId?: string;
    channelKey?: string;
    options?: ChatToolFlowOptions;
    activeFileContext?: Record<string, unknown>;
    randomTriggered?: boolean;
}): ChatToolFlowContext;
declare function handleChatToolFlow({ reply, messages, options, cleanInput, session, currentUserId, channelKey, activeFileContext, fileFollowupState, chatTools, callModel, }?: ChatToolFlowInput): Promise<ChatToolFlowResult>;
declare const _default: {
    updateChatToolUsageState: typeof updateChatToolUsageState;
    buildQqChatToolContext: typeof buildQqChatToolContext;
    handleChatToolFlow: typeof handleChatToolFlow;
};
export = _default;
