/** 固定来源、完整分片与真实回复材料测试；纯材料入口，无模型或群消息mock。 */
'use strict'
const assert = require('assert').strict
const { createReportEvidence, buildReportEvidenceBatch, partitionReportEvidence, packReportEvidenceBatches } = require('../lib/report-evidence')

// 每个场景独立验证，异常计入正式日报测试结果。
function evidenceCase(check, label, run) {
  try { run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 来源与UTF16代理对保持完整，外部输入修改不改变已经固定的本次材料。
function checkSnapshotAndFragments() {
  const messages = [{ analysisId: 1, messageId: 'real-a', realMessageId: true, userId: 'a', user: '同名', ts: 1,
    content: '字'.repeat(2399) + '🫠后续更正为护盾。' }, { analysisId: 2, userId: 'b', user: '同名', ts: 2, content: '完整短回应' }]
  const snapshot = createReportEvidence(messages)
  messages[0].content = '被修改'; messages[0].user = '被改名'
  const first = snapshot.fragments.filter(fragment => fragment.sourceId === 1)
  assert.equal(first.length, 2)
  assert.equal(first.map(fragment => fragment.text).join(''), '字'.repeat(2399) + '🫠后续更正为护盾。')
  assert.equal(first[0].partCount, 2)
  assert.ok(first.every(fragment => !/[\uD800-\uDBFF]$/.test(fragment.text) && !/^[\uDC00-\uDFFF]/.test(fragment.text)))
  assert.ok(first.every(fragment => fragment.permanentKey))
  assert.equal(snapshot.sources[0].name, '同名')
  assert.equal(snapshot.sources[0].realMessageId, true)
  assert.equal(snapshot.sources[1].realMessageId, null)
  assert.equal(snapshot.hasStableMessageIds, false)
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.sources) && Object.isFrozen(first[0]))
  assert.throws(() => { snapshot.sources[0].content = '非法改写' }, TypeError)
}

// 本次序号或显示名改变只重绑展示；正文、真实回复和实际提供材料变化必须改变身份。
function checkPermanentBindings() {
  const message = { messageId: 'real-a', realMessageId: true, userId: 'a', user: '甲', ts: 1, content: '原话  保留空白' }
  const old = createReportEvidence([message])
  const shifted = createReportEvidence([{ messageId: 'real-b', realMessageId: true, userId: 'b', content: '新来源' }, { ...message, user: '改名' }])
  assert.equal(old.fragments[0].permanentKey, shifted.fragments[1].permanentKey)
  assert.notEqual(old.fragments[0].id, shifted.fragments[1].id)
  assert.equal(old.sources[0].identity, shifted.sources[1].identity)
  assert.notEqual(old.identity, shifted.identity)
  for (const changed of [{ content: '原话 保留空白' }, { replyToId: 'unknown-parent' }, { ts: 2 }, { userId: 'b' }]) {
    assert.notEqual(old.fragments[0].permanentKey, createReportEvidence([{ ...message, ...changed }]).fragments[0].permanentKey)
  }
  const legacy = createReportEvidence([{ ...message, realMessageId: false }])
  assert.equal(legacy.fragments[0].permanentKey, null)
  assert.equal(legacy.hasStableMessageIds, false)
}

// 已知父消息最多三层，缺失与循环明确有界；辅助不承担核心覆盖。
function checkReplyMaterial() {
  const messages = Array.from({ length: 5 }, (_, index) => ({ messageId: 'id-' + index, userId: index % 2 ? 'b' : 'a', user: '同名',
    content: '原话' + index, replyToId: index < 4 ? 'id-' + (index + 1) : undefined }))
  const snapshot = createReportEvidence(messages), batch = buildReportEvidenceBatch(snapshot, [snapshot.fragments[0]])
  const input = JSON.parse(batch.input)
  assert.equal(input.items.length, 1)
  assert.equal(input.items[0].role, 'core')
  assert.deepEqual(input.items[0].replies.map(reply => reply.state), ['available', 'available', 'available'])
  assert.deepEqual(input.items[0].replies.map(reply => input.context.find(item => item.ref === reply.ref).text), ['原话1', '原话2', '原话3'])
  assert.equal(batch.core.get('r1').author, 'p1')
  assert.equal(batch.members.get('p2').userId, 'b')
  assert.ok(input.members.every(member => Object.keys(member).join(',') === 'ref'))
  assert.ok(input.context.every(item => item.role === 'auxiliary'))
  messages[1].replyToId = 'id-0'
  const cycle = createReportEvidence(messages)
  assert.deepEqual(JSON.parse(buildReportEvidenceBatch(cycle, [cycle.fragments[0]]).input).items[0].replies.map(reply => reply.state), ['available', 'cycle'])
  const missing = createReportEvidence([{ userId: 'a', content: '短回应', replyToId: 'outside' }])
  assert.deepEqual(JSON.parse(buildReportEvidenceBatch(missing, missing.fragments).input).items[0].replies, [{ state: 'unavailable' }])
  const unknown = createReportEvidence([{ userId: 'a', content: '短回应' }])
  assert.deepEqual(JSON.parse(buildReportEvidenceBatch(unknown, unknown.fragments).input).items[0].replies, [{ state: 'unknown' }])
}

// 只有精确纯图片走确定规则；空白、混合文字、其他媒体及长文尾部均进入模型核心。
function checkPartitionAndBatches() {
  const texts = ['[图片]', ' [图片]', '[图片] ', '[图片][图片]', '正文[图片]', '[语音]', '']
  const messages = texts.map((content, index) => ({ userId: 'a', ts: index, content }))
  for (let index = 0; index < 400; index++) messages.push({ userId: index % 2 ? 'b' : 'a', ts: index + 10, content: '原话' + index + 'x'.repeat(30) })
  messages.push({ userId: 'b', content: '长文'.repeat(2600) + '实际末尾更正。' })
  const snapshot = createReportEvidence(messages), partition = partitionReportEvidence(snapshot), batches = packReportEvidenceBatches(snapshot)
  assert.deepEqual(partition.deterministic.map(fragment => fragment.sourceId), [1])
  const modelIds = batches.flatMap(batch => batch.fragments.map(fragment => fragment.id))
  assert.deepEqual(modelIds, partition.model.map(fragment => fragment.id))
  const allIds = [...modelIds, ...partition.deterministic.map(fragment => fragment.id)]
  assert.equal(new Set(allIds).size, snapshot.fragments.length)
  assert.ok(batches.length > 1)
  assert.ok(batches.every(batch => batch.input.length <= 16000 && new Set(batch.fragments.map(fragment => fragment.sourceId)).size <= 64))
  assert.ok(batches.every(batch => batch.fragments.length <= 64 && batch.coreCharacters <= 12000 && batch.auxiliaryCharacters <= 2000))
  assert.ok(JSON.parse(batches.at(-1).input).items.some(item => item.text.includes('实际末尾更正。')))
  const oversized = createReportEvidence([{ userId: 'a', time: 'x'.repeat(16000), content: '完整正文' }])
  assert.throws(() => packReportEvidenceBatches(oversized), /超过模型材料预算/)
}

// 回复与邻居合计有界；预算未供料不同于父消息不存在，前邻居保留末尾。
function checkAuxiliaryBudget() {
  const messages = Array.from({ length: 14 }, (_, index) => ({ messageId: 'msg-' + index, userId: 'u' + index,
    content: '开头' + '字'.repeat(900) + '末尾' + index, replyToId: index >= 7 ? 'msg-' + (index - 7) : undefined }))
  const snapshot = createReportEvidence(messages), batch = buildReportEvidenceBatch(snapshot, snapshot.fragments.slice(7))
  const input = JSON.parse(batch.input)
  assert.ok(Array.from(JSON.stringify(input.context)).length <= 2000)
  assert.ok(input.items.some(item => item.replies.some(reply => reply.state === 'budget_not_provided')))
  assert.ok(input.context.every(item => item.role === 'auxiliary' && item.excerptOnly))
  assert.equal(input.items.reduce((count, item) => count + item.text.length, 0), messages.slice(7).reduce((count, message) => count + message.content.length, 0))
  const middle = JSON.parse(buildReportEvidenceBatch(snapshot, [snapshot.fragments[3]]).input)
  assert.ok(middle.context.some(item => item.text.endsWith('末尾2')))
}

// 缺少身份、重复真实标识、跨快照片段和重复核心准确拒绝，不猜补所有权。
function checkIllegalOwnership() {
  for (const message of [{ content: '无成员' }, { userId: 'a' }, { userId: NaN, content: '非法成员' },
    { userId: 'a', content: '原话', replyToId: 9 }, { userId: 'a', content: '原话', realMessageId: 'true' },
    { userId: 'a', content: '原话', analysisId: 2 }]) assert.throws(() => createReportEvidence([message]))
  assert.throws(() => createReportEvidence([{ messageId: 'same', userId: 'a', content: '甲' }, { messageId: 'same', userId: 'b', content: '乙' }]), /重复消息标识/)
  const snapshot = createReportEvidence([{ userId: 'a', content: '原话' }])
  assert.throws(() => buildReportEvidenceBatch(snapshot, []), /当前快照/)
  assert.throws(() => buildReportEvidenceBatch(snapshot, [{ ...snapshot.fragments[0] }]), /当前快照/)
  assert.throws(() => buildReportEvidenceBatch(snapshot, [snapshot.fragments[0], snapshot.fragments[0]]), /重复核心/)
  const empty = createReportEvidence([])
  assert.equal(empty.hasStableMessageIds, false)
  assert.deepEqual(packReportEvidenceBatches(empty), [])
}

// 注册到正式日报测试入口，直接执行导出文件不会被误报为测试完成。
function runReportEvidenceTests(check) {
  evidenceCase(check, '固定快照完整Unicode分片与外部修改隔离', checkSnapshotAndFragments)
  evidenceCase(check, '永久人物来源重绑、原话空白与真实依赖身份', checkPermanentBindings)
  evidenceCase(check, '三层真实回复、缺失循环与核心辅助所有权', checkReplyMaterial)
  evidenceCase(check, '精确纯图分区、完整长文尾部与实际64/16k预算', checkPartitionAndBatches)
  evidenceCase(check, '缺失身份、重复标识、跨快照与重复核心拒绝', checkIllegalOwnership)
  evidenceCase(check, '父消息和邻居共同2000字预算、未供料原因及前邻居末尾', checkAuxiliaryBudget)
}
module.exports = { runReportEvidenceTests }
