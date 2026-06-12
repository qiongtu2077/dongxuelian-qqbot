"use strict";
/**
 * MODULE: 资源指令薄门面。
 * 职责: 统一组合资源快照、入口模式策略和任务准入结果，对上层暴露稳定 directive。
 * 边界: 不接管任务状态机，不获取 S0 锁，不复制 admission / mode-policy 判断树。
 */
const { decideModePolicy } = require('../bot-mode/mode-policy');
const { decideAdmission, writeAdmissionEvent } = require('./admission');
const { readResourceSnapshot } = require('./resource-snapshot');
function readResourceContext() {
    return readResourceSnapshot();
}
function buildDirectiveBase(snapshot) {
    return {
        resourceState: String(snapshot.resourceState || 'yellow'),
        botMode: String(snapshot.botMode || 'normal'),
    };
}
function mapEntryPolicyAction(action) {
    if (action === 'pass')
        return 'pass';
    if (action === 'queue_daily')
        return 'queue_daily';
    if (action === 'status_only')
        return 'status_only';
    if (action === 'silent_drop')
        return 'silent_drop';
    if (action === 'reject')
        return 'reject';
    return 'defer';
}
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
function directiveFromEntryPolicy(policy, snapshot) {
    return {
        action: mapEntryPolicyAction(policy.action),
        reason: String(policy.reason || ''),
        ...buildDirectiveBase(snapshot),
    };
}
function directiveFromAdmission(admission, snapshot) {
    return {
        action: mapAdmissionDecisionAction(admission.decision),
        reason: String(admission.reason || ''),
        ...buildDirectiveBase(snapshot),
        fallback: admission.fallback || undefined,
    };
}
function decideEntryDirective(commandType, snapshot = readResourceContext()) {
    const policy = decideModePolicy(commandType, snapshot);
    return {
        directive: directiveFromEntryPolicy(policy, snapshot),
        policy,
        snapshot,
    };
}
function decideTaskDirective(input, snapshot = readResourceContext()) {
    const admission = decideAdmission(input, snapshot);
    return {
        directive: directiveFromAdmission(admission, snapshot),
        admission,
        snapshot,
    };
}
function admitTaskDirective(input) {
    const result = decideTaskDirective(input, readResourceContext());
    writeAdmissionEvent(result.admission);
    return result;
}
function isDirectiveBlocking(action) {
    return action === 'silent_drop' || action === 'reject' || action === 'defer';
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
