interface RecentFileLike {
    skipped?: boolean;
    ts?: number;
    userId?: string;
    messageId?: string;
    fileName?: string;
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
declare function selectActiveFileAnchor(recentFiles?: RecentFileLike[], context?: FileFollowupContext): RecentFileLike | null;
declare function buildFileFollowupState(channelKey: string, userText: string, context?: FileFollowupContext): Promise<FileFollowupState>;
declare const _default: {
    looksLikeFileFollowup: typeof looksLikeFileFollowup;
    selectActiveFileAnchor: typeof selectActiveFileAnchor;
    buildFileFollowupState: typeof buildFileFollowupState;
};
export = _default;
