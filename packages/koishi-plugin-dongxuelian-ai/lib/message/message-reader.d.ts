interface ReaderSession {
    content?: unknown;
    event?: {
        message?: unknown[] | {
            elements?: unknown[];
        };
    };
    elements?: unknown[];
}
interface AnalyzeOptions {
    sanitizeUserName?: SanitizeUserName;
}
interface IncomingMessageAnalysis {
    plain: string;
    memory: string;
    replyToId: string;
    hasUsableText: boolean;
    hasMessageRecordCue: boolean;
    hasVisual: boolean;
    hasAudio: boolean;
    hasFile: boolean;
    hasLink: boolean;
    hasEmbed: boolean;
    hasOnlyForwardShell: boolean;
    shouldSkipForRandomReply: boolean;
}
type SanitizeUserName = (name: string) => string;
declare function summarizeForwardNodes(nodes: unknown, depth?: number, sanitizeUserName?: SanitizeUserName): string;
declare function analyzeIncomingMessage(session?: ReaderSession, options?: AnalyzeOptions): IncomingMessageAnalysis;
declare const _default: {
    summarizeForwardNodes: typeof summarizeForwardNodes;
    analyzeIncomingMessage: typeof analyzeIncomingMessage;
    normalizeText: (text?: unknown) => string;
};
export = _default;
