interface WorkspaceAlias {
    name: string;
    terms: string[];
    paths: string[];
}
interface WorkspaceCandidate {
    path: string;
    reason: string;
    alias?: string;
    key?: string;
}
interface ResolveAgentPathOptions {
    requireExisting?: boolean;
}
interface BuildAgentWorkspaceContextInput {
    userMessage?: string;
    channel?: string;
    roots?: string[];
}
interface WorkspaceSystemMessage {
    role: 'system';
    content: string;
}
declare function normalizeIntentText(value?: unknown): string;
declare function normalizeRequestedPath(value?: unknown): string;
declare function resolveAgentPathInput(value?: unknown, roots?: string[], options?: ResolveAgentPathOptions): WorkspaceCandidate;
declare function getWorkspaceSemanticCandidates(text?: unknown, roots?: string[]): WorkspaceCandidate[];
declare function formatWorkspaceContext(candidates?: WorkspaceCandidate[], roots?: string[]): string;
declare function buildAgentWorkspaceContext({ userMessage, channel, roots }?: BuildAgentWorkspaceContextInput): Promise<WorkspaceSystemMessage[]>;
declare const _default: {
    WORKSPACE_ALIASES: WorkspaceAlias[];
    normalizeIntentText: typeof normalizeIntentText;
    normalizeRequestedPath: typeof normalizeRequestedPath;
    resolveAgentPathInput: typeof resolveAgentPathInput;
    getWorkspaceSemanticCandidates: typeof getWorkspaceSemanticCandidates;
    formatWorkspaceContext: typeof formatWorkspaceContext;
    buildAgentWorkspaceContext: typeof buildAgentWorkspaceContext;
};
export = _default;
