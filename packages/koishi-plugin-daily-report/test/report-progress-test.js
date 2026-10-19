/** 独立核心处理/深读/展示计数及公共白名单；无外部依赖mock。 */
'use strict'
const assert = require('assert').strict
const { createReportEvidence } = require('../lib/report-evidence')
const { createReportEvidenceMetrics } = require('../lib/report-progress')
const { createReportAnalysisDiagnostics, sanitizeReportAnalysisDiagnostics } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 缺少尾片段时长消息不能记完整；多话题重复/模型提交与缓存口径保持区分。
function checkProgressCounts() {
  const snapshot = createReportEvidence([{ userId: 'a', content: '字'.repeat(2401) }, { userId: 'b', content: '[图片]' }, { userId: 'c', content: '普通原话' }])
  const input = { submitted: ['1:1', '1:1'], classified: ['1:1', '2:1', '3:1'], deterministic: ['2:1'], cached: ['3:1'], selected: ['1:1', '3:1', '1:1'], deepRead: ['1:1', '3:1'], displayed: ['1:1'] }
  const partial = createReportEvidenceMetrics(snapshot, input)
  assert.equal(partial.modelSubmittedMessageCount, 1); assert.equal(partial.modelSubmittedFragmentCount, 1)
  assert.equal(partial.processedMessageCount, 2); assert.equal(partial.processedFragmentCount, 3); assert.equal(partial.unprocessedMessageCount, 1)
  assert.equal(partial.processingCoverageRate, 2 / 3 * 100)
  assert.equal(partial.selectedTopicMessageCount, 2); assert.equal(partial.deepReadMessageCount, 2); assert.equal(partial.displayedTopicMessageCount, 1)
  assert.equal(partial.cacheHitMessageCount, 1); assert.equal(partial.deterministicMessageCount, 1)
  const complete = createReportEvidenceMetrics(snapshot, { ...input, classified: [...input.classified, '1:2'] })
  assert.equal(complete.processedMessageCount, 3); assert.equal(complete.processingCoverageRate, 100)
  assert.deepEqual(input.classified, ['1:1', '2:1', '3:1'])
}

// 未知或辅助/跨快照片段、未读展示与未知状态字段均拒绝，不制造完成数量。
function checkInvalidProgress() {
  const snapshot = createReportEvidence([{ userId: 'a', content: '正文' }])
  const empty = { submitted: [], classified: [], deterministic: [], cached: [], selected: [], deepRead: [], displayed: [] }
  for (const input of [{ ...empty, submitted: ['m1'] }, { ...empty, classified: ['99:1'] }, { ...empty, displayed: ['1:1'] },
    { ...empty, selected: ['1:1'] }, { ...empty, classified: ['1:1'], deterministic: ['1:1'], cached: ['1:1'] },
    { ...empty, classified: ['1:1'], deterministic: ['1:1'], submitted: ['1:1'] }, { ...empty, other: [] }, { ...empty, submitted: null }]) {
    assert.throws(() => createReportEvidenceMetrics(snapshot, input))
  }
  const absent = { ...empty }; delete absent.deepRead
  assert.throws(() => createReportEvidenceMetrics(snapshot, absent), /字段/)
  const zero = createReportEvidenceMetrics(createReportEvidence([]), empty)
  assert.equal(zero.processingCoverageRate, null); assert.equal(zero.processedMessageCount, 0)
}

// 公共诊断保留旧coverage含义，白名单只复制数量，错误数量和不同版本拒绝。
function checkPublicMetrics() {
  const snapshot = createReportEvidence([{ userId: 'a', content: '甲' }, { userId: 'b', content: '[图片]' }])
  const metrics = createReportEvidenceMetrics(snapshot, { submitted: ['1:1'], classified: ['1:1', '2:1'], deterministic: ['2:1'], cached: [], selected: ['1:1'], deepRead: ['1:1'], displayed: ['1:1'] })
  const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: 2, windowMessageCount: 2, sourceCompleteness: 'legacy_unknown' })
  diagnostics.evidence = { ...metrics, content: '不能公开的原文', apiKey: '不能公开的凭据' }
  const publicValue = sanitizeReportAnalysisDiagnostics(diagnostics)
  assert.deepEqual(publicValue.evidence, metrics); assert.equal(publicValue.coverageRate, 0)
  assert.equal(publicValue.omittedMessageCount, 2); assert.equal(publicValue.sourceCompleteness, 'legacy_unknown')
  for (const change of [{ version: 2 }, { modelSubmittedMessageCount: 3 }, { processedMessageCount: -1 }, { displayedTopicFragmentCount: 2 },
    { deepReadMessageCount: 3 }, { processingCoverageRate: 99 }, { unprocessedMessageCount: 1 }, { selectedFragmentCount: 1 }, { cacheHitFragmentCount: 2 },
    { modelSubmittedFragmentCount: 0 }, { deterministicMessageCount: 0 }, { displayedTopicFragmentCount: 0 }, { cacheHitMessageCount: 1 }]) {
    assert.throws(() => sanitizeReportAnalysisDiagnostics({ ...diagnostics, evidence: { ...metrics, ...change } }), /证据|诊断数量/)
  }
  delete diagnostics.evidence
  assert.equal(sanitizeReportAnalysisDiagnostics(diagnostics).evidence, undefined)
  const candidateFailure = { id: 'priority', stage: 'selection', firstSourceId: 1, lastSourceId: 2,
    firstTimestamp: null, lastTimestamp: null, attempts: 2, error: '未完成候选', allowedRefs: ['c1', 'c2'], missingRefs: ['c2'] }
  assert.deepEqual(sanitizeReportAnalysisDiagnostics({ ...diagnostics, failedBatches: [candidateFailure] }).failedBatches[0], candidateFailure)
  assert.throws(() => sanitizeReportAnalysisDiagnostics({ ...diagnostics, failedBatches: [{ ...candidateFailure, missingRefs: ['c99'] }] }), /缺失引用/)
  const longSnapshot = createReportEvidence([{ userId: 'a', content: '字'.repeat(2401) }])
  const partial = createReportEvidenceMetrics(longSnapshot, { submitted: ['1:1'], classified: ['1:1'], deterministic: [], cached: [], selected: [], deepRead: [], displayed: [] })
  const longDiagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'legacy_unknown' })
  assert.equal(partial.processedMessageCount, 0); assert.equal(partial.processedFragmentCount, 1)
  assert.deepEqual(sanitizeReportAnalysisDiagnostics({ ...longDiagnostics, evidence: partial }).evidence, partial)
}

// 各计数场景进入正式日报结果，独立汇总失败。
function runReportProgressTests(check) {
  for (const [label, run] of [['长消息完整处理、重复归属、模型/确定/缓存/深读/展示独立计数', checkProgressCounts],
    ['未知核心或未读展示拒绝及合法空快照计数', checkInvalidProgress], ['公共证据计数白名单/版本/范围校验且旧coverage保持', checkPublicMetrics]]) {
    try { run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportProgressTests }
