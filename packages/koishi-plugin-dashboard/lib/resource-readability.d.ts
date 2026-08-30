/**
 * MODULE: 资源中心可读状态判定。
 * 职责: 基于后端事实生成处理器健康、后台暂停和媒体队列风险状态码。
 * 边界: 不翻译界面文案，不读取文件，不改变调度状态。
 */
type ReadableRecord = Record<string, unknown>;
export type WorkerHealthCode = 'idle' | 'working' | 'paused_auto_resume' | 'stopped_idle' | 'stopped_backlog' | 'stalled' | 'task_timeout';
export type BackgroundPauseReason = 'maintenance' | 'resource_critical' | 'browser_active' | 'daily_render_active';
export type MediaRiskCode = 'idle' | 'queued' | 'near_limit' | 'at_limit';
interface ResourceReadabilityInput {
    snapshot: ReadableRecord;
    workers: ReadableRecord[];
    tasks: ReadableRecord[];
    media: ReadableRecord;
    resolveTaskTimeoutMs(task: ReadableRecord): number;
    now?: number;
}
export declare function resolveWorkerType(worker: ReadableRecord): 'agent' | 'daily' | 'media' | 'unknown';
export declare function buildBackgroundPauseReasons(snapshot: ReadableRecord): BackgroundPauseReason[];
export declare function buildReadableWorkers(input: ResourceReadabilityInput, globalReasons: BackgroundPauseReason[]): ReadableRecord[];
export declare function resolveMediaRisk(queueTotal: unknown, queueLimit: unknown): MediaRiskCode;
export declare function buildMediaRisk(media: ReadableRecord): ReadableRecord;
export declare function buildResourceReadability(input: ResourceReadabilityInput): ReadableRecord;
export {};
