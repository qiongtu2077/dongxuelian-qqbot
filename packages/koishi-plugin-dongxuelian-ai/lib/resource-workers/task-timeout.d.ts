/**
 * MODULE: 资源任务运行时限。
 * 职责: 为 worker 自身和 supervisor 巡检提供唯一的任务最长运行时间计算。
 * 边界: 只解析已有任务字段，不创建或修改任何时间规则。
 */
interface TaskTimeoutLike {
    timeoutMs?: unknown;
    payload?: Record<string, unknown> | null;
}
declare function resolveTaskTimeoutMs(task: TaskTimeoutLike, fallbackMs?: number): number;
declare const _default: {
    resolveTaskTimeoutMs: typeof resolveTaskTimeoutMs;
};
export = _default;
