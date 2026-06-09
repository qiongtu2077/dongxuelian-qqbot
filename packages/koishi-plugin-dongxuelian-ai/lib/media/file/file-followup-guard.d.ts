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
declare const _default: {
    looksLikeFileFollowup: (userText?: string, recentFiles?: RecentFileLike[]) => boolean;
    toolCallsIncludeAnalyzeFile: (toolCalls?: ToolCallLike[]) => boolean;
    toolResultsIncludeFileEvidence: (results?: ToolResultLike[]) => boolean;
    selectFileEvidenceResult: (results?: ToolResultLike[]) => string;
    selectActiveFileAnchor: (recentFiles?: RecentFileLike[], context?: FileFollowupContext) => RecentFileLike | null;
    buildFileFollowupState: (channelKey: string, userText: string, context?: FileFollowupContext) => Promise<FileFollowupState>;
    resolveUnguardedFileFollowup: (state?: FileFollowupState, context?: FileFollowupContext) => Promise<string | ToolResultLike | null>;
    buildFileEvidenceReply: (fileEvidence?: string, targetFile?: RecentFileLike | null) => string;
};
export = _default;
