interface RecentFileLike {
    messageId?: string;
    fileName?: string;
}
interface ToolCallLike {
    function?: {
        name?: string;
    };
}
interface ToolResultLike {
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
declare function toolResultsIncludeFileEvidence(results?: ToolResultLike[]): boolean;
declare function selectFileEvidenceResult(results?: ToolResultLike[]): string;
declare function resolveUnguardedFileFollowup(state?: FileFollowupState, context?: FileFollowupContext): Promise<string | ToolResultLike | null>;
declare function buildFileEvidenceReply(fileEvidence?: string, targetFile?: RecentFileLike | null): string;
declare const _default: {
    toolCallsIncludeAnalyzeFile: typeof toolCallsIncludeAnalyzeFile;
    toolResultsIncludeFileEvidence: typeof toolResultsIncludeFileEvidence;
    selectFileEvidenceResult: typeof selectFileEvidenceResult;
    resolveUnguardedFileFollowup: typeof resolveUnguardedFileFollowup;
    buildFileEvidenceReply: typeof buildFileEvidenceReply;
};
export = _default;
