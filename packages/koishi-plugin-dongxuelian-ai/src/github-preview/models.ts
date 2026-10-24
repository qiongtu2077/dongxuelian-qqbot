/** Shared contracts and bounded defaults for GitHub previews; no model calls. */
/**
 * MODULE: GitHub 查询协议与预算。
 * 职责: 定义目标、官方元数据、结果和统一资源限额。
 * 边界: 不访问网络、不调用模型；无持久状态。
 */
export type GithubKind = 'issue' | 'pull' | 'repository' | 'user'
export interface GithubTarget { kind: GithubKind; owner: string; repo?: string; number?: number; url: string; key: string }
// Pull-only extras mirror the progress-board detail view: verified counts, latest review verdicts and CI summary.
export interface GithubPullStats {
  commits?: number; additions?: number; deletions?: number; changedFiles?: number; comments?: number; reviewComments?: number
  headRef?: string; baseRef?: string; headSha?: string; mergeableState?: string; updatedAt?: string; closedAt?: string; mergedAt?: string; mergedBy?: string
  assignees?: string[]; requestedReviewers?: string[]; milestone?: string
}
export interface GithubReviewVerdict { login: string; state: string; submittedAt?: string }
export type GithubCheckBucket = 'failure' | 'pending' | 'success' | 'neutral' | 'skipped'
export interface GithubCheckRun { name: string; status: string; conclusion?: string; bucket: GithubCheckBucket }
export interface GithubPullChecks { overall: 'failure' | 'pending' | 'success' | 'neutral'; total: number; counts: Record<GithubCheckBucket, number>; runs: GithubCheckRun[] }
export interface GithubPullExtras { stats?: GithubPullStats; reviews: GithubReviewVerdict[]; reviewTotal: number; checks?: GithubPullChecks; partial: string[] }
export interface GithubMetadata {
  target: GithubTarget; title: string; url: string; fetchedAt: number; state?: string
  description?: string; author?: string; avatar?: string; labels?: { name: string; color: string }[]
  bodyHtml?: string; createdAt?: string; pull?: GithubPullExtras
  facts: [string, string][]; stale?: boolean
}
export interface GithubImageResult { images: Buffer[]; incomplete?: boolean; note?: string; capturedAt: number }
export interface GithubWorkContext { signal: AbortSignal; deadline: number; taskId: string }
export const GITHUB_LIMITS = Object.freeze({
  loadMs: 25000, targetMs: 30000, assetMs: 10000, captureMs: 5000, runMs: 45000, queueMs: 15000, maxQueued: 20,
  maxTargets: 3, cooldownMs: 120000, cacheMs: 300000, staleMs: 1800000,
  cacheEntries: 100, cacheBytes: 20 * 1024 * 1024, imageBytes: 10 * 1024 * 1024,
  padding: 24, imageHeight: 2000, maxImages: 3, viewportWidth: 1280,
  minMemoryMb: 650, stopMemoryMb: 350,
  bodyBytes: 256 * 1024, metadataBytes: 8 * 1024 * 1024, htmlBytes: 512 * 1024,
})

// Stop immediately after cancellation or the shared task deadline.
export function assertGithubWork(context: Pick<GithubWorkContext, 'signal' | 'deadline'>): void {
  context.signal.throwIfAborted()
  if (Date.now() >= context.deadline) throw new Error('GitHub 查询处理超时')
}

// Wait for a short bounded stage and release its abort listener on every path.
export function waitGithubWork(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abortGithubWait = (): void => { clearTimeout(timer); reject(signal.reason); signal.removeEventListener('abort', abortGithubWait) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abortGithubWait); resolve() }, ms)
    signal.addEventListener('abort', abortGithubWait, { once: true })
  })
}
