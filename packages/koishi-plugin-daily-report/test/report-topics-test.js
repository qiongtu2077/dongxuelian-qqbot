/** 中性话题真实读取器的来源、覆盖、排序和恢复行为。 */
'use strict'
const assert = require('assert').strict
const evidence = require('../lib/report-evidence'), topics = require('../lib/report-topics')

// 固定同名不同成员、重复正文与来源交错，排序不依赖昵称。
function topicFixture() {
  const snapshot = evidence.createReportEvidence([
    { userId: 'a', user: '同名', content: '讨论安装方案' }, { userId: 'b', user: '同名', content: '讨论安装方案' },
    { userId: 'c', content: '安排出行集合' }, { userId: 'a', content: '确认安装设置' },
  ])
  const candidates = [{ id: 'a', fragments: snapshot.fragments.slice(0, 2) }, { id: 'b', fragments: snapshot.fragments.slice(2, 3) },
    { id: 'c', fragments: snapshot.fragments.slice(3) }]
  return { snapshot, candidates, context: topics.createTopicContext(snapshot, candidates) }
}

// 不合并和未选合并的候选均保存；重复、未知与多余字段不能猜修。
function checkGrouping() {
  const { context, candidates } = topicFixture()
  assert.deepEqual(topics.readTopicGrouping('{"groups":[["c1","c3"]],"completed":true}', context), [[candidates[0], candidates[2]], [candidates[1]]])
  assert.deepEqual(topics.readTopicGrouping('{"groups":[],"completed":true}', context), candidates.map(candidate => [candidate]))
  for (const groups of [[['c1']], [['c1', 'c1']], [['c1', 'c99']], [['c1', 'c2'], ['c2', 'c3']]]) {
    assert.throws(() => topics.readTopicGrouping(JSON.stringify({ groups, completed: true }), context))
  }
  assert.throws(() => topics.readTopicGrouping('{"groups":[],"completed":true,"extra":1}', context), /FIELD_TYPE/)
  assert.throws(() => topics.readTopicGrouping('{"groups":[],"groups":[],"completed":true}', context), /FIELD_DUPLICATE/)
  assert.throws(() => topics.readTopicGrouping('{"groups":[["c1","c2"]]}', context), /根字段必须且只能是groups、completed/)
  assert.throws(() => topics.readTopicGrouping('{"groups":[["c1","c2"],["c2","c3"]],"completed":true}', context), /合并候选c2重复；每个c只能出现在一组一次/)
}

