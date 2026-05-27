interface WorkspaceSkillEntry {
    name: string;
    description?: string;
    version?: string;
    source?: string;
    installedAt?: string;
    enabled?: boolean;
}
interface WorkspaceManifest {
    schema: 'skill-workspace-manifest.v1';
    skills: Record<string, WorkspaceSkillEntry>;
}
interface WorkspaceOperationResult {
    ok: boolean;
    name?: string;
    error?: string;
}
interface EffectiveSkillDir {
    name: string;
    dir: string;
}
declare function readWorkspaceManifest(): Promise<WorkspaceManifest>;
declare function installFromPool(name: string): Promise<WorkspaceOperationResult>;
declare function removeFromWorkspace(name: string): Promise<WorkspaceOperationResult>;
declare function setSkillEnabled(name: string, enabled: unknown): Promise<WorkspaceOperationResult>;
declare function listWorkspaceSkills(): Promise<WorkspaceSkillEntry[]>;
declare function getWorkspaceSkillInfo(name: string): Promise<WorkspaceSkillEntry | null>;
declare function getEnabledWorkspaceSkills(): Promise<WorkspaceSkillEntry[]>;
declare function getEffectiveSkillDirs(): Promise<EffectiveSkillDir[]>;
declare const _default: {
    WORKSPACE_MANIFEST_FILE: string;
    readWorkspaceManifest: typeof readWorkspaceManifest;
    installFromPool: typeof installFromPool;
    removeFromWorkspace: typeof removeFromWorkspace;
    setSkillEnabled: typeof setSkillEnabled;
    listWorkspaceSkills: typeof listWorkspaceSkills;
    getWorkspaceSkillInfo: typeof getWorkspaceSkillInfo;
    getEnabledWorkspaceSkills: typeof getEnabledWorkspaceSkills;
    getEffectiveSkillDirs: typeof getEffectiveSkillDirs;
};
export = _default;
