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

// 作者不暴露给概述模型，真实本人/原文/回复绑定保持相同，真实原文中的型号不被误当内部代号。
function checkOverviewAuthorProjection() {
  const snapshot = evidence.createReportEvidence([
    { messageId: 'projection-a', realMessageId: true, userId: 'member-a', user: '甲', ts: 1, content: '讨论p1接口的设置' },
    { messageId: 'projection-b', realMessageId: true, userId: 'member-b', user: '乙', ts: 2, content: '完整原文  保留空白' },
  ])
  const candidates = [{ id: 'scope-a', fragments: snapshot.fragments, scopeHints: ['接口设置'] }]
  const raw = topics.createTopicContext(snapshot, candidates), projected = topics.createTopicOverviewContext(snapshot, candidates)
  const before = JSON.parse(raw.input), after = JSON.parse(projected.input)
  assert.equal(after.kind, 'neutral-topic-overview-4'); assert.equal(after.members, undefined)
  const omitAuthor = source => { const { author, ...value } = source; return value }
  assert.deepEqual(after.sources, before.sources.map(omitAuthor)); assert.deepEqual(after.context, before.context.map(omitAuthor))
  assert.deepEqual(after.candidates, before.candidates.map(candidate => { const { scopeHints, ...group } = candidate; return group }))
  assert(after.candidates.every(candidate => !Object.hasOwn(candidate, 'scopeHints')))
  assert.deepEqual([...projected.sources], [...raw.sources])
  const { bindTopicStageRequest, verifyReportStageOrigin } = require('../lib/report-stage-bindings')
  const originalBindings = bindTopicStageRequest(snapshot, raw, snapshot.fragments)
  const projectedBindings = bindTopicStageRequest(snapshot, projected, snapshot.fragments)
  assert(originalBindings); assert.deepEqual(projectedBindings, originalBindings); verifyReportStageOrigin(snapshot, projectedBindings)
  assert.equal(projectedBindings.members.length, 2)
  const answer = summary => JSON.stringify({ title: '接口设置', summary, refs: ['r1'], completed: true })
  assert.equal(topics.readTopicOverview(answer('讨论p1接口的设置。'), projected).summary, '讨论p1接口的设置。')
  assert.throws(() => topics.readTopicOverview(answer('根据r1讨论设置。'), projected), /LOCAL_REF_IN_TEXT/)
}

// 卡片供料删除生成名称，核心、辅助、作者及永久绑定不变；恢复也不重新引入名称。
function checkTopicCardInputProjection() {
  const snapshot = evidence.createReportEvidence([
    { messageId: 'a1', realMessageId: true, userId: 'a', content: '讨论具体机制但没有确认主体' },
    { messageId: 'b1', realMessageId: true, userId: 'b', content: '用于理解语境的邻居' },
    { messageId: 'a2', realMessageId: true, userId: 'a', content: '共同比较的原文', replyToId: 'a1' },
    { messageId: 'c1', realMessageId: true, userId: 'c', content: '另一个明确问题' },
  ])
  const candidates = [{ id: 'first', kind: 'event', fragments: [snapshot.fragments[0], snapshot.fragments[2]], scopeHints: ['未经证实的错误主语'] },
    { id: 'second', kind: 'event', fragments: [snapshot.fragments[2], snapshot.fragments[3]], scopeHints: ['另一个待核实范围'] }]
  const original = topics.createTopicContext(snapshot, candidates, 'cards'), context = topics.createTopicCardContext(snapshot, candidates)
  const before = JSON.parse(original.input), after = JSON.parse(context.input)
  assert.equal(after.supply, 'candidate-inline-local-4')
  assert(!context.input.includes('未经证实的错误主语')); assert(!context.input.includes('scopeHints'))
  assert.deepEqual(after.candidates, before.candidates.map(({ scopeHints, ...candidate }) => candidate))
  assert.deepEqual(after.context, before.context); assert.deepEqual(after.members, before.members)
  assert.deepEqual(context.cacheMaterial, original.cacheMaterial); assert.deepEqual([...context.sources], [...original.sources])
  assert.equal(context.candidates.get('c1'), candidates[0]); assert.deepEqual(candidates[0].scopeHints, ['未经证实的错误主语'])
  const { bindTopicStageRequest } = require('../lib/report-stage-bindings')
  const fragments = [...context.sources.values()].flat()
  assert.deepEqual(bindTopicStageRequest(snapshot, context, fragments), bindTopicStageRequest(snapshot, original, fragments))
  const first = { refs: ['r1', 'r2'], status: 'ok', scope: '具体机制的比较', evidence: ['r1'] }
  let missing
  try { topics.readTopicCards(JSON.stringify({ cards: { c1: [first] } }), context) } catch (error) { missing = error }
  assert(missing instanceof topics.TopicCardCoverageError)
  const repair = topics.createTopicCardRepair(missing, context), material = JSON.parse(repair.input)
  assert.deepEqual(material.requiredCandidateRefs, ['c2']); assert(!repair.input.includes('scopeHints'))
  assert.deepEqual(material.candidates[0].sources, after.candidates[1].sources)
  assert.deepEqual(material.candidates[0].contextRefs, after.candidates[1].contextRefs)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { c1: [{ ...first,
    evidence: ['r3'] }] } }), context), /不属于该候选/)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { c1: [{ ...first,
    evidence: [after.candidates[0].contextRefs[0]] }] } }), context), /REF_UNKNOWN/)
}

// ---------------- 容器与父候选恢复 ---------------- //

