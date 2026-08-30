"use strict";
/**
 * MODULE: 资源任务运行时限。
 * 职责: 为 worker 自身和 supervisor 巡检提供唯一的任务最长运行时间计算。
 * 边界: 只解析已有任务字段，不创建或修改任何时间规则。
 */
// 按既有上下限解析任务最长运行时间。
function resolveTaskTimeoutMs(task, fallbackMs = 300000) {
    const timeout = Number(task?.timeoutMs || task?.payload?.timeoutMs || fallbackMs);
    if (!Number.isFinite(timeout))
        return fallbackMs;
    return Math.max(10000, Math.min(30 * 60 * 1000, timeout));
}
module.exports = {
    resolveTaskTimeoutMs,
};
