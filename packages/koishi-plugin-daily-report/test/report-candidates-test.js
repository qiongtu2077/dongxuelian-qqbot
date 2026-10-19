/** 完整分类真实协议/请求入口行为测试；只模拟外部模型响应，不替换读取器。 */
'use strict'
const assert = require('assert').strict
const material = require('../lib/report-evidence')
const candidates = require('../lib/report-candidates')
const engine = require('../lib/complete-input')
const { createReportAnalysisDiagnostics } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 每个用例使用新的固定快照，重复昵称的永久身份保持区分。
function candidateFixture() {
  const snapshot = material.createReportEvidence(['版本计划为六人', '图片之外短互动', '另一个机制问题', '更正为四人'].map((content, index) => ({
    userId: index % 2 ? 'b' : 'a', user: '同名', messageId: 'real-' + index, realMessageId: true, ts: index + 1, content })))
  return material.packReportEvidenceBatches(snapshot)[0]
}

// 构造唯一明示分类协议；测试覆盖故障不会生成或改变模型原话。
function candidateResponse(records, quotes = []) { return JSON.stringify({ groups: Object.fromEntries([...new Set(Object.values(records).filter(value => typeof value === 'string').flatMap(value => value.split('|')))].map(key => [key, '测试讨论'])), records, quotes, completed: true }) }

// 多归属合法且原话/本人保持；其他事件封闭旧段，短互动穿插不封闭。
function checkLedgerAndOwnership() {
  const batch = candidateFixture()
  const records = candidates.readReportClassification(candidateResponse({ r1: 'event:1', r2: 'social:1', r3: 'event:2|event:3', r4: 'event:1' },
    [{ kind: 'quote', ref: 'r4', criterion: 'clear_viewpoint' }]), batch)
  const projected = candidates.createReportCandidates(records, batch, 'facts-0')
  assert.equal(projected.filter(item => item.kind === 'event').length, 4)
  const last = projected.find(item => item.localSegment?.recordIndex === 0 && item.localSegment.segmentIndex === 1)
  assert.deepEqual(last.fragments.map(item => item.sourceId), [4])
  assert.equal(last.facts[0].parts[0].memberId, 'b')
  assert.equal(last.facts[0].parts[1], '更正为四人')
  assert.ok(projected.every(item => item.fragments.every(fragment => fragment === batch.fragments.find(original => original.id === fragment.id))))
  assert.ok(projected.every(item => item.fragments.every(fragment => !Object.hasOwn(fragment, 'author'))))
  assert.deepEqual(new Set(projected.filter(item => item.kind !== 'quote').flatMap(item => item.fragments.map(fragment => fragment.id))), new Set(batch.fragments.map(fragment => fragment.id)))
  const continuous = candidates.createReportCandidates(candidates.readReportClassification(candidateResponse({ r1: 'event:1', r2: 'social:1', r3: 'social:1', r4: 'event:1' }), batch), batch, 'continuous')
  assert.deepEqual(continuous.find(item => item.kind === 'event').fragments.map(fragment => fragment.sourceId), [1, 4])
}

// 同号回应在另一实质事件后建立新候选；纯社交穿插及合法多归属不丢来源。
function checkResponseSegments() {
  const batch = candidateFixture()
  const split = candidates.createReportCandidates(candidates.readReportClassification(candidateResponse({
    r1: 'response:1', r2: 'event:2', r3: 'response:1', r4: 'response:1|event:3' }), batch), batch, 'response')
  const responses = split.filter(item => item.kind === 'interaction' && item.category === 'response')
  assert.deepEqual(responses.map(item => item.fragments.map(fragment => fragment.sourceId)), [[1], [3, 4]])
  assert.deepEqual(responses.map(item => item.localSegment.segmentIndex), [0, 1])
  assert.equal(responses[1].rawFacts[1].parts[1], '更正为四人')
  assert.equal(responses[1].rawFacts[1].parts[0].memberId, 'b')
  assert.ok(split.some(item => item.kind === 'event' && item.fragments.some(fragment => fragment.sourceId === 4)))
  assert.deepEqual(new Set(split.flatMap(item => item.fragments.map(fragment => fragment.id))), new Set(batch.fragments.map(fragment => fragment.id)))
  const continuous = candidates.createReportCandidates(candidates.readReportClassification(candidateResponse({
    r1: 'response:1', r2: 'social:1', r3: 'media:1', r4: 'response:1' }), batch), batch, 'continuous-response')
  assert.deepEqual(continuous.find(item => item.category === 'response').fragments.map(fragment => fragment.sourceId), [1, 4])
  const social = candidates.createReportCandidates(candidates.readReportClassification(candidateResponse({
    r1: 'social:1', r2: 'event:1', r3: 'uncertain:1', r4: 'social:1' }), batch), batch, 'social')
  assert.deepEqual(social.find(item => item.category === 'social').fragments.map(fragment => fragment.sourceId), [1, 4])
}

