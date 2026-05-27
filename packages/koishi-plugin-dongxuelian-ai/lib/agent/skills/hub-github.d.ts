interface GitHubContentItem {
    type?: string;
    size?: number;
    download_url?: string;
    name?: string;
}
interface ParsedGitHubUrl {
    owner: string;
    repo: string;
    branch: string;
    path: string;
}
interface GitHubDownloadRequest {
    owner?: string;
    repo?: string;
    skillPath?: string;
    branch?: string;
    tempDir: string;
    url?: string;
}
interface GitHubDownloadResult {
    ok: boolean;
    error?: string;
    dir?: string;
}
declare function fetchContentsTree(owner: string, repo: string, skillPath?: string, branch?: string): Promise<GitHubContentItem[]>;
declare function downloadGitHubSkill({ owner, repo, skillPath, branch, tempDir, url }: GitHubDownloadRequest): Promise<GitHubDownloadResult>;
declare function parseGitHubUrl(url: unknown): ParsedGitHubUrl | null;
declare const _default: {
    downloadGitHubSkill: typeof downloadGitHubSkill;
    parseGitHubUrl: typeof parseGitHubUrl;
    fetchContentsTree: typeof fetchContentsTree;
};
export = _default;