// 真实父错层和来源唯一的别名带告警恢复，重名及未知非空内容不能丢弃。
function checkCardContainerTolerance() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const values = Object.fromEntries([...context.candidates].map(([ref, candidate]) => {
    const refs = [...context.sources].filter(([, fragments]) => candidate.fragments.includes(fragments[0])).map(([key]) => key)
    return [ref, [{ refs, status: 'ok', scope: '实际讨论', evidence: [refs[0]] }]]
  }))
  const plain = topics.readTopicCards(JSON.stringify({ cards: values }), context)
  const marked = topics.readTopicCards(JSON.stringify({ cards: values, root: 'cards' }), context)
  assert.deepEqual(marked[0].formatWarnings, [{ code: 'ignored_root_marker', marker: 'cards' }])
  assert.deepEqual(marked.map(card => card.candidate), plain.map(card => card.candidate))
  for (const root of ['other', '', true, null, {}, []]) {
    assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, root }), context), /FIELD_TYPE/)
  }
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { ...values, c1: [{ ...values.c1[0], evidence: ['r3'] }] }, root: 'cards' }), context), /不属于该候选/)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, root: 'cards' }).replace('"root":"cards"', '"root":"cards","root":"cards"'), context), /FIELD_DUPLICATE/)
  const extra = topics.readTopicCards(JSON.stringify({ cards: { ...values, c13: [] } }), context)
  assert.deepEqual(extra[0].formatWarnings, [{ code: 'ignored_empty_unknown_parent', parentRef: 'c13' }])
  assert.deepEqual(extra.map(card => card.candidate), plain.map(card => card.candidate))
  const moved = topics.readTopicCards(JSON.stringify({ cards: { c1: values.c1 }, c2: values.c2, c3: values.c3 }), context)
  assert.deepEqual(moved.map(card => card.candidate), plain.map(card => card.candidate))
  assert.deepEqual(moved.slice(1).map(card => card.formatWarnings), [[{ code: 'misplaced_parent_container', parentRef: 'c2' }],
    [{ code: 'misplaced_parent_container', parentRef: 'c3' }]])
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, c2: values.c2 }), context), /FIELD_DUPLICATE/)
  const aliased = topics.readTopicCards(JSON.stringify({ cards: { ...values, c13: values.c1 } }), context)
  assert.deepEqual(aliased.map(card => card.parentId), [candidates[0].id, ...candidates.map(candidate => candidate.id)])
  assert.deepEqual(aliased[0].formatWarnings, [{ code: 'restored_parent_alias', parentRef: 'c1', aliasRef: 'c13' }])
  assert.deepEqual(aliased[1].candidate.fragments, candidates[0].fragments)
  for (const value of [[{ refs: [], status: 'insufficient', scope: '', evidence: [] }], {}, null]) {
    assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { ...values, c13: value } }), context), /REF_UNKNOWN/)
  }
  for (const value of [{ cards: { ...values, c0: [] } }, { cards: values, c13: [] }, { c1: values.c1, c2: values.c2, c3: values.c3 },
    { cards: { c1: values.c1 }, c2: '不明形状', c3: values.c3 }]) assert.throws(() => topics.readTopicCards(JSON.stringify(value), context))
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { c1: values.c1 }, c2: [{ ...values.c2[0], evidence: ['r1'] }], c3: values.c3 }), context), /不属于该候选/)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { c13: [] } }), context), error => error instanceof topics.TopicCardCoverageError && error.missing.length === 3)
  assert.throws(() => topics.readTopicCards('{"cards":{},"c1":[],"c1":[]}', context), /FIELD_DUPLICATE/)
}

// 真实故障中的标点空根字段只允许精确空数组，非空内容及重复键不能静默舍弃。
function checkEmptyCardRootFields() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const values = { c1: [{ refs: ['r1', 'r2'], status: 'ok', scope: '安装讨论', evidence: ['r1'] }],
    c2: [{ refs: ['r3'], status: 'ok', scope: '出行讨论', evidence: ['r3'] }],
    c3: [{ refs: ['r4'], status: 'insufficient', scope: '', evidence: [] }] }
  const plain = topics.readTopicCards(JSON.stringify({ cards: values }), context)
  for (const field of [':,', ':,,']) {
    const result = topics.readTopicCards(JSON.stringify({ cards: values, [field]: [] }), context)
    assert.deepEqual(result[0].formatWarnings, [{ code: 'ignored_empty_root_field', field }])
    assert.deepEqual(result.map(card => card.candidate), plain.map(card => card.candidate))
    for (const value of [null, {}, '', 0, false, [values.c1[0]], ['未识别的非空内容']]) {
      assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, [field]: value }), context), /FIELD_TYPE/)
    }
  }
  const moved = topics.readTopicCards(JSON.stringify({ cards: { c1: values.c1 }, c2: values.c2, c3: values.c3, ':,': [], ':,,': [] }), context)
  assert.deepEqual(moved[0].formatWarnings, [{ code: 'ignored_empty_root_field', field: ':,' }, { code: 'ignored_empty_root_field', field: ':,,' }])
  assert.deepEqual(moved.slice(1).map(card => card.formatWarnings), [[{ code: 'misplaced_parent_container', parentRef: 'c2' }],
    [{ code: 'misplaced_parent_container', parentRef: 'c3' }]])
  assert.deepEqual(moved.map(card => card.candidate), plain.map(card => card.candidate))
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, unknown: [] }), context), /FIELD_TYPE/)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: values, ':,': [] }).replace('":,":[]', '":,":[],":,":[]'), context), /FIELD_DUPLICATE/)
}