// 候选内嵌原文保留真实作者、完整长片段与多归属；不能用共享r暗示同一事件。
function checkInlineGroupingMaterial() {
  const snapshot = evidence.createReportEvidence([{ messageId: 'long', userId: 'a', content: '多问题原文😀'.repeat(900) + '真实尾部' },
    { messageId: 'reply', userId: 'b', content: '独立回应', replyToId: 'long' }])
  const shared = snapshot.fragments.slice(0, -1)
  const candidates = [{ id: 'first', kind: 'event', fragments: shared, scopeHints: ['待核实机制范围'] }, { id: 'second', kind: 'event', fragments: shared, scopeHints: ['另一个讨论范围'] },
    { id: 'reply', kind: 'interaction', category: 'response', fragments: snapshot.fragments.slice(-1) }]
  const references = topics.createTopicContext(snapshot, candidates), inline = topics.createTopicContext(snapshot, candidates, 'inline')
  const before = JSON.parse(references.input), after = JSON.parse(inline.input)
  assert.equal(Object.hasOwn(after, 'sources'), false)
  assert.deepEqual(after.members, before.members); assert.deepEqual(after.context, before.context)
  for (const [index, candidate] of after.candidates.entries()) {
    assert.deepEqual(candidate.refs, before.candidates[index].refs)
    assert.deepEqual(candidate.scopeHints, candidates[index].scopeHints)
    assert.deepEqual(candidate.sources, candidate.refs.map(ref => before.sources.find(source => source.ref === ref)))
    assert.equal(candidate.sources.map(source => source.text).join(''), candidates[index].fragments.map(fragment => fragment.text).join(''))
  }
  assert(after.candidates[0].sources.at(-1).text.endsWith('真实尾部'))
  assert.deepEqual(after.candidates[0].sources, after.candidates[1].sources)
  assert.deepEqual([...inline.sources], [...references.sources]); assert.deepEqual(inline.cacheMaterial, references.cacheMaterial)
  assert(after.candidates.flatMap(candidate => candidate.sources).length > inline.sources.size)
  assert.deepEqual(topics.readTopicGrouping('{"groups":[],"completed":true}', inline), candidates.map(candidate => [candidate]))
  const comparison = topics.createTopicComparisonContext(snapshot, candidates, new Map(candidates.map(candidate => [candidate.id, 3])), 5)
  const compact = JSON.parse(comparison.input)
  assert.equal(compact.kind, 'selection-comparison-1'); assert.equal(compact.displayLimit, 5)
  assert.deepEqual(compact.requiredCandidateRefs, ['c1', 'c2', 'c3'])
  assert(compact.sources.every(source => source.excerptOnly && Array.from(source.text).length <= 200))
  assert(compact.sources.every(source => comparison.sources.get(source.ref)[0].text.startsWith(source.text)))
  assert.equal(compact.candidates[0].sourceCount, 1); assert.equal(compact.candidates[0].memberCount, 1)
  assert.deepEqual(compact.candidates[0].scopeHints, candidates[0].scopeHints)
  assert.deepEqual([...comparison.candidates.values()], candidates)
  let missing
  try { topics.readTopicPriorities('{"priorities":{"c1":3,"c2":0},"completed":true}', comparison) } catch (error) { missing = error }
  const repair = topics.createTopicPriorityRepair(missing, comparison), subset = JSON.parse(repair.input)
  assert.equal(subset.kind, 'selection-comparison-1'); assert.deepEqual(subset.requiredCandidateRefs, ['c3'])
  assert.deepEqual(repair.validate('{"priorities":{"c3":1},"completed":true}'), { c1: 3, c2: 0, c3: 1 })
}

// 代表比较必须由模型在名额内提名；超额先拒绝，补漏只能使用未占用名额。
function checkComparisonNominationLimit() {
  const snapshot = evidence.createReportEvidence(Array.from({ length: 7 }, (_, index) => ({ userId: 'member-' + index, content: '具体问题' + index })))
  const candidates = snapshot.fragments.map(fragment => ({ id: fragment.id, fragments: [fragment] }))
  const context = topics.createTopicComparisonContext(snapshot, candidates, new Map(candidates.map(candidate => [candidate.id, 3])), 5)
  const response = priorities => JSON.stringify({ priorities, completed: true })
  const six = Object.fromEntries(Array.from({ length: 6 }, (_, index) => ['c' + (index + 1), 1]))
  assert.throws(() => topics.readTopicPriorities(response(six), context), error => !(error instanceof topics.TopicPriorityCoverageError) && /不得超过/.test(error.message))
  const raw = topics.createTopicContext(snapshot, candidates)
  assert.equal(Object.keys(topics.readTopicPriorities(response({ ...six, c7: 2 }), raw)).length, 7)
  for (const retained of [4, 5]) {
    let missing
    try { topics.readTopicPriorities(response(Object.fromEntries(Object.entries(six).slice(0, retained))), context) } catch (error) { missing = error }
    const repair = topics.createTopicPriorityRepair(missing, context), payload = JSON.parse(repair.input)
    assert(repair.system.endsWith(topics.getTopicComparisonInstructions()))
    assert.equal(payload.displayLimit, 5 - retained)
    const valid = Object.fromEntries(payload.candidates.map((candidate, index) => [candidate.ref, index < 5 - retained ? 1 : 0]))
    const merged = repair.validate(response(valid))
    assert.equal(Object.values(merged).filter(value => value > 0).length, 5)
    assert.equal(Object.keys(merged).length, 7)
    assert.throws(() => repair.validate(response(Object.fromEntries(payload.candidates.map(candidate => [candidate.ref, 1])))), /不得超过/)
  }
}

