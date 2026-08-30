type ManagementModule<Name extends import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').ManagementModuleName> = import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').ManagementModule<Name>;
type AgentPathGuardModule = ManagementModule<'agent.pathGuard'>;
type ExistingAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertExistingAgentPathInsideRoots']>>;
type NewAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertNewAgentPathInsideRoots']>>;
interface AgentWorkspaceListOptions {
    root?: string;
    query?: string;
    limit?: string | number;
}
type AgentWorkspaceFileType = 'dir' | 'file' | 'other';
interface AgentWorkspaceFileItem {
    path: string;
    rel: string;
    name: string;
    type: AgentWorkspaceFileType;
    size: number;
    mtimeMs: number;
    injectable: boolean;
}
interface AgentWorkspaceListResult {
    root: string;
    files: AgentWorkspaceFileItem[];
}
interface AgentFilePreview {
    path: string;
    name: string;
    size: number;
    mtimeMs: number;
    binary: boolean;
    truncated: boolean;
    content: string;
}
export interface AgentEnvFileStatus {
    name: string;
    exists: boolean;
    configured: boolean;
    size: number;
}
export declare function resolveAgentWorkspacePath(target: unknown): Promise<ExistingAgentPath>;
export declare function resolveAgentUploadTarget(root: unknown, name: unknown): Promise<NewAgentPath>;
export declare function listAgentWorkspaceFiles({ root, query, limit }?: AgentWorkspaceListOptions): Promise<AgentWorkspaceListResult>;
export declare function previewAgentWorkspaceFile(target: unknown): Promise<AgentFilePreview>;
export declare function getAgentEffectiveReadRoots(): Promise<string[]>;
export declare function getAgentEnvStatus(): AgentEnvFileStatus[];
export {};