// 别名父只依据每张子卡的唯一来源归属追加，编号文本不赋予身份且所有子卡须归于同一父。
function checkCardParentAliasRestoration() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const child = refs => ({ refs, status: 'ok', scope: '具体问题', evidence: [refs[0]] })
  const values = { c1: [child(['r1'])], c2: [child(['r3'])], c3: [child(['r4'])] }
  const read = (cards, current = context) => topics.readTopicCards(JSON.stringify({ cards }), current)
  for (const aliasRef of ['c6b', 'c13', 'c9_shared', 'c2b']) {
    const result = read({ ...values, [aliasRef]: [child(['r2'])] })
    assert.deepEqual(result.map(card => card.parentId), [candidates[0].id, ...candidates.map(candidate => candidate.id)])
    assert.deepEqual(result.map(card => card.candidate.fragments), snapshot.fragments.map(fragment => [fragment]))
    assert.deepEqual(result[0].formatWarnings, [{ code: 'restored_parent_alias', parentRef: 'c1', aliasRef }])
    assert.equal(result[1].formatWarnings, undefined)
  }
  const full = { ...values, c1: [child(['r1', 'r2'])] }
  const emptyAliases = ['c6b', 'c13', 'c9_shared'], empty = read({ ...full, ...Object.fromEntries(emptyAliases.map(ref => [ref, []])) })
  assert.deepEqual(empty[0].formatWarnings, emptyAliases.map(parentRef => ({ code: 'ignored_empty_unknown_parent', parentRef })))
  assert.deepEqual(empty.map(card => card.candidate.fragments), candidates.map(candidate => candidate.fragments))
  const multiple = read({ ...values, c13: [child(['r1']), child(['r2'])] })
  assert.equal(multiple.length, 5); assert(multiple.slice(0, 3).every(card => card.parentId === candidates[0].id))
  assert.deepEqual(multiple[0].formatWarnings, [{ code: 'restored_parent_alias', parentRef: 'c1', aliasRef: 'c13' }])
  for (const aliasRef of ['c0', 'c01', 'c1000000', 'c1bb', 'c1_Shared', 'unrecognized']) {
    assert.throws(() => read({ ...full, [aliasRef]: [] }), /REF_UNKNOWN/)
    assert.throws(() => read({ ...values, [aliasRef]: [child(['r2'])] }), /REF_UNKNOWN/)
  }
  // 每项都必须保留原来的字段、引用、证据和容量校验，不能借别名恢复跳过。
  for (const alias of [[child(['r1']), child(['r3'])], [child(['r1', 'r3'])], [child(['r999'])],
    [child(['r2', 'r2'])], [{ refs: [], status: 'insufficient', scope: '', evidence: [] }]]) {
    assert.throws(() => read({ ...values, c13: alias }), error => !(error instanceof topics.TopicCardCoverageError))
  }
  assert.throws(() => read({ ...values, c13: [{ ...child(['r2']), summary: '未经约定的字段' }] }), /FIELD_TYPE/)
  assert.throws(() => read({ ...values, c13: [{ ...child(['r2']), evidence: ['r3'] }] }), /不属于该候选/)
  assert.throws(() => read({ ...values, c13: [child(['r2'])] }, { ...context, cardLimit: 3 }), /容量/)
  for (const c1 of [undefined, [], {}]) {
    const cards = { ...values, c13: [child(['r1', 'r2'])] }
    if (c1 === undefined) delete cards.c1
    else cards.c1 = c1
    assert.throws(() => read(cards), error => !(error instanceof topics.TopicCardCoverageError))
  }
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: full, c13: [child(['r2'])] }), context), /FIELD_TYPE/)
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { ...values, c13: [child(['r2'])] } })
    .replace('"c13":', '"c13":[],"c13":'), context), /FIELD_DUPLICATE/)
}

// 共享原文不能单独证明归属；逐卡消歧不能被其他子卡或整个别名并集掩盖。
function checkCardParentAliasAmbiguity() {
  const snapshot = evidence.createReportEvidence([{ userId: 'a', content: '两个范围共用的原文' },
    { userId: 'b', content: '第一个范围独有的原文' }, { userId: 'c', content: '第二个范围独有的原文' }])
  const candidates = [{ id: 'first', fragments: snapshot.fragments.slice(0, 2) },
    { id: 'second', fragments: [snapshot.fragments[0], snapshot.fragments[2]] }]
  const context = topics.createTopicCardContext(snapshot, candidates)
  const child = refs => ({ refs, status: 'ok', scope: '具体讨论', evidence: [refs[0]] })
  const values = { c1: [child(['r1', 'r2'])], c2: [child(['r1', 'r3'])] }
  const read = alias => topics.readTopicCards(JSON.stringify({ cards: { ...values, c1b: alias } }), context)
  for (const alias of [[child(['r1'])], [child(['r1']), child(['r2'])], [child(['r2']), child(['r3'])]]) {
    assert.throws(() => read(alias), /REF_UNKNOWN/)
  }
  const unique = read([child(['r1', 'r2'])])
  assert.deepEqual(unique.map(card => card.parentId), ['first', 'first', 'second'])
  assert.deepEqual(unique[0].formatWarnings, [{ code: 'restored_parent_alias', parentRef: 'c1', aliasRef: 'c1b' }])
}

// ---------------- 来源、证据与覆盖校验 ---------------- //