// 未知/额外/重复/语法错误及金句非法均先于覆盖；不能被转换为补漏成功。
function checkIllegalPrecedence() {
  const batch = candidateFixture(), valid = { r1: 'event:1', r2: 'social:1', r3: 'event:2', r4: 'event:1' }
  const invalid = [candidateResponse({ r1: 'event:1', r99: 'social:1' }), candidateResponse({ r1: 'event:01' }),
    candidateResponse({ r1: 'event:9' }), candidateResponse({ r1: 'event:1|event:1' }), candidateResponse({ r1: '' }),
    candidateResponse({ r1: 'event:1|' }), candidateResponse({ r1: 'social:1', m1: 'social:1' }), candidateResponse({ r1: ['event:1'] }),
    candidateResponse({ r1: 'event:1' }, [{ kind: 'quote', ref: 'r99', criterion: 'clear_viewpoint' }]),
    candidateResponse({ r1: 'event:1' }, [{ kind: 'quote', ref: 'r1', criterion: 'toString' }]),
    candidateResponse(valid, [{ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint', reason: '越权文字' }]),
    candidateResponse(valid, Array.from({ length: 4 }, () => ({ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint' }))),
    '{"records":{"r1":"event:1","r1":"event:2"},"quotes":[],"completed":true}',
    '{"records":{"r1":"event:1","\\u00721":"event:2"},"quotes":[],"completed":true}',
    '{"records":{"r1":"event:1"},"quotes":[],"completed":false}',
    '{"records":{"r1":"event:1"},"quotes":[],"completed":true,"ledger":{}}']
  for (const text of invalid) assert.throws(() => candidates.readReportClassification(text, batch), error => !(error instanceof candidates.ClassificationCoverageError))
  assert.equal(candidates.createReportClassificationRepair(new Error('普通结构失败'), batch), undefined)
}

// 实际不同kind也占独立组；明确反馈真实超限数量，不把分组错误误报为金句超限。
function checkBudgetDiagnosis() {
  const batch = candidateFixture(), groups = Array.from({ length: 8 }, (_, index) => 'event:' + (index + 1)).join('|')
  for (const malformed of [{ kind: 'quote', r45: 'r3', criterion: 'clear_viewpoint' },
    { kind: 'quote', r: 'r3', ref: 'r3', criterion: 'clear_viewpoint' }]) {
    const text = candidateResponse({ r1: 'event:1', r2: 'event:1', r3: 'event:1', r4: 'social:1' },
      [{ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint' }, { kind: 'quote', ref: 'r2', criterion: 'clear_viewpoint' }, malformed])
    assert.throws(() => candidates.readReportClassification(text, batch), /候选金句第3项（字段必须且只能是kind、ref、criterion）/)
  }
  assert.throws(() => candidates.readReportClassification(candidateResponse({ r1: 'social' }), batch), /records中的r1仅给类别social；仍须写成social:正整数组号/)
  assert.throws(() => candidates.readReportClassification(candidateResponse({ r1: groups, r2: 'social:1', r3: 'event:3', r4: 'event:4' }), batch), /分类分组9超过8组上限/)
  assert.throws(() => candidates.readReportClassification(candidateResponse({ r1: 'event:1' }, Array.from({ length: 4 }, () => ({ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint' }))), batch), /候选金句4超过3条上限/)
}

// 组名必须定义已列归属，合法未使用名称不产生来源；非法组名优先于缺漏，名称不被提升为摘要事实。
function checkNamedGroups() {
  const batch = candidateFixture(), root = JSON.parse(candidateResponse({ r1: 'event:1' }))
  for (const groups of [{}, { 'event:1': '讨论', 'event:99': '非法组号' }, { 'event:1': ' ' }, { 'event:1': '字'.repeat(33) }, [], null]) {
    assert.throws(() => candidates.readReportClassification(JSON.stringify({ ...root, groups }), batch), error => !(error instanceof candidates.ClassificationCoverageError))
  }
  assert.throws(() => candidates.readReportClassification(JSON.stringify({ ...root, records: { r1: 'event:1' }, groups: {} }), batch), /groups缺少分类组名：event:1/)
  const complete = candidateResponse({ r1: 'event:1', r2: 'event:1', r3: 'event:1', r4: 'event:1' })
  const withUnused = JSON.parse(complete); withUnused.groups['social:1'] = '未使用社交名'
  const records = candidates.readReportClassification(JSON.stringify(withUnused), batch)
  assert.equal(records.length, 1)
  assert.equal(records[0].title, '测试讨论'); assert.equal(records[0].summary, '')
  assert.equal(candidates.createReportCandidates(records, batch, 'scoped')[0].title, '测试讨论')
  const duplicate = complete.replace('"groups":{', '"groups":{"event:1":"重复",')
  assert.throws(() => candidates.readReportClassification(duplicate, batch), /重复|DUPLICATE/)
  const old = JSON.parse(complete); delete old.groups
  assert.throws(() => candidates.readReportClassification(JSON.stringify(old), batch))
  const withoutRepeatedNames = JSON.parse(candidateResponse({ r1: 'response:1', r2: 'social:1', r3: 'media:1', r4: 'uncertain:1' })); withoutRepeatedNames.groups = {}
  assert.equal(candidates.readReportClassification(JSON.stringify(withoutRepeatedNames), batch).length, 4)
  const payload = JSON.parse(batch.input)
  assert.equal(payload.version, 'evidence-batch-4'); assert.equal(Object.hasOwn(payload, 'maximumGroups'), false)
}

// 必需核心原生Schema及精确纯图账本支持合法零事件，不把混合媒体隐式过滤。
function checkSchemaAndEmptyEvents() {
  const batch = candidateFixture(), schema = candidates.getReportClassificationSchema(batch.input)
  assert.deepEqual(schema.properties.records.required, ['r1', 'r2', 'r3', 'r4'])
  assert.equal(schema.additionalProperties, false)
  const records = candidates.readReportClassification(candidateResponse({ r1: 'social:1', r2: 'social:1', r3: 'uncertain:1', r4: 'media:1' }), batch)
  assert.equal(candidates.createReportCandidates(records, batch, 'zero').filter(item => item.kind === 'event').length, 0)
  const snapshot = material.createReportEvidence(['[图片]', ' [图片]', '[图片]更正', '[图片][图片]', ''].map((content, index) => ({ content, userId: String(index) })))
  const images = candidates.createImageReportCandidates(snapshot)
  assert.equal(images.length, 1); assert.equal(images[0].category, 'media')
  assert.deepEqual(images[0].rawFacts[0].parts, [{ memberId: '0' }, '[图片]'])
  assert.ok(candidates.getReportClassificationInstructions().includes('具体数字或条件'))
}

// 经正式单元入口只补r3/r4，首次归属/原话及局部成员表保持；保存收到完整并集。
async function checkRequestRepair() {
  const batch = candidateFixture(), calls = [], saved = []
  const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
  const value = await engine.requestAnalysisUnit({ deadlineMs: Date.now() + 60000,
    recoveryInstructions: '只返回完整records/quotes/completed对象',
    request: async (system, input, _tokens, extra) => {
      extra._onRequestAttempt(); calls.push({ system, input })
      return calls.length === 1 ? candidateResponse({ r1: 'event:1', r2: 'social:1' }, [{ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint' }])
        : candidateResponse({ r3: 'event:1', r4: 'response:1' })
    }, onUnitCompleted(_unit, attempts, result) { saved.push({ attempts, result }) } }, diagnostics,
  { id: 'classification', stage: 'compression', sourceIds: [1, 2, 3, 4], timestamps: [] }, candidates.getReportClassificationInstructions(), batch.input, 5000, 1000,
  text => candidates.readReportClassification(text, batch), error => candidates.createReportClassificationRepair(error, batch))
  assert.equal(calls.length, 2); assert.equal(diagnostics.retryCount, 1); assert.equal(diagnostics.requestCount, 2)
  const repairInput = JSON.parse(calls[1].input), originalInput = JSON.parse(batch.input)
  assert.deepEqual(repairInput.items.map(item => item.ref), ['r3', 'r4'])
  assert.deepEqual(repairInput.members, originalInput.members); assert.deepEqual(repairInput.context, originalInput.context)
  assert.deepEqual(value[0].refs, ['r1']); assert.equal(value[0].kind, 'event')
  assert.equal(value.find(item => item.kind === 'quote').ref, 'r1')
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].result, value)
}

// 首轮合法金句可以引用尚缺分类的核心；恢复不得覆盖理由或突破三条候选上限。
function checkRepairQuotePriority() {
  const batch = candidateFixture()
  let missing
  try { candidates.readReportClassification(candidateResponse({ r1: 'event:1', r2: 'social:1' },
    ['r1', 'r2', 'r3'].map(ref => ({ kind: 'quote', ref, criterion: 'clear_viewpoint' }))), batch) } catch (error) { missing = error }
  const repair = candidates.createReportClassificationRepair(missing, batch)
  const value = repair.validate(candidateResponse({ r3: 'event:1', r4: 'response:1' },
    [{ kind: 'quote', ref: 'r3', criterion: 'situational_humor' }, { kind: 'quote', ref: 'r4', criterion: 'useful_insight' }]))
  const quotes = value.filter(record => record.kind === 'quote')
  assert.deepEqual(quotes.map(record => record.ref), ['r1', 'r2', 'r3'])
  assert(quotes.every(record => record.reason === '鲜明观点'))
  assert.equal(new Set(value.flatMap(record => record.kind === 'quote' ? [] : record.refs)).size, 4)
}

// 恢复再次遗漏/试改首轮/非法金句均两轮后失败；保存错误不会重开模型预算。
async function checkRequestFailures() {
  for (const mode of ['missing', 'rewrite', 'quote', 'persist']) {
    const batch = candidateFixture(), calls = [], saved = [], failures = []
    const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
    await assert.rejects(engine.requestAnalysisUnit({ deadlineMs: Date.now() + 60000, recoveryInstructions: '完整分类对象',
      request: async (_system, input, _tokens, extra) => {
        extra._onRequestAttempt(); calls.push(input)
        if (mode === 'persist') return candidateResponse({ r1: 'event:1', r2: 'social:1', r3: 'event:2', r4: 'event:1' })
        if (calls.length === 1) return candidateResponse({ r1: 'event:1', r2: 'social:1' })
        return mode === 'missing' ? candidateResponse({ r3: 'event:1' }) : mode === 'rewrite' ? candidateResponse({ r1: 'social:1', r3: 'event:1', r4: 'social:1' })
          : candidateResponse({ r3: 'event:1', r4: 'social:1' }, [{ kind: 'quote', ref: 'r1', criterion: 'clear_viewpoint' }])
      }, onUnitCompleted() { if (mode === 'persist') throw new Error('模拟落盘失败'); saved.push(true) },
      onUnitFailed(_unit, attempts) { failures.push(attempts) } }, diagnostics,
    { id: 'classification-failure', stage: 'compression', sourceIds: [1, 2, 3, 4], timestamps: [] }, '完整分类', batch.input, 5000, 1000,
    text => candidates.readReportClassification(text, batch), error => candidates.createReportClassificationRepair(error, batch)))
    assert.equal(calls.length, mode === 'persist' ? 1 : 2)
    assert.equal(saved.length, 0); assert.equal(failures.length, 1)
    assert.equal(diagnostics.retryCount, mode === 'persist' ? 0 : 1)
  }
}

// 接入正式日报测试汇总，每项独立数据且失败继续汇总。
async function runReportCandidateTests(check) {
  for (const [label, run] of [['分类多归属、段封闭、完整原话与永久本人', checkLedgerAndOwnership],
    ['具体回应跨实质事件分段，互动穿插与多归属完整保留', checkResponseSegments],
    ['分类未知/重复/额外字段与金句非法优先于缺漏', checkIllegalPrecedence], ['分组和金句上限分别反馈真实数量', checkBudgetDiagnosis], ['具名分类严格匹配、非法优先与事实隔离', checkNamedGroups], ['必需Schema、精确纯图及合法零事件', checkSchemaAndEmptyEvents],
    ['正式分类单元只补缺失、冻结别名与首轮保持', checkRequestRepair], ['分类补漏金句首轮优先且最终候选不超过三条', checkRepairQuotePriority],
    ['分类恢复仍失败或保存失败不产生完成结果', checkRequestFailures]]) {
    try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportCandidateTests }
