/** 永久来源、本人成员、局部引用重绑和精确请求条件的固定回归。 */
'use strict'
const assert = require('assert').strict
const { createReportEvidence, buildReportEvidenceBatch } = require('../lib/report-evidence')
const { readReportClassification, createReportCandidates, getReportClassificationInstructions } = require('../lib/report-candidates')
const { bindReportClassification, restoreReportClassification, createClassificationRequestIdentity } = require('../lib/report-bindings')

// 核心两人的昵称相同，周围真实来源充足，滑动首尾不会改变本批实际上下文。
function bindingFixture(change = {}) {
  const messages = Array.from({ length: 40 }, (_, index) => ({ messageId: 'message-' + index, realMessageId: true,
    userId: 'member-' + index % 3, user: '同名群友', ts: 10000 + index, time: '04:00',
    content: index === 17 ? '原话  😀保持空白' : '真实消息' + index,
    ...(index === 18 ? { replyToId: 'message-16' } : {}), ...(change[index] || {}) }))
  const snapshot = createReportEvidence(messages)
  const batch = buildReportEvidenceBatch(snapshot, snapshot.fragments.filter(fragment => fragment.sourceId >= 18 && fragment.sourceId <= 20))
  const records = readReportClassification(JSON.stringify({ groups: { 'event:1': '版本讨论', 'social:1': '社交' }, records: { r1: 'event:1', r2: 'event:1', r3: 'social:1' },
    quotes: [{ kind: 'quote', ref: 'r1', criterion: 'distinct_expression' }], completed: true }), batch)
  return { messages, snapshot, batch, records }
}

// 固定请求条件不接收任务编号、创建时间或全局连续引用。
function identityOptions(changes = {}) {
  return { channelKey: 'group-A', periodStartMs: 1000, periodEndMs: 200000,
    sourceCompleteness: 'complete', modelPolicyIdentity: 'frozen-two-node-policy', batchRuleIdentity: 'stable-rule-1',
    system: getReportClassificationInstructions(), maxTokens: 4096, ...changes }
}