// 新卡片来源必须逐字且属于自身，合法缺失只补原候选，不修改首轮证据。
function checkTopicCards() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const material = JSON.parse(context.input)
  assert.equal(material.supply, 'candidate-inline-local-4'); assert.equal(Object.hasOwn(material, 'sources'), false)
  for (const [index, candidate] of material.candidates.entries()) {
    assert.deepEqual(candidate.sources.map(source => source.ref), candidate.refs)
    assert.equal(candidate.sources.map(source => source.text).join(''), candidates[index].fragments.map(fragment => fragment.text).join(''))
  }
  const card = (ref, refs = ['r1', 'r2']) => ({ refs, status: 'ok', scope: '实际问题', evidence: [ref] })
  const values = { c1: [card('r1')], c2: [card('r3', ['r3'])], c3: [{ refs: ['r4'], status: 'insufficient', scope: '', evidence: [] }] }
  const response = cards => JSON.stringify({ cards })
  const first = topics.readTopicCards(response(values), context)
  assert.equal(material.kind, 'topic-cards-9'); assert(first.every(value => !Object.hasOwn(value, 'summary')))
  assert.throws(() => topics.readTopicCards(response({ ...values, c1: [{ ...values.c1[0], summary: '旧自由说明' }] }), context), /FIELD_TYPE/)
  assert.throws(() => topics.readTopicCards(response({ ...values, c1: values.c1[0] }), context), /子卡数组/)
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
  for (const bad of [card('r3'), { ...card('r1'), evidence: [{ ref: 'r1', text: '编造文字' }] }, { ...values.c1[0], scope: 'p1发言' }, { ...values.c3[0], summary: '不应有文字' }]) {
    assert.throws(() => topics.readTopicCards(response({ c1: [bad] }), context), failure => !(failure instanceof topics.TopicCardCoverageError))
  }
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...card('r1'), evidence: [{ ref: 'r1', text: '未出现的私有原句' }] }] }), context), failure => {
    assert(failure.message.includes('QUOTE_UNSUPPORTED'))
    assert(!failure.message.includes('未出现的私有原句'))
    return true
  })
  assert.throws(() => topics.readTopicCards(response({ c1: [card('r3')] }), context), /材料卡c1的证据r3不属于该候选/)
  const known = topics.readTopicCards(response({ ...values, c1: [{ ...card('r1'), evidence: [{ ref: 'r1', text: snapshot.fragments[0].text }] }] }), context)
  assert.deepEqual(known[0].formatWarnings, [{ code: 'legacy_evidence_object', parentRef: 'c1', childIndex: 1 }])
  assert.throws(() => topics.readTopicCards('{"cards":{},"cards":{}}', context), /FIELD_DUPLICATE/)
}

// 引用恢复有界摘录；已知真实对象及数量偏差带告警，越权和改写仍拒绝。
function checkMultipleCardEvidence() {
  const snapshot = evidence.createReportEvidence([{ userId: 'a', content: '😀'.repeat(64) },
    { userId: 'b', content: '乙'.repeat(65) }, { userId: 'c', content: '丙'.repeat(127) }, { userId: 'd', content: '独立来源' }])
  const context = topics.createTopicCardContext(snapshot, [{ id: 'multi', fragments: snapshot.fragments.slice(0, 3) },
    { id: 'other', fragments: snapshot.fragments.slice(3) }])
  const entries = ['r1', 'r2']
  const card = value => ({ refs: ['r1', 'r2', 'r3'], status: 'ok', scope: '实际多条依据', evidence: value })
  const other = { refs: ['r4'], status: 'ok', scope: '独立问题', evidence: ['r4'] }
  const response = value => JSON.stringify({ cards: { c1: [card(value)], c2: [other] } })
  const boundary = topics.readTopicCards(response(entries), context)
  assert.equal(boundary[0].evidence.length, 2)
  assert.equal(boundary[0].evidence.reduce((sum, entry) => sum + Array.from(entry.text).length, 0), 64)
  assert.deepEqual(boundary[0].evidence.map(entry => entry.sourceCharacters), [64, 65])
  assert(boundary[0].evidence.every(entry => entry.excerptOnly === true && entry.truncated === true))
  const three = ['r1', 'r2', 'r3']
  const all = topics.readTopicCards(response(three), context)
  assert.deepEqual(all[0].evidence.map(entry => Array.from(entry.text).length), [21, 21, 21])
  assert(all[0].evidence.every((entry, index) => entry.fragment === snapshot.fragments[index]))
  assert(all[0].evidence.every(entry => entry.fragment.text.startsWith(entry.text) && entry.excerptOnly && entry.truncated))
  const exact = topics.readTopicCards(response(['r1']), context)[0].evidence[0]
  assert.equal(exact.text, snapshot.fragments[0].text); assert.equal(exact.truncated, false)
  for (const [ref, count] of [['r2', 65], ['r3', 127]]) {
    const excerpt = topics.readTopicCards(response([ref]), context)[0].evidence[0]
    assert.equal(Array.from(excerpt.text).length, 64); assert.equal(excerpt.sourceCharacters, count)
    assert(excerpt.truncated && excerpt.excerptOnly); assert(excerpt.fragment.text.startsWith(excerpt.text))
  }
  assert.throws(() => topics.readTopicCards(response([]), context), /非空/)
  const repeated = topics.readTopicCards(response([...three, three[0]]), context)[0]
  assert.deepEqual(repeated.evidence, all[0].evidence)
  assert.deepEqual(repeated.formatWarnings, [{ code: 'evidence_count_normalized', parentRef: 'c1', childIndex: 1, providedCount: 4, retainedCount: 3 }])
  const duplicate = topics.readTopicCards(response([three[0], three[0]]), context)[0]
  assert.equal(duplicate.evidence.length, 1); assert.equal(duplicate.formatWarnings[0].providedCount, 2)
  const legacy = topics.readTopicCards(response([{ ref: 'r3', text: snapshot.fragments[2].text }]), context)[0]
  assert.equal(legacy.evidence[0].sourceCharacters, 127); assert(legacy.evidence[0].truncated)
  assert.equal(legacy.formatWarnings[0].code, 'legacy_evidence_object')
  for (const invalid of ['r4', 'r999', { ref: 'r3', text: '不在原文' }, { ref: 'r3', text: '丙', summary: '未知字段' }]) {
    assert.throws(() => topics.readTopicCards(response([three[0], three[1], invalid]), context), error => !(error instanceof topics.TopicCardCoverageError))
  }
  let failure
  try { topics.readTopicCards(JSON.stringify({ cards: { c1: [card(three)] } }), context) } catch (error) { failure = error }
  assert(failure instanceof topics.TopicCardCoverageError)
  const repair = topics.createTopicCardRepair(failure, context)
  assert.deepEqual(repair.validate(JSON.stringify({ cards: { c2: [other] } })), all)
  assert.equal(failure.cards[0].evidence.length, 3)
  const directory = topics.createTopicCatalogContext(snapshot, all)
  assert.deepEqual(JSON.parse(directory.input).candidates[0].evidence, all[0].evidence.map(({ text, excerptOnly, truncated, sourceCharacters }) => ({ text, excerptOnly, truncated, sourceCharacters })))
  const blank = evidence.createReportEvidence([{ userId: 'blank', content: ' \n ' }])
  const blankContext = topics.createTopicCardContext(blank, [{ id: 'blank', fragments: blank.fragments }])
  assert.throws(() => topics.readTopicCards(JSON.stringify({ cards: { c1: [{ refs: ['r1'], status: 'ok', scope: '错误有内容', evidence: ['r1'] }] } }), blankContext), /QUOTE_UNSUPPORTED/)
}

// 仅删除精确空的不足卡；原索引可审计、核心覆盖及父级原子恢复均不放宽。
function checkEmptyInsufficientCards() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const empty = { refs: [], status: 'insufficient', scope: '', evidence: [] }
  const first = { refs: ['r1', 'r2'], status: 'ok', scope: '安装讨论', evidence: ['r1'] }
  const second = { refs: ['r3'], status: 'ok', scope: '出行讨论', evidence: ['r3'] }
  const third = { refs: ['r4'], status: 'insufficient', scope: '', evidence: [] }
  const response = c1 => JSON.stringify({ cards: { c1, c2: [second], c3: [third] } })
  for (const position of [0, 1, 2]) {
    const values = [empty, empty]; values.splice(position, 0, first)
    const cards = topics.readTopicCards(response(values), { ...context, cardLimit: 3 })
    assert.equal(cards.length, 3); assert.equal(cards[0].candidate.id, candidates[0].id)
    assert.deepEqual(cards[0].candidate.fragments, candidates[0].fragments)
    assert.deepEqual(cards[0].formatWarnings, values.flatMap((value, index) => value === empty
      ? [{ code: 'ignored_empty_insufficient_child', parentRef: 'c1', childIndex: index + 1 }] : []))
  }
  const many = topics.readTopicCards(response([...Array(24).fill(empty), first]), { ...context, cardLimit: 3 })
  assert.equal(many.length, 3); assert.equal(many[0].formatWarnings.length, 24)
  for (const value of [empty, { ...first, refs: ['r1'] }]) {
    let failure
    try { topics.readTopicCards(response([value, empty]), context) } catch (error) { failure = error }
    assert(failure instanceof topics.TopicCardCoverageError); assert.deepEqual(failure.missing, ['c1'])
    assert.equal(failure.cards.length, 2); assert(failure.cards.every(card => !card.formatWarnings))
    const repair = topics.createTopicCardRepair(failure, context)
    const repaired = repair.validate(JSON.stringify({ cards: { c1: [first, empty] } }))
    assert.equal(repaired.length, 3); assert.equal(new Set(repaired.flatMap(card => card.candidate.fragments)).size, 4)
    assert.equal(repaired[0].formatWarnings[0].childIndex, 2)
  }
  for (const invalid of [{ ...empty, scope: ' ' }, { ...empty, status: 'ok' }, { ...empty, evidence: ['r1'] },
    { ...empty, refs: null }, { ...empty, other: true }, { ...empty, status: 'unknown' }]) {
    assert.throws(() => topics.readTopicCards(response([first, invalid]), context), error => !(error instanceof topics.TopicCardCoverageError))
  }
  const longSnapshot = evidence.createReportEvidence(Array.from({ length: 5 }, (_, index) => ({ userId: 'a', content: '真实原文' + index })))
  const longContext = topics.createTopicCardContext(longSnapshot, [{ id: 'all', fragments: longSnapshot.fragments }])
  const full = { refs: ['r1','r2','r3','r4'], status: 'ok', scope: '同一讨论', evidence: ['r1','r2','r3','r4'] }
  const read = value => topics.readTopicCards(JSON.stringify({ cards: { c1: [{ ...full, refs: [...full.refs, 'r5'], evidence: value }] } }), longContext)
  assert.equal(read(full.evidence)[0].evidence.length, 3)
  // 先核验第四条才做摘录选择，不能用前三条合法掩盖被省略项的虚假证据。
  assert.throws(() => read(['r1','r2','r3', { ref: 'r4', text: '编造文字' }]), /QUOTE_UNSUPPORTED/)
  assert.throws(() => read(['r1','r2','r3','r999']), /REF_UNKNOWN/)
}

// 子卡来源独立、并集完整、合法共享及补父恢复有界；非法子卡不能保留首轮。
function checkSplitTopicCards() {
  const snapshot = evidence.createReportEvidence([{ userId: 'a', content: '讨论减秒机制' }, { userId: 'b', content: '酒神的强度评价' },
    { userId: 'a', content: '双方的比较原文' }, { userId: 'c', content: '另一项问题' }])
  const candidates = [{ id: 'mixed', fragments: snapshot.fragments.slice(0, 3) }, { id: 'other', fragments: snapshot.fragments.slice(2) }]
  const context = topics.createTopicCardContext(snapshot, candidates)
  const segment = (refs, scope, ref) => ({ refs, status: 'ok', scope, evidence: [ref] })
  const first = segment(['r1', 'r3'], '减秒机制的讨论', 'r1')
  const second = segment(['r2', 'r3'], '酒神强度及比较', 'r2')
  const other = { refs: ['r3', 'r4'], status: 'insufficient', scope: '', evidence: [] }
  const response = cards => JSON.stringify({ cards })
  const cards = topics.readTopicCards(response({ c1: [first, second], c2: [other] }), context)
  assert.deepEqual(cards.map(card => card.candidate.id), ['mixed:segment:1', 'mixed:segment:2', 'other'])
  assert.deepEqual(cards.map(card => card.parentId), ['mixed', 'mixed', 'other'])
  assert.deepEqual(cards.map(card => card.candidate.fragments.map(fragment => fragment.id)), [['1:1','3:1'], ['2:1','3:1'], ['3:1','4:1']])
  assert.equal(new Set(cards.flatMap(card => card.candidate.fragments)).size, 4)
  // 同一临时父可有超过四个范围，整批仍共享24张容量且来源并集不能减少。
  const more = topics.readTopicCards(response({ c1: [first, second, first, second, first, second], c2: [other] }), context)
  assert.equal(more.length, 7); assert(more.slice(0, 6).every(card => card.parentId === 'mixed'))
  assert.equal(new Set(more.flatMap(card => card.candidate.fragments)).size, 4)
  assert.throws(() => topics.readTopicCards(response({ c1: Array.from({ length: 24 }, (_, index) => index % 2 ? second : first) }), context), /预留空间/)
  const overview = JSON.parse(topics.createTopicOverviewContext(snapshot, cards.slice(0, 2).map(card => card.candidate)).input)
  assert.deepEqual(overview.candidates.map(candidate => candidate.cardRange), [first.scope, second.scope])
  assert(overview.candidates.every(candidate => candidate.rangeIsProposal === true && !Object.hasOwn(candidate, 'scopeHints')))
  const original = JSON.parse(topics.createTopicOverviewContext(snapshot, [{ ...candidates[0], scopeHints: ['未核实分类名'] }]).input)
  assert(!Object.hasOwn(original.candidates[0], 'cardRange')); assert(!Object.hasOwn(original.candidates[0], 'scopeHints'))
  let missing
  try { topics.readTopicCards(response({ c1: [first, second] }), context) } catch (error) { missing = error }
  assert(missing instanceof topics.TopicCardCoverageError)
  const repair = topics.createTopicCardRepair(missing, context)
  assert.equal(JSON.parse(repair.input).maxCards, 22)
  assert.deepEqual(repair.validate(response({ c2: [other] })), cards)
  assert.throws(() => topics.readTopicCards(response({ c1: [first] }), context), error => error instanceof topics.TopicCardCoverageError && /并集未完整/.test(error.message))
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...first, refs: ['r1','r1'] }, second] }), context), /唯一/)
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...first, refs: ['r1','r4'] }, second] }), context), /不属于父候选/)
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...first, evidence: second.evidence }, second] }), context), /不属于该候选/)
  assert.throws(() => topics.readTopicCards(response({ c1: Array(25).fill(first) }), context), /请求容量/)
  const shortContext = { ...context, cardLimit: 2 }
  assert.throws(() => topics.readTopicCards(response({ c1: [first, second] }), shortContext), /预留空间/)
  assert.throws(() => topics.readTopicCards(response({ c1: [first, second], c2: [other] }), shortContext), /容量/)
  assert.throws(() => topics.readTopicCards(response({ c1: [first] }), context), error => {
    assert(error.message.includes('c1:r2')); assert(error.message.includes('原父cards.c数组'))
    assert(!error.message.includes('酒神的强度评价'))
    return /REF_UNCOVERED/.test(error.message)
  })
  const alias = topics.readTopicCards(response({ c1: [first], c1b: [second], c2: [other] }), context)
  assert.deepEqual(alias.map(card => card.candidate.fragments), cards.map(card => card.candidate.fragments))
  assert.deepEqual(alias[0].formatWarnings, [{ code: 'restored_parent_alias', parentRef: 'c1', aliasRef: 'c1b' }])
  assert.throws(() => topics.readTopicCards(response({ c1: [first], c1b: [segment(['r3'], '共享来源', 'r3')], c2: [other] }), context), /REF_UNKNOWN/)
  assert.throws(() => topics.readTopicCards(response({ c1: [first], c2: [{ ...other, summary: '非法额外字段' }] }), context), /FIELD_TYPE/)
}