// 非法优先于遗漏；定向恢复只提供缺失候选，不能改首轮已经完成的档位。
function checkPriorities() {
  const { snapshot, context, candidates } = topicFixture()
  let missing
  try { topics.readTopicPriorities('{"priorities":{"c1":1,"c2":0},"completed":true}', context) } catch (error) { missing = error }
  assert.ok(missing instanceof topics.TopicPriorityCoverageError)
  const repair = topics.createTopicPriorityRepair(missing, context), payload = JSON.parse(repair.input)
  assert.deepEqual(payload.candidates.map(candidate => candidate.ref), ['c3'])
  assert.deepEqual(payload.requiredCandidateRefs, ['c3']); assert.equal(payload.candidateCount, 1)
  assert.deepEqual(payload.sources.map(source => source.ref), ['r4'])
  assert.throws(() => repair.validate('{"priorities":{"c1":3,"c3":2},"completed":true}'), /REF_UNKNOWN/)
  const restored = repair.validate('{"priorities":{"c3":2},"completed":true}')
  assert.deepEqual(restored, { c1: 1, c2: 0, c3: 2 })
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), restored)
  assert.deepEqual(topics.selectTopicCandidates(snapshot, context, restored, 5).selected, [candidates[2], candidates[0]])
  for (const value of ['1', 0.5, 4, -1, null]) {
    assert.throws(() => topics.readTopicPriorities(JSON.stringify({ priorities: { c1: value }, completed: true }), context), error => !(error instanceof topics.TopicPriorityCoverageError))
  }
  assert.throws(() => topics.readTopicPriorities('{"priorities":{"c1":1,"c1":2},"completed":true}', context), /FIELD_DUPLICATE/)
  const zero = topics.readTopicPriorities('{"priorities":{"c1":0,"c2":0,"c3":0},"completed":true}', context)
  assert.deepEqual(topics.selectTopicCandidates(snapshot, context, zero, 10), { selected: [], omitted: [] })
  assert.deepEqual(topics.selectTopicCandidates(snapshot, context, { c1: 2, c2: 2, c3: 2 }, 5).selected, candidates)
  // 复现真实失败的多项缺漏；补漏清单必须全部列出，不能沿用示例中的单个c。
  const many = topics.createTopicContext(snapshot, Array.from({ length: 40 }, (_, index) => ({ id: 'many-' + index, fragments: [snapshot.fragments[index % 4]] })))
  let manyMissing
  try { topics.readTopicPriorities('{"priorities":{"c1":0,"c2":2},"completed":true}', many) } catch (error) { manyMissing = error }
  const manyRepair = topics.createTopicPriorityRepair(manyMissing, many), manyPayload = JSON.parse(manyRepair.input)
  assert.equal(manyPayload.candidateCount, 38)
  assert.deepEqual(manyPayload.requiredCandidateRefs, Array.from({ length: 38 }, (_, index) => 'c' + (index + 3)))
  assert.throws(() => manyRepair.validate('{"priorities":{"c3":0},"completed":true}'), error => error instanceof topics.TopicPriorityCoverageError && error.missing.length === 37)
  const complete = manyRepair.validate(JSON.stringify({ priorities: Object.fromEntries(manyPayload.requiredCandidateRefs.map(ref => [ref, 0])), completed: true }))
  assert.equal(Object.keys(complete).length, 40); assert.equal(complete.c2, 2); assert.equal(complete.c40, 0)
}

