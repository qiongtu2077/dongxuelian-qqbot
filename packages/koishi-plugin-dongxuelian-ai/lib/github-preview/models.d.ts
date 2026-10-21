/** Shared contracts and bounded defaults for GitHub previews; no model calls. */
/**
 * MODULE: GitHub 查询协议与预算。
 * 职责: 定义目标、官方元数据、结果和统一资源限额。
 * 边界: 不访问网络、不调用模型；无持久状态。
 */
export type GithubKind = 'issue' | 'pull' | 'repository' | 'user';
export interface GithubTarget {
    kind: GithubKind;
    owner: string;
    repo?: string;
    number?: number;
    url: string;
    key: string;
}
export interface GithubMetadata {
    target: GithubTarget;
    title: string;
    url: string;
    fetchedAt: number;
    state?: string;
    description?: string;
    author?: string;
    avatar?: string;
    labels?: {
        name: string;
        color: string;
    }[];
    facts: [string, string][];
    stale?: boolean;
}
export interface GithubImageResult {
    images: Buffer[];
    incomplete?: boolean;
    capturedAt: number;
}
export interface GithubWorkContext {
    signal: AbortSignal;
    deadline: number;
    taskId: string;
}
export declare const GITHUB_LIMITS: Readonly<{
    loadMs: 10000;
    captureMs: 5000;
    runMs: 45000;
    queueMs: 15000;
    maxQueued: 20;
    maxTargets: 3;
    cooldownMs: 120000;
    cacheMs: 300000;
    staleMs: 1800000;
    cacheEntries: 100;
    cacheBytes: number;
    imageBytes: number;
    padding: 24;
    imageHeight: 2000;
    maxImages: 3;
    viewportWidth: 1280;
    minMemoryMb: 650;
    stopMemoryMb: 350;
}>;
export declare function assertGithubWork(context: Pick<GithubWorkContext, 'signal' | 'deadline'>): void;
export declare function waitGithubWork(ms: number, signal: AbortSignal): Promise<void>;