// 小缺口单列真实来源而不补语义归属；阈值、缺父、非法来源及恢复额度明确有界。
function checkUnassignedCoreTolerance() {
  const snapshot = evidence.createReportEvidence(Array.from({ length: 60 }, (_, index) => ({ userId: 'member', content: index === 39 ? '？' : '原始讨论' + index })))
  const candidates = [{ id: 'first', fragments: snapshot.fragments.slice(0, 40) }, { id: 'second', fragments: snapshot.fragments.slice(40) }]
  const context = topics.createTopicCardContext(snapshot, candidates), payload = JSON.parse(context.input)
  const full = (index, omitted = 0) => ({ refs: payload.candidates[index].refs.slice(0, payload.candidates[index].refs.length - omitted),
    status: 'ok', scope: '实际讨论', evidence: [payload.candidates[index].refs[0]] })
  const response = cards => JSON.stringify({ cards })
  const cards = topics.readTopicCards(response({ c1: [full(0, 3)], c2: [full(1)] }), context)
  assert.equal(cards.length, 2); assert.equal(cards[0].candidate.fragments.length, 37)
  assert.deepEqual(cards[0].unassignedFragments, snapshot.fragments.slice(37, 40))
  assert.deepEqual(cards[0].formatWarnings, [{ code: 'unassigned_core_fragments', parentRef: 'c1', fragmentIds: ['38:1','39:1','40:1'] }])
  assert.equal(new Set(cards.flatMap(card => [...card.candidate.fragments, ...(card.unassignedFragments || [])])).size, 60)
  assert.deepEqual(JSON.parse(context.input), payload); assert.equal(payload.candidates.flatMap(candidate => candidate.sources).length, 60)
  assert.throws(() => topics.readTopicCards(response({ c1: [full(0, 4)], c2: [full(1)] }), context), /REF_UNCOVERED/)
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...full(0, 1), evidence: ['r40'] }], c2: [full(1)] }), context), /不属于该候选/)
  assert.throws(() => topics.readTopicCards(response({ c1: [full(0, 1)], c2: [{ ...full(1), summary: '未知' }] }), context), /FIELD_TYPE/)
  let missing
  try { topics.readTopicCards(response({ c1: [full(0)] }), context) } catch (error) { missing = error }
  assert(missing instanceof topics.TopicCardCoverageError)
  const repaired = topics.createTopicCardRepair(missing, context).validate(response({ c2: [full(1, 2)] }))
  assert.equal(repaired[0], missing.cards[0]); assert.deepEqual(repaired[1].unassignedFragments, snapshot.fragments.slice(-2))
  for (const count of [19, 20, 80]) {
    const boundary = count === 80 ? evidence.createReportEvidence(Array.from({ length: count }, (_, index) => ({ userId: 'member', content: '实际原文' + index }))) : snapshot
    const current = topics.createTopicCardContext(boundary, [{ id: 'boundary', fragments: boundary.fragments.slice(0, count) }])
    const refs = [...current.sources.keys()], omitted = count === 80 ? 4 : 1
    const raw = response({ c1: [{ refs: refs.slice(0, -omitted), status: 'ok', scope: '实际讨论', evidence: ['r1'] }] })
    if (count === 20) assert.equal(topics.readTopicCards(raw, current)[0].unassignedFragments.length, 1)
    else assert.throws(() => topics.readTopicCards(raw, current), /REF_UNCOVERED/)
  }
  const split = topics.createTopicCardContext(snapshot, [{ id: 'large', fragments: snapshot.fragments.slice(0, 58) }, { id: 'small', fragments: snapshot.fragments.slice(58) }])
  assert.throws(() => topics.readTopicCards(response({ c1: [{ ...full(0), refs: [...split.sources.keys()].slice(0, 58) }],
    c2: [{ refs: [], status: 'insufficient', scope: '', evidence: [] }] }), split), /REF_UNCOVERED/)
}

// 漏核心父超过容错额度时仍整父替换，完整父保持本人来源；非法字段不允许保留首轮。
function checkIncompleteParentRepair() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const card = (refs, scope, ref) => ({ refs, status: 'ok', scope, evidence: [ref] })
  const partial = card(['r1'], '原不完整卡', 'r1')
  const complete = card(['r3'], '独立出行', 'r3')
  const missing = { refs: ['r4'], status: 'insufficient', scope: '', evidence: [] }
  const response = cards => JSON.stringify({ cards })
  let failure
  try { topics.readTopicCards(response({ c1: [partial], c2: [complete] }), context) } catch (error) { failure = error }
  assert(failure instanceof topics.TopicCardCoverageError)
  assert.deepEqual(failure.missing, ['c1', 'c3']); assert(failure.message.includes('c1:r2'))
  assert.equal(failure.cards.length, 1); assert.equal(failure.cards[0].parentId, candidates[1].id)
  const repair = topics.createTopicCardRepair(failure, context), payload = JSON.parse(repair.input), initial = JSON.parse(context.input)
  assert.deepEqual(payload.requiredCandidateRefs, ['c1', 'c3']); assert.equal(payload.maxCards, 23)
  assert.deepEqual(payload.candidates, [initial.candidates[0], initial.candidates[2]])
  assert.deepEqual(payload.members, initial.members); assert.deepEqual(payload.context, initial.context)
  const replaced = card(['r1', 'r2'], '完整安装讨论', 'r2')
  const result = repair.validate(response({ c1: [replaced], c3: [missing] }))
  assert.deepEqual(result.map(value => value.parentId), candidates.map(value => value.id))
  assert.deepEqual(result[0].candidate.fragments, snapshot.fragments.slice(0, 2))
  assert.equal(result[1], failure.cards[0]); assert(!result.some(value => value.scope === partial.scope))
  assert.throws(() => repair.validate(response({ c1: [partial], c3: [missing] })), /REF_UNCOVERED/)
  assert.throws(() => repair.validate(response({ c1: [replaced], c2: [complete], c3: [missing] })), /REF_UNKNOWN/)
  for (const bad of [{ ...complete, summary: '非法' }, { ...complete, refs: ['r1'] }, { ...complete, evidence: [{ ref: 'r3', text: '编造' }] }]) {
    assert.throws(() => topics.readTopicCards(response({ c1: [partial], c2: [bad] }), context), error => !(error instanceof topics.TopicCardCoverageError))
  }
  assert.throws(() => topics.readTopicCards(response({ c1: [partial], c2: [complete] }), { ...context, cardLimit: 2 }), /容量/)
  const tight = { ...context, cardLimit: 3 }
  try { topics.readTopicCards(response({ c1: [partial], c2: [complete] }), tight) } catch (error) { failure = error }
  const tightRepair = topics.createTopicCardRepair(failure, tight)
  assert.equal(JSON.parse(tightRepair.input).maxCards, 2)
  assert.throws(() => tightRepair.validate(response({ c1: [partial, { ...partial, refs: ['r2'], evidence: ['r2'] }], c3: [missing] })), /容量/)
}