// 简短概述不凑原话或详尽关系，文字依据与已提交全文保持独立。
function checkOverview() {
  const { snapshot, context } = topicFixture()
  const result = topics.readTopicOverview('{"title":"安装与设置","summary":"讨论安装方案和设置。","refs":["r1"],"completed":true}', context)
  assert.equal(result.summary, '讨论安装方案和设置。')
  assert.deepEqual(result.evidence, [snapshot.fragments[0]])
  assert.deepEqual(result.submitted, snapshot.fragments)
  for (const refs of [[], ['r1', 'r1'], ['r99']]) {
    assert.throws(() => topics.readTopicOverview(JSON.stringify({ title: '标题', summary: '简短概述', refs, completed: true }), context))
  }
  assert.throws(() => topics.readTopicOverview('{"title":"标题","summary":"概述","refs":["r1"],"completed":false}', context))
  assert.throws(() => topics.readTopicOverview(JSON.stringify({ title: '😀'.repeat(61), summary: '概述', refs: ['r1'], completed: true }), context))
  for (const summary of ['参与者包括p1、p2、p3，p3在本期发言。', 'p1今日发言集中在游戏内容。', '根据r1得出这一概述。']) {
    assert.throws(() => topics.readTopicOverview(JSON.stringify({ title: '实际对象', summary, refs: ['r1'], completed: true }), context), /LOCAL_REF_IN_TEXT/)
  }
  assert(!topics.getTopicInstructions('overview').includes('"title":"讨论对象与范围"'))
  const merged = topics.createTopicOverviewMergeContext([result])
  const summary = topics.readTopicOverview('{"title":"安装讨论","summary":"简短总结。","refs":["r1"],"completed":true}', merged, result.submitted)
  assert.deepEqual(summary.evidence, result.evidence); assert.deepEqual(summary.submitted, snapshot.fragments)
  assert.throws(() => topics.createTopicContext(snapshot, [{ id: 'bad', fragments: [{ ...snapshot.fragments[0] }] }]), /当前快照/)
}

// 新卡片来源必须逐字且属于自身，合法缺失只补原候选，不修改首轮证据。
function checkTopicCards() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const material = JSON.parse(context.input)
  assert.equal(material.supply, 'candidate-inline-1'); assert.equal(Object.hasOwn(material, 'sources'), false)
  for (const [index, candidate] of material.candidates.entries()) {
    assert.deepEqual(candidate.sources.map(source => source.ref), candidate.refs)
    assert.equal(candidate.sources.map(source => source.text).join(''), candidates[index].fragments.map(fragment => fragment.text).join(''))
  }
  const card = (ref, text) => ({ status: 'ok', scope: '实际问题', summary: '讨论具体方案', evidence: [{ ref, text }] })
  const values = { c1: card('r1', '安装'), c2: card('r3', '出行'), c3: { status: 'insufficient', scope: '', summary: '', evidence: [] } }
  const response = cards => JSON.stringify({ cards })
  const first = topics.readTopicCards(response(values), context)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, completed: true }), context), /FIELD_TYPE/);
  assert.equal(first.length, 3); assert.equal(first[0].evidence[0].fragment, snapshot.fragments[0])
  let error
  try { topics.readTopicCards(response({ c1: values.c1 }), context) } catch (failure) { error = failure }
  assert(error instanceof topics.TopicCardCoverageError)
  const repair = topics.createTopicCardRepair(error, context), payload = JSON.parse(repair.input)
  assert.deepEqual(payload.requiredCandidateRefs, ['c2', 'c3'])
  assert.deepEqual(payload.candidates.flatMap(candidate => candidate.sources.map(source => source.ref)), ['r3', 'r4'])
  assert.deepEqual(repair.validate(response({ c2: values.c2, c3: values.c3 })), first)
  assert.throws(() => repair.validate(response(values)), /REF_UNKNOWN/)
  for (const bad of [card('r3', '出行'), card('r1', '编造文字'), { ...values.c1, scope: 'p1发言' }, { ...values.c3, summary: '不应有文字' }]) {
    assert.throws(() => topics.readTopicCards(response({ c1: bad }), context), failure => !(failure instanceof topics.TopicCardCoverageError))
  }
  assert.throws(() => topics.readTopicCards(response({ c1: card('r1', '未出现的私有原句') }), context), failure => {
    assert(failure.message.includes('材料卡c1的证据r1正文不含该摘录'))
    assert(!failure.message.includes('未出现的私有原句'))
    return true
  })
  assert.throws(() => topics.readTopicCards(response({ c1: card('r3', '出行') }), context), /材料卡c1的证据r3不属于该候选/)
  assert.throws(() => topics.readTopicCards(response({ c1: card('r1', '') }), context), /材料卡c1的证据r1需1至64字/)
  assert.throws(() => topics.readTopicCards('{"cards":{},"cards":{}}', context), /FIELD_DUPLICATE/)
}

