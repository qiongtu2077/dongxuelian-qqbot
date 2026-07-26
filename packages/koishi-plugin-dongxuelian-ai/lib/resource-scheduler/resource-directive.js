"use strict";
/**
 * MODULE: 资源指令薄门面。
 * 职责: 统一组合资源快照、入口模式策略和任务准入结果，对上层暴露稳定 directive。
 * 边界: 不接管任务状态机，不获取 S0 锁，不复制 admission / mode-policy 判断树。
 */
const { decideModePolicy } = require('../bot-mode/mode-policy');
const { decideAdmission, writeAdmissionEvent } = require('./admission');
const { readResourceSnapshot } = require('./resource-snapshot');
// 读取当前资源快照并收敛为 directive 使用的只读视图。
function readResourceContext() {
    return readResourceSnapshot();
}
// 提取每条 directive 都必须携带的资源档位字段。
function buildDirectiveBase(snapshot) {
    return {
        resourceState: String(snapshot.resourceState || 'yellow'),
        botMode: String(snapshot.botMode || 'normal'),
    };
}
// 把入口策略动作映射到统一 directive 动作词汇。
function mapEntryPolicyAction(action) {
    if (action === 'pass')
        return 'pass';
    if (action === 'queue_daily')
        return 'queue_daily';
    if (action === 'status_only')
        return 'status_only';
    if (action === 'resource_notice')
        return 'resource_notice';
    if (action === 'silent_drop')
        return 'silent_drop';
    if (action === 'reject')
        return 'reject';
    return 'defer';
}
// 把 S1 准入结果映射到统一 directive 动作词汇。
function mapAdmissionDecisionAction(decision) {
    if (decision === 'run_now')
        return 'pass';
    if (decision === 'queue')
        return 'queue';
    if (decision === 'downgrade')
        return 'downgrade';
    if (decision === 'defer')
        return 'defer';
    if (decision === 'reject')
        return 'reject';
    return 'silent_drop';
}
// 组合入口策略与资源快照，生成稳定 directive。
function directiveFromEntryPolicy(policy, snapshot) {
    return {
        action: mapEntryPolicyAction(policy.action),
        reason: String(policy.reason || ''),
        ...buildDirectiveBase(snapshot),
    };
}
// 组合任务准入结果与资源快照，生成稳定 directive。
function directiveFromAdmission(admission, snapshot) {
    return {
        action: mapAdmissionDecisionAction(admission.decision),
        reason: String(admission.reason || ''),
        ...buildDirectiveBase(snapshot),
        fallback: admission.fallback || undefined,
    };
}
// 为一条入站命令生成入口 directive。
function decideEntryDirective(commandType, snapshot = readResourceContext()) {
    const policy = decideModePolicy(commandType, snapshot);
    return {
        directive: directiveFromEntryPolicy(policy, snapshot),
        policy,
        snapshot,
    };
}
// 为一个资源任务生成只读准入 directive。
function decideTaskDirective(input, snapshot = readResourceContext()) {
    const admission = decideAdmission(input, snapshot);
    return {
        directive: directiveFromAdmission(admission, snapshot),
        admission,
        snapshot,
    };
}
// 为资源任务执行准入并记录聚合事件。
function admitTaskDirective(input) {
    const result = decideTaskDirective(input, readResourceContext());
    writeAdmissionEvent(result.admission);
    return result;
}
// 判断 directive 是否会阻止原业务链继续执行。
function isDirectiveBlocking(action) {
    return action === 'resource_notice' || action === 'silent_drop' || action === 'reject' || action === 'defer';
}
module.exports = {
    readResourceContext,
    directiveFromEntryPolicy,
    directiveFromAdmission,
    decideEntryDirective,
    decideTaskDirective,
    admitTaskDirective,
    isDirectiveBlocking,
};
