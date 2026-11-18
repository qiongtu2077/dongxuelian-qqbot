/**
 * MODULE: 资源中心任务诊断记录。
 * 职责: 合并未知资源任务与未完成媒体任务，并提供稳定游标分页和按需详情。
 * 边界: 不读取任务输入，不返回 payload，不推断未保存的错误原因。
 */
type DiagnosticRecord = Record<string, unknown>;
interface DiagnosticTask {
    id?: unknown;
    kind?: unknown;
    status?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    finishedAt?: unknown;
    finishReason?: unknown;
    hasError?: boolean;
    error?: unknown;
    claimedBy?: unknown;
    step?: unknown;
    source?: unknown;
    timeoutMs?: unknown;
}
interface DiagnosticSource {
    resourceTasks: readonly DiagnosticTask[];
    mediaTasks: readonly DiagnosticTask[];
}
interface DiagnosticQuery {
    group?: unknown;
    reason?: unknown;
    cursor?: unknown;
}
export declare const RESOURCE_DIAGNOSTIC_PAGE_SIZE = 120;
export declare function buildResourceDiagnosticsPage(source: DiagnosticSource, query?: DiagnosticQuery): DiagnosticRecord;
export declare function parseResourceDiagnosticId(value: unknown): {
    source: 'unknown' | 'media';
    taskId: string;
} | null;
export declare function buildResourceDiagnosticDetail(source: DiagnosticSource & {
    redactText(value: string): string;
}, recordIdValue: unknown): DiagnosticRecord | null;
export {};
