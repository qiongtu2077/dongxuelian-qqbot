interface RecentFileLike {
    skipped?: boolean;
    ts?: number;
    userId?: string;
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
    recentFiles?: RecentFileLike[];
    shouldVerify?: boolean;
    usedAnalyzeFile?: boolean;
    hasFileEvidence?: boolean;
    targetFile?: RecentFileLike | null;
}
declare function looksLikeFileFollowup(userText?: string, recentFiles?: RecentFileLike[]): boolean;
declare function toolCallsIncludeAnalyzeFile(toolCalls?: ToolCallLike[]): boolean;
declare function toolResultsIncludeFileEvidence(results?: ToolResultLike[]): boolean;
declare function selectFileEvidenceResult(results?: ToolResultLike[]): string;
declare function selectActiveFileAnchor(recentFiles?: RecentFileLike[], context?: FileFollowupContext): RecentFileLike | null;
declare function buildFileFollowupState(channelKey: string, userText: string, context?: FileFollowupContext): Promise<FileFollowupState>;
declare function resolveUnguardedFileFollowup(state?: FileFollowupState, context?: FileFollowupContext): Promise<string | ToolResultLike | null>;
declare function buildFileEvidenceReply(fileEvidence?: string, targetFile?: RecentFileLike | null): string;
declare const _default: {
    looksLikeFileFollowup: typeof looksLikeFileFollowup;
    toolCallsIncludeAnalyzeFile: typeof toolCallsIncludeAnalyzeFile;
    toolResultsIncludeFileEvidence: typeof toolResultsIncludeFileEvidence;
    selectFileEvidenceResult: typeof selectFileEvidenceResult;
    selectActiveFileAnchor: typeof selectActiveFileAnchor;
    buildFileFollowupState: typeof buildFileFollowupState;
    resolveUnguardedFileFollowup: typeof resolveUnguardedFileFollowup;
    buildFileEvidenceReply: typeof buildFileEvidenceReply;
};
export = _default;
