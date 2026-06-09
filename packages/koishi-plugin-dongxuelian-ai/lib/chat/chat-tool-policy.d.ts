type ChatToolArgs = Record<string, unknown>;
interface ChatToolPolicyContext {
    allowParsedReminderAction?: boolean;
    userText?: string;
    currentText?: string;
}
declare function isLightweightTool(name: string): boolean;
declare function isHeavyTool(name: string): boolean;
declare function isChatWriteActionTool(name: string): boolean;
declare function isDangerousChatActionTool(name: string): boolean;
declare function isRandomReplyBlockedTool(name: string): boolean;
declare function isExplicitChatWriteActionAllowed(name?: string, args?: ChatToolArgs, context?: ChatToolPolicyContext): boolean;
declare const _default: {
    LIGHTWEIGHT_TOOLS: Set<string>;
    HEAVY_TOOLS: Set<string>;
    CHAT_WRITE_ACTION_TOOLS: Set<string>;
    CHAT_DANGEROUS_ACTION_TOOLS: Set<string>;
    RANDOM_REPLY_BLOCKED_TOOLS: Set<string>;
    isLightweightTool: typeof isLightweightTool;
    isHeavyTool: typeof isHeavyTool;
    isChatWriteActionTool: typeof isChatWriteActionTool;
    isDangerousChatActionTool: typeof isDangerousChatActionTool;
    isRandomReplyBlockedTool: typeof isRandomReplyBlockedTool;
    isExplicitChatWriteActionAllowed: typeof isExplicitChatWriteActionAllowed;
};
export = _default;