// 目录合并不丢叶候选，统计按真实来源去重，未知、重复及代表错绑均拒绝。
function checkTopicDirectory() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const cards = topics.readTopicCards(JSON.stringify({ cards: Object.fromEntries([...context.candidates].map(([ref, candidate]) => {
    const sourceRef = [...context.sources].find(([, fragments]) => candidate.fragments.includes(fragments[0]))[0]
    return [ref, { status: 'ok', scope: '具体方案', summary: '讨论方案细节', evidence: [{ ref: sourceRef, text: context.sources.get(sourceRef)[0].text }] }]
  })) }), context)
  const directory = topics.createTopicCatalogContext(snapshot, cards)
  const group = { refs: ['c1', 'c3'], scope: '安装方案', summary: '安装与配置问题', representatives: ['c3'] }
  const read = groups => topics.readTopicDirectory(JSON.stringify({ groups, completed: true }), directory, cards)
  const merged = read([group])
  assert.equal(merged.length, 2); assert.equal(merged[0].candidate.fragments.length, 3)
  assert.equal(merged[0].evidence[0], cards[2].evidence[0])
  assert.deepEqual(merged.flatMap(card => card.leaves).sort(), cards.flatMap(card => card.leaves).sort())
  assert.deepEqual(read([]), cards)
  for (const bad of [{ ...group, refs: ['c1', 'c1'] }, { ...group, representatives: ['c2'] }, { ...group, representatives: ['c3','c3'] },
    { ...group, refs: ['c1', 'c99'] }, { ...group, scope: '按c1讨论' }]) assert.throws(() => read([bad]))
  const selection = topics.createTopicCatalogContext(snapshot, merged, 5), material = JSON.parse(selection.input)
  assert.equal(material.candidates[0].sourceCount, 3); assert.equal(material.candidates[0].memberCount, 2)
  assert.deepEqual(topics.readTopicCatalogSelection('{"selected":["c1"],"completed":true}', selection, 5), [merged[0].candidate])
  for (const selected of [[], ['c1','c1'], ['c99']]) assert.throws(() => topics.readTopicCatalogSelection(JSON.stringify({ selected, completed: true }), selection, 5))
}

// 注册到插件正式入口，不通过独立执行空导出冒充测试通过。
function runReportTopicTests(check) {
  for (const [label, run] of [['中性直接归组保留未合并及非法优先', checkGrouping], ['四档选题缺漏定向恢复、合法空结果及稳定排序', checkPriorities],
    ['归并候选就近提供完整原文、真实作者、多归属与长文尾部', checkInlineGroupingMaterial],
    ['全局比较拒绝超额提名且合法补漏仅使用剩余名额', checkComparisonNominationLimit],
    ['中性概述区分完整供料与文字依据、分段合成绑定原文', checkOverview],
    ['全文材料卡原文所有权、合法缺漏及非法优先', checkTopicCards], ['无淘汰目录保留叶候选、统计及最终选题严格校验', checkTopicDirectory]]) {
    try { run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportTopicTests }
