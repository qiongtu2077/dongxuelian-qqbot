/**
 * MODULE: 资源中心任务诊断记录。
 * 职责: 合并未知资源任务与未完成媒体任务，并提供稳定游标分页和按需详情。
 * 边界: 不读取任务输入，不返回 payload，不推断未保存的错误原因。
 */
type DiagnosticRecord = Record<string, unknown>;
interface DiagnosticSource {
    resourceTasks: DiagnosticRecord[];
    mediaTasks: DiagnosticRecord[];
    redactText(value: string): string;
}
interface DiagnosticQuery {
    group?: unknown;
    reason?: unknown;
    cursor?: unknown;
}
export declare const RESOURCE_DIAGNOSTIC_PAGE_SIZE = 120;
export declare function buildResourceDiagnosticsPage(source: DiagnosticSource, query?: DiagnosticQuery): DiagnosticRecord;
export declare function buildResourceDiagnosticDetail(source: DiagnosticSource, recordIdValue: unknown): DiagnosticRecord | null;
export {};
