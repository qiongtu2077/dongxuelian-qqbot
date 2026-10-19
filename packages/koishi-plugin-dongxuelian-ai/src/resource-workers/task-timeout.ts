/**
 * MODULE: 资源任务运行时限。
 * 职责: 为 worker 自身和 supervisor 巡检提供唯一的任务最长运行时间计算。
 * 边界: 普通任务解析已有字段，日报预分析固定为已定义的九十秒上限。
 */

interface TaskTimeoutLike {
  kind?: string
  timeoutMs?: unknown
  payload?: Record<string, unknown> | null
}

// 按既有上下限解析任务最长运行时间。
function resolveTaskTimeoutMs(task: TaskTimeoutLike, fallbackMs = 300000): number {
  if (task.kind === 'daily_report_preanalysis') return 90000
  const timeout = Number(task?.timeoutMs || task?.payload?.timeoutMs || fallbackMs)
  if (!Number.isFinite(timeout)) return fallbackMs
  return Math.max(10000, Math.min(30 * 60 * 1000, timeout))
}

export = {
  resolveTaskTimeoutMs,
}