// 独立报告验收，坏产物不能污染后续模块入口。
function bindingCase(check, name, run) {
  try { run(); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 这些检查只覆盖确定性身份与所有权，不声称模型的语义分类正确。
function runReportBindingTests(check) {
  bindingCase(check, '待核实范围在永久v2原样恢复，旧v1仅接受原空名称且未知版本拒绝', () => {
    const { snapshot, batch, records } = bindingFixture(), value = bindReportClassification(snapshot, batch, records)
    assert.equal(value.version, 'permanent-classification-2')
    assert.equal(value.records[0].title, '版本讨论')
    assert.equal(restoreReportClassification(snapshot, batch, value)[0].title, '版本讨论')
    const old = JSON.parse(JSON.stringify(value)); old.version = 'permanent-classification-1'
    assert.throws(() => restoreReportClassification(snapshot, batch, old))
    for (const record of old.records) if (record.kind !== 'quote') record.title = ''
    assert(restoreReportClassification(snapshot, batch, old).filter(record => record.kind !== 'quote').every(record => record.title === ''))
    const unknown = { ...value, version: 'permanent-classification-99' }
    assert.throws(() => restoreReportClassification(snapshot, batch, unknown))
    const tooLong = JSON.parse(JSON.stringify(value)); tooLong.records[0].title = '😀'.repeat(33)
    assert.throws(() => restoreReportClassification(snapshot, batch, tooLong))
  })
  bindingCase(check, '永久分类只存真实片段与本人，滑动序号及同名改名重绑后原话逐字保持', () => {
    const original = bindingFixture(), value = bindReportClassification(original.snapshot, original.batch, original.records)
    assert(value)
    assert(!JSON.stringify(value).includes('"sourceId":'))
    assert.equal(value.records.at(-1).memberId, 'member-2')
    const messages = original.messages.slice(5).map(message => ({ ...message, user: '本次昵称-' + message.userId }))
    const current = createReportEvidence(messages)
    const batch = buildReportEvidenceBatch(current, current.fragments.filter(fragment => ['message-17', 'message-18', 'message-19'].includes(current.sources[fragment.sourceId - 1].messageId)))
    assert.notEqual(original.batch.fragments[0].id, batch.fragments[0].id)
    const restored = restoreReportClassification(current, batch, JSON.parse(JSON.stringify(value)))
    assert.deepEqual(restored, original.records)
    const candidates = createReportCandidates(restored, batch, 'new-task')
    const quote = candidates.find(candidate => candidate.kind === 'quote')
    assert.equal(quote.fragments[0].text, '原话  😀保持空白')
    assert.equal(quote.rawFacts.length, 0)
    assert.equal(batch.members.get(batch.core.get('r1').author).name, '本次昵称-member-2')
    assert.equal(createClassificationRequestIdentity(current, batch, identityOptions()),
      createClassificationRequestIdentity(original.snapshot, original.batch, identityOptions()))
  })
  bindingCase(check, '原文、时间、本人或回复更正拒绝旧永久产物，不按同名猜绑', () => {
    const original = bindingFixture(), value = bindReportClassification(original.snapshot, original.batch, original.records)
    for (const change of [{ content: '原话 😀保持空白' }, { ts: 20000 }, { userId: 'other-member' }, { replyToId: 'different-parent' }]) {
      const current = bindingFixture({ 17: change })
      assert.throws(() => restoreReportClassification(current.snapshot, current.batch, value), /不能绑定/)
      assert.notEqual(createClassificationRequestIdentity(current.snapshot, current.batch, identityOptions()),
        createClassificationRequestIdentity(original.snapshot, original.batch, identityOptions()))
    }
  })
  bindingCase(check, '金句篡改本人、缺漏归属、未知字段与非法类别即使可解析也拒绝', () => {
    const { snapshot, batch, records } = bindingFixture(), value = bindReportClassification(snapshot, batch, records)
    for (const mutate of [
      value => { value.records.at(-1).memberId = 'other-member' },
      value => { value.records.splice(1, 1) },
      value => { value.records[0].category = 'unknown' },
      value => { value.records[0].keys.push('nonexistent') },
      value => { value.records[0].extra = 'unknown' },
      value => { value.records.at(-1).reason = '模型虚构理由' },
      value => { value.members[0].memberId = 'another-user' },
    ]) {
      const changed = JSON.parse(JSON.stringify(value)); mutate(changed)
      assert.throws(() => restoreReportClassification(snapshot, batch, changed))
    }
    assert.throws(() => bindReportClassification(snapshot, batch, records.filter(record => record.kind === 'quote')), /未覆盖/)
    const forgedBatch = { ...batch, core: new Map([...batch.core].map(([ref, fragment]) => [ref, { ...fragment, sourceId: 1 }])) }
    assert.throws(() => bindReportClassification(snapshot, forgedBatch, records), /所有权不一致/)
  })
  bindingCase(check, '实际父消息、邻居及人物别名变化失效，非供料远处内容变化不误失效', () => {
    const original = bindingFixture(), initial = createClassificationRequestIdentity(original.snapshot, original.batch, identityOptions())
    for (const [index, change] of [[16, { content: '父消息更正' }], [15, { content: '邻居更正' }], [16, { userId: 'different-parent-author' }]]) {
      const current = bindingFixture({ [index]: change })
      assert.notEqual(createClassificationRequestIdentity(current.snapshot, current.batch, identityOptions()), initial)
    }
    const distant = bindingFixture({ 1: { content: '非供料远处变化' } })
    assert.equal(createClassificationRequestIdentity(distant.snapshot, distant.batch, identityOptions()), initial)
    const renamed = { ...original.batch, members: new Map([...original.batch.members].reverse()) }
    assert.notEqual(createClassificationRequestIdentity(original.snapshot, renamed, identityOptions()), initial)
  })
  bindingCase(check, '群、业务范围、冻结策略、提示、分批版本和实际序列化变更均改变请求身份', () => {
    const { snapshot, batch } = bindingFixture(), initial = createClassificationRequestIdentity(snapshot, batch, identityOptions())
    for (const change of [{ channelKey: 'group-B' }, { periodStartMs: 2000 }, { periodEndMs: 200001 },
      { modelPolicyIdentity: 'changed-model-order' }, { system: '新契约提示' }, { batchRuleIdentity: 'new-rule' }]) {
      assert.notEqual(createClassificationRequestIdentity(snapshot, batch, identityOptions(change)), initial)
    }
    assert.notEqual(createClassificationRequestIdentity(snapshot, { ...batch, input: batch.input + ' ' }, identityOptions()), initial)
    assert.throws(() => createClassificationRequestIdentity(snapshot, batch, identityOptions({ maxTokens: 8192 })), /身份条件无效/)
  })
  bindingCase(check, '无可靠消息身份和历史未知完整性没有跨任务资格，完整性不能由缓存提升', () => {
    const { messages, records, snapshot, batch } = bindingFixture()
    for (const completeness of ['legacy_unknown', 'incomplete']) {
      assert.equal(createClassificationRequestIdentity(snapshot, batch, identityOptions({ sourceCompleteness: completeness })), null)
    }
    const legacy = createReportEvidence(messages.map(message => ({ ...message, realMessageId: false })))
    const legacyBatch = buildReportEvidenceBatch(legacy, legacy.fragments.slice(17, 20))
    assert.equal(bindReportClassification(legacy, legacyBatch, records), null)
    assert.equal(createClassificationRequestIdentity(legacy, legacyBatch, identityOptions()), null)
  })
  bindingCase(check, '辅助预算独立于全局来源数量，远处追加不会改写相同核心与上下文', () => {
    for (const length of [50, 100, 150, 199, 200, 250, 400]) {
      const original = bindingFixture({
        11: { content: '父'.repeat(length) }, 12: { content: '父'.repeat(length) },
        13: { content: '父'.repeat(length), replyToId: 'message-11' }, 14: { content: '父'.repeat(length), replyToId: 'message-12' },
        15: { content: '父'.repeat(length), replyToId: 'message-13' }, 16: { content: '父'.repeat(length), replyToId: 'message-14' },
        17: { replyToId: 'message-15' }, 18: { replyToId: 'message-16' }, 19: { replyToId: 'message-16' },
      })
      const current = createReportEvidence([...original.messages, ...Array.from({ length: 1000 }, (_, index) => ({ messageId: 'far-' + index,
        realMessageId: true, userId: 'far-member', user: '远处成员', content: '远处追加', ts: 30000 + index, time: '04:00' }))])
      const batch = buildReportEvidenceBatch(current, current.fragments.slice(17, 20))
      assert.equal(batch.input, original.batch.input)
      assert.equal(createClassificationRequestIdentity(current, batch, identityOptions()),
        createClassificationRequestIdentity(original.snapshot, original.batch, identityOptions()))
    }
  })
}

module.exports = { runReportBindingTests }
