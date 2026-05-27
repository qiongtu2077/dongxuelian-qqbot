interface SkillDownloadRequest {
    source?: string;
    url?: string;
    owner?: string;
    repo?: string;
    skillPath?: string;
    branch?: string;
}
interface SkillDownloadResult {
    ok: boolean;
    error?: string;
    dir?: string;
    tempDir?: string;
    meta?: Record<string, unknown>;
}
type SkillAdapter = (request: SkillDownloadRequest & {
    tempDir: string;
}) => Promise<SkillDownloadResult> | SkillDownloadResult;
declare function registerAdapter(type: string, adapter: SkillAdapter): void;
declare function cleanTempDir(): Promise<void>;
declare function downloadSkill({ source, url, owner, repo, skillPath, branch }: SkillDownloadRequest): Promise<SkillDownloadResult>;
declare function detectSourceType(url?: string): string | null;
declare const _default: {
    registerAdapter: typeof registerAdapter;
    downloadSkill: typeof downloadSkill;
    detectSourceType: typeof detectSourceType;
    cleanTempDir: typeof cleanTempDir;
    HUB_TEMP_DIR: string;
};
export = _default;
