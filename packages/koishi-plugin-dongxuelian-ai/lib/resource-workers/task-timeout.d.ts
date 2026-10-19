/**
 * MODULE: 资源任务运行时限。
 * 职责: 为 worker 自身和 supervisor 巡检提供唯一的任务最长运行时间计算。
 * 边界: 普通任务解析已有字段，日报预分析固定为已定义的九十秒上限。
 */
interface TaskTimeoutLike {
    kind?: string;
    timeoutMs?: unknown;
    payload?: Record<string, unknown> | null;
}
declare function resolveTaskTimeoutMs(task: TaskTimeoutLike, fallbackMs?: number): number;
declare const _default: {
    resolveTaskTimeoutMs: typeof resolveTaskTimeoutMs;
};
export = _default;
