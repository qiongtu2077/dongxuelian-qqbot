interface RecentFileLike {
    messageId?: string;
    fileName?: string;
}
interface ToolCallLike {
    id?: string;
    function?: {
        name?: string;
    };
}
interface ToolResultLike {
    tool_call_id?: string;
    content?: unknown;
}
interface FileFollowupContext {
    now?: number;
    userId?: string;
    [key: string]: unknown;
}
interface FileFollowupState {
    shouldVerify?: boolean;
    usedAnalyzeFile?: boolean;
    hasFileEvidence?: boolean;
    targetFile?: RecentFileLike | null;
}
declare function toolCallsIncludeAnalyzeFile(toolCalls?: ToolCallLike[]): boolean;
declare function isTerminalFileEvidence(text?: string): boolean;
declare function formatTerminalFileEvidence(evidence?: string): string;
declare function toolResultsIncludeFileEvidence(results?: ToolResultLike[], toolCalls?: ToolCallLike[]): boolean;
declare function selectFileEvidenceResult(results?: ToolResultLike[], toolCalls?: ToolCallLike[]): string;
declare function resolveUnguardedFileFollowup(state?: FileFollowupState, context?: FileFollowupContext): Promise<string | ToolResultLike | null>;
declare function buildFileEvidenceReply(fileEvidence?: string, targetFile?: RecentFileLike | null): string;
declare const _default: {
    toolCallsIncludeAnalyzeFile: typeof toolCallsIncludeAnalyzeFile;
    toolResultsIncludeFileEvidence: typeof toolResultsIncludeFileEvidence;
    selectFileEvidenceResult: typeof selectFileEvidenceResult;
    resolveUnguardedFileFollowup: typeof resolveUnguardedFileFollowup;
    buildFileEvidenceReply: typeof buildFileEvidenceReply;
    isTerminalFileEvidence: typeof isTerminalFileEvidence;
    formatTerminalFileEvidence: typeof formatTerminalFileEvidence;
};
export = _default;