// 目录合并不丢叶候选，统计按真实来源去重，未知、重复及代表错绑均拒绝。
function checkTopicDirectory() {
  const { snapshot, candidates } = topicFixture(), context = topics.createTopicCardContext(snapshot, candidates)
  const cards = topics.readTopicCards(JSON.stringify({ cards: Object.fromEntries([...context.candidates].map(([ref, candidate]) => {
    const sourceRef = [...context.sources].find(([, fragments]) => candidate.fragments.includes(fragments[0]))[0]
    return [ref, [{ refs: [...context.sources].filter(([, fragments]) => candidate.fragments.includes(fragments[0])).map(([key]) => key),
      status: 'ok', scope: '具体方案', evidence: [sourceRef] }]]
  })) }), context)
  const directory = topics.createTopicCatalogContext(snapshot, cards)
  assert.equal(JSON.parse(directory.input).kind, 'topic-directory-3')
  assert(JSON.parse(directory.input).candidates.every(value => !Object.hasOwn(value, 'summary')))
  const group = { refs: ['c1', 'c3'], scope: '安装方案', representatives: ['c3'] }
  const read = groups => topics.readTopicDirectory(JSON.stringify({ groups, completed: true }), directory, cards)
  const merged = read([group])
  assert.throws(() => read([{ ...group, summary: '旧自由说明' }]), /FIELD_TYPE/)
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

// 溢出目录完整解码回范围、证据与去重统计，时间精度显式标记且引用仍绑定原卡。
function checkCompactTopicDirectory() {
  const snapshot = evidence.createReportEvidence([{ userId: 'a', content: '原文😀'.repeat(100), ts: 1791000000123 },
    { userId: 'b', content: '具体回应', ts: 1791000100999 }, { userId: 'a', content: '时间未知' }])
  const cards = Array.from({ length: 600 }, (_, index) => {
    const fragment = snapshot.fragments[index % 3], sourceCharacters = Array.from(fragment.text).length
    return { candidate: { id: 'card-' + index, fragments: [fragment] }, leaves: ['card-' + index], status: 'ok', scope: '独立范围' + index,
      evidence: [{ fragment, text: index % 3 === 0 ? '原文😀' : fragment.text, sourceCharacters, excerptOnly: true, truncated: index % 3 === 0 }] }
  })
  const ordinary = topics.createTopicCatalogContext(snapshot, cards, 10), compact = topics.createTopicCatalogContext(snapshot, cards, 10, true)
  const before = JSON.parse(ordinary.input), after = JSON.parse(compact.input)
  assert(ordinary.input.length > 32000 && compact.input.length < 32000)
  assert.equal(after.kind, 'topic-selection-4'); assert.equal(after.timePrecisionMs, 60000); assert.equal(after.evidenceExcerptOnly, true)
  assert.equal(after.candidates.length, cards.length); assert.equal(after.evidence.length, 3)
  for (const [index, row] of after.candidates.entries()) {
    const decoded = Object.fromEntries(after.columns.map((column, position) => [column, row[position]])), original = before.candidates[index]
    assert.equal(decoded.scope, original.scope); assert.equal(decoded.sourceCount, original.sourceCount); assert.equal(decoded.memberCount, original.memberCount)
    assert.deepEqual(decoded.evidence.map(ref => { const entry = after.evidence[ref], text = Array.isArray(entry) ? entry[0] : entry
      return { text, excerptOnly: true, truncated: Array.isArray(entry), sourceCharacters: Array.isArray(entry) ? entry[1] : Array.from(text).length }
    }), original.evidence)
    for (const side of ['first', 'last']) {
      const minute = decoded[side + 'Minute'], time = original[side + 'Time']
      if (time === null) assert.equal(minute, null)
      else assert(time >= after.timeOriginMs + minute * 60000 && time < after.timeOriginMs + (minute + 1) * 60000)
    }
  }
  assert.deepEqual(topics.readTopicCatalogSelection('{"selected":["c1","c600"],"completed":true}', compact, 10), [cards[0].candidate, cards[599].candidate])
  assert.throws(() => topics.readTopicCatalogSelection('{"selected":["c601"],"completed":true}', compact, 10), /REF_UNKNOWN/)
  assert.throws(() => topics.createTopicCatalogContext(snapshot, cards, undefined, true), /只用于完整全局选题/)
}

// 注册到插件正式入口，不通过独立执行空导出冒充测试通过。
function runReportTopicTests(check) {
  for (const [label, run] of [['中性直接归组保留未合并及非法优先', checkGrouping], ['四档选题缺漏定向恢复、合法空结果及稳定排序', checkPriorities],
    ['归并候选就近提供完整原文、真实作者、多归属与长文尾部', checkInlineGroupingMaterial],
    ['全局比较拒绝超额提名且合法补漏仅使用剩余名额', checkComparisonNominationLimit],
    ['中性概述区分完整供料与文字依据、分段合成绑定原文', checkOverview],
    ['概述去作者代号但保留真实本人和原文绑定，按实际提供引用检查', checkOverviewAuthorProjection],
    ['卡片去生成名称而保留原文、作者、永久绑定及恢复作用域', checkTopicCardInputProjection],
    ['全文材料卡原文所有权、合法缺漏及非法优先', checkTopicCards], ['来源子卡并集、共享、父关联及有界补父恢复', checkSplitTopicCards],
    ['已知父容器错层及来源唯一别名带告警，重名和越权仍失败', checkCardContainerTolerance],
    ['标点空根字段有界忽略且非空内容和重复键拒绝', checkEmptyCardRootFields],
    ['别名父逐卡来源唯一且同父时恢复，未知引用和坏字段仍拒绝', checkCardParentAliasRestoration],
    ['共享来源逐卡消歧，不能用别名并集掩盖归属歧义', checkCardParentAliasAmbiguity],
    ['多证据逐条来源、有界摘录和明确格式告警，越权与改写仍失败', checkMultipleCardEvidence],
    ['精确空不足子卡带告警忽略，原索引与完整父覆盖及恢复保留', checkEmptyInsufficientCards],
    ['漏核心父原子重制、合法父保留、容量及非法整批拒绝', checkIncompleteParentRepair],
    ['少量未归类原文单列审计、阈值与非法优先、恢复沿用原额度', checkUnassignedCoreTolerance],
    ['无淘汰目录保留叶候选、统计及最终选题严格校验', checkTopicDirectory],
    ['紧凑完整目录逐项保留范围证据统计、未知时间及引用边界', checkCompactTopicDirectory]]) {
    try { run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportTopicTests }
