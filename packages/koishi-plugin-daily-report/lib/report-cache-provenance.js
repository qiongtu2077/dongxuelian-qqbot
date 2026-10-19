"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportCacheDigest = reportCacheDigest;
exports.assertReportCachePolicy = assertReportCachePolicy;
exports.assertReportCacheAttempts = assertReportCacheAttempts;
exports.verifyReportCacheAttempts = verifyReportCacheAttempts;
/** 日报缓存共用的固定政策、实际执行来源及稳定产物摘要；不读写文件或请求模型。 */
const crypto_1 = require("crypto");
const util_1 = require("util");
const PROVENANCE_HASH = /^[a-f0-9]{64}$/;
// 固定键顺序的JSON摘要，字符串和数组不归一化，也不改变原文。
function reportCacheDigest(value) {
    const text = JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
    return (0, crypto_1.createHash)('sha256').update(text).digest('hex');
}
// 政策只包含实际冻结节点的脱敏身份，不接受未知节点或未冻结路线。
function assertReportCachePolicy(policy) {
    if (!policy || !PROVENANCE_HASH.test(policy.identity) || [policy.first, policy.recovery].some(node => !node
        || !PROVENANCE_HASH.test(node.routeIdentity) || !PROVENANCE_HASH.test(node.routeRevision) || !node.provider || !node.model || !node.protocol)) {
        throw new Error('日报缓存冻结政策无效');
    }
}
// 每次实际执行须匹配所属轮次单节点；精确权重版本当前只能记录未知。
function reportCacheExecutionMatches(execution, node) {
    return !!execution && execution.routeIdentity === node.routeIdentity && execution.routeRevision === node.routeRevision
        && execution.provider === node.provider && execution.model === node.model && execution.protocol === node.protocol
        && execution.stepIndex === 0 && execution.priorityIndex === 0 && PROVENANCE_HASH.test(execution.configurationIdentity)
        && execution.modelVersion === null && execution.modelVersionReadable === false
        && (execution.finishReason === null || typeof execution.finishReason === 'string') && typeof execution.finishReasonReadable === 'boolean'
        && !!execution.usage && typeof execution.usage.readable === 'boolean'
        && [execution.usage.promptTokens, execution.usage.completionTokens, execution.usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0);
}
// 首轮与恢复各只含一个真实节点，最后有效结果不能以长度截断结束。
function assertReportCacheAttempts(attempts, policy) {
    if (!Array.isArray(attempts) || !attempts.length || attempts.length > 2 || attempts.some((attempt, index) => !attempt || attempt.attempt !== index + 1
        || !reportCacheExecutionMatches(attempt.execution, index ? policy.recovery : policy.first)) || attempts[attempts.length - 1].execution.finishReason === 'length') {
        throw new Error('日报缓存实际模型来源不属于冻结单节点政策或返回截断');
    }
}
// 保存前核对实际上游尝试和原请求；只返回脱离回调可变对象的来源与用量副本。
function verifyReportCacheAttempts(attempts, policy, system, input, maxTokens) {
    const actual = attempts.map(attempt => ({ attempt: attempt.attempt, execution: attempt.execution }));
    assertReportCacheAttempts(actual, policy);
    if (attempts.some(attempt => attempt.upstreamAttempts?.length !== 1 || !attempt.execution
        || !(0, util_1.isDeepStrictEqual)(attempt.upstreamAttempts[0], Object.fromEntries(Object.entries(attempt.execution).filter(([key]) => !['modelVersion', 'modelVersionReadable', 'finishReason', 'finishReasonReadable', 'usage'].includes(key)))))
        || attempts[0].system !== system || attempts[0].input !== input || attempts.some(attempt => attempt.maxTokens !== maxTokens)
        || attempts[attempts.length - 1].error !== '')
        throw new Error('实际单节点尝试或原请求来源无法确认');
    return actual.map(attempt => ({ attempt: attempt.attempt, execution: { ...attempt.execution, usage: { ...attempt.execution.usage } } }));
}
