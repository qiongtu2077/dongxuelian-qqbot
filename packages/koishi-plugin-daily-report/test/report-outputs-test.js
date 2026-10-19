/** 简明有据输出协议的真实来源、空状态与定向恢复。 */
'use strict'
const assert = require('assert').strict
const evidence = require('../lib/report-evidence'), outputs = require('../lib/report-outputs')
const engine = require('../lib/complete-input')
const { assertReportDisplayText } = require('../lib/report-exchange')
const { createReportAnalysisDiagnostics } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 同名不同人及辅助发言混合供料，人物归属只能由永久身份决定。
function outputFixture() {
  const snapshot = evidence.createReportEvidence([
    { userId: 'a', user: '同名', content: '  推荐这个安装方法😀  ' }, { userId: 'b', user: '同名', content: '讨论集合安排' },
    { userId: 'c', content: '群友评价某成员的说法' }, { userId: 'a', content: '[图片]' },
    { userId: 'a', content: '补充设置方法' }, { userId: 'a', content: '提供排错经验' }, { userId: 'b', content: '明确集合时间' },
  ])
  const context = outputs.createGroundedOutputContext(snapshot, [{ sourceId: 1 }, { sourceId: 2 }, { sourceId: 3, role: 'auxiliary' }, { sourceId: 4 }, { sourceId: 5 }, { sourceId: 6 }, { sourceId: 7 }],
    [{ ref: 's1', text: '本窗口共四条消息。' }])
  return { snapshot, context }
}

// 原话空白和本人逐字恢复，点评允许空；无材料状态与结构错误分别处理。
function checkQuotes() {
  const { snapshot, context } = outputFixture(), refs = ['r1', 'r2', 'r5', 'r6', 'r7']
  const body = values => JSON.stringify({ items: values.map(ref => ({ ref, comment: '' })) })
  for (const count of [3, 4, 5]) {
    const result = outputs.readGroundedQuotes(body(refs.slice(0, count)), context)
    assert.equal(result.length, count); assert.equal(result[0].content, snapshot.sources[0].content)
    assert.equal(result[0].userId, 'a'); assert.equal(result[0].sender, '同名'); assert.equal(result[0].reason, '')
  }
  assert.deepEqual(outputs.readGroundedQuotes('{"items":[]}', context), [])
  for (const values of [refs.slice(0, 1), refs.slice(0, 2), [...refs, 'r1']]) assert.throws(() => outputs.readGroundedQuotes(body(values), context), /三至五条/)
  for (const ref of ['r3', 'r4', 'r99']) assert.throws(() => outputs.readGroundedQuotes(body([ref, 'r2', 'r5']), context))
  assert.throws(() => outputs.readGroundedQuotes(body(['r1','r1','r5']), context), /REF_DUPLICATE/)
  for (const extra of [{ status: 'insufficient' }, { completed: true }, { extra: true }]) assert.throws(() => outputs.readGroundedQuotes(JSON.stringify({ items: [], ...extra }), context), /FIELD_TYPE/)
  assert.throws(() => outputs.readGroundedQuotes('{"items":[],"items":[]}', context), /FIELD_DUPLICATE/)
  assert.throws(() => outputs.readGroundedQuotes('{"items":[', context), /JSON_PARSE/)
  const excerpt = outputs.createGroundedOutputContext(snapshot, [{ sourceId: 1, text: '推荐这个安装方法' }, { sourceId: 2 }, { sourceId: 5 }])
  assert.throws(() => outputs.readGroundedQuotes(body(['r1','r2','r3']), excerpt), /QUOTE_UNSUPPORTED/)
  assert.throws(() => outputs.createGroundedOutputContext(snapshot, [{ sourceId: 1, text: '不存在的原话' }]), /实际连续原文/)
  for (const length of [90, 91]) {
    const source = evidence.createReportEvidence([{ userId: 'a', content: '😀'.repeat(length) }, { userId: 'b', content: '完整原话二' }, { userId: 'c', content: '完整原话三' }])
    const complete = outputs.createGroundedOutputContext(source, [{ sourceId: 1 }, { sourceId: 2 }, { sourceId: 3 }])
    if (length === 90) assert.equal(outputs.readGroundedQuotes(body(['r1','r2','r3']), complete)[0].content, source.sources[0].content)
    else assert.throws(() => outputs.readGroundedQuotes(body(['r1','r2','r3']), complete), /九十字/)
  }
}

// 允许没有称号和依据不足，但每个供料对象都需完成；他人和辅助来源不能当本人证据。
function checkPortraits() {
  const { context } = outputFixture()
  const members = [{ member: 'p1', status: 'ok', title: '', description: '本期分享了安装方法。', refs: ['r1'] },
    { member: 'p2', status: 'insufficient', title: '', description: '', refs: [] }]
  const result = outputs.readGroundedPortraits(JSON.stringify({ members, completed: true }), context)
  assert.equal(result.portraits.length, 1); assert.equal(result.portraits[0].title, '本期参与者')
  assert.equal(result.portraits[0].userId, 'a'); assert.equal(result.portraits[0].mbti, '')
  assert.deepEqual(result.insufficientMembers, ['p2'])
  assert.deepEqual(outputs.readGroundedPortraits(JSON.stringify({ members: [...members].reverse(), completed: true }), context), result)
  for (const refs of [['r2'], ['r3'], ['r1', 'r1'], []]) {
    const invalid = structuredClone(members); invalid[0].refs = refs
    assert.throws(() => outputs.readGroundedPortraits(JSON.stringify({ members: invalid, completed: true }), context), error => !(error instanceof outputs.GroundedPortraitCoverageError))
  }
  const missing = { members: [members[0]], completed: true }
  let error
  try { outputs.readGroundedPortraits(JSON.stringify(missing), context) } catch (caught) { error = caught }
  assert.ok(error instanceof outputs.GroundedPortraitCoverageError)
  const repair = outputs.createGroundedPortraitRepair(error, context), payload = JSON.parse(repair.input)
  assert.deepEqual(payload.members.map(member => member.ref), ['p2'])
  assert.deepEqual(payload.sources.map(source => source.ref), ['r2', 'r7'])
  assert.deepEqual(repair.validate(JSON.stringify({ members: [members[1]], completed: true })), result)
  assert.throws(() => repair.validate(JSON.stringify({ members, completed: true })))
  assert.throws(() => outputs.readGroundedPortraits('{"members":[],"members":[],"completed":true}', context), /FIELD_DUPLICATE/)
  const dishonest = structuredClone(members); dishonest[1].description = '仍夹带评价'
  assert.throws(() => outputs.readGroundedPortraits(JSON.stringify({ members: dishonest, completed: true }), context))
}

// 一维和零主观指数均合法，统计只能引用当前程序表，不用逐字数字扫描替代语义审阅。
function checkReview() {
  const { context } = outputFixture()
  const value = { status: 'ok', title: '本期互动', summary: '围绕安装与集合安排交流。', refs: ['r1', 'r2'], statRefs: [],
    dimensions: [{ name: '交流', percentage: 0, comment: '讨论了安装方案和型号2026。', refs: ['r1'], statRefs: ['s1'] }], completed: true }
  const result = outputs.readGroundedReview(JSON.stringify(value), context)
  assert.equal(result.dimensions.length, 1); assert.equal(result.dimensions[0].percentage, 0)
  assert.ok(result.dimensions[0].comment.includes('2026'))
  assert.deepEqual(result.dimensions[0].statRefs, ['s1'])
  const empty = { status: 'insufficient', title: '', summary: '', dimensions: [], refs: [], statRefs: [], completed: true }
  assert.equal(outputs.readGroundedReview(JSON.stringify(empty), context), null)
  for (const change of [v => { v.dimensions[0].statRefs = ['s99'] }, v => { v.refs = ['r99'] }, v => { v.dimensions[0].percentage = 101 },
    v => { v.dimensions[0].percentage = '50' }, v => { v.dimensions[0].refs = []; v.dimensions[0].statRefs = [] },
    v => { v.summary = '字'.repeat(2001) }, v => { v.completed = false }, v => { v.extra = true }]) {
    const invalid = structuredClone(value); change(invalid)
    assert.throws(() => outputs.readGroundedReview(JSON.stringify(invalid), context))
  }
  assert.throws(() => outputs.readGroundedReview(JSON.stringify({ ...empty, title: '夹带无依据标题' }), context))
}

// 唯一恢复仍失败时保留两轮的精确引用域；成功前不写完成产物。
async function checkOutputFailureDiagnostics() {
  const { context } = outputFixture(), attempts = [], saved = []
  const meta = createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
  let calls = 0
  await assert.rejects(engine.requestAnalysisUnit({ deadlineMs: Date.now() + 60000,
    request: async (_system, _input, _tokens, extra) => {
      extra._onRequestAttempt(); calls++
      return JSON.stringify({ members: calls === 1 ? [{ member: 'p1', status: 'insufficient', title: '', description: '', refs: [] }] : [], completed: true })
    }, onUnitCompleted() { saved.push(true) }, onUnitFailed(_unit, values) { attempts.push(...values) } }, meta,
  { id: 'portraits', stage: 'full', sourceIds: [1, 2, 3, 4], timestamps: [] }, outputs.getGroundedOutputInstructions('portraits'), context.input, 2048, 1000,
  text => outputs.readGroundedPortraits(text, context), error => outputs.createGroundedPortraitRepair(error, context)))
  assert.equal(calls, 2); assert.equal(saved.length, 0)
  assert.deepEqual(attempts.map(value => value.allowedRefs), [['p1', 'p2'], ['p2']])
  assert.deepEqual(attempts.map(value => value.missingRefs), [['p2'], ['p2']])
  assert.deepEqual(meta.failedBatches[0].missingRefs, ['p2'])
}

// 真实592详细反例：p别名不得泄漏到展示文本，合法原话中的ASCII词元保持原样。
function checkDisplayAliases() {
  const { context } = outputFixture()
  for (const description of ['p1今日发言集中在游戏内容。', '据r1分析本人发言。']) {
    assert.throws(() => outputs.readGroundedPortraits(JSON.stringify({ members: [
      { member: 'p1', status: 'ok', title: '本期参与者', description, refs: ['r1'] },
      { member: 'p2', status: 'insufficient', title: '', description: '', refs: [] }], completed: true }), context), /LOCAL_REF_IN_TEXT/)
  }
  assert.throws(() => outputs.readGroundedQuotes(JSON.stringify({ items: [{ ref: 'r1', comment: 'p1的一句话' }, { ref: 'r2', comment: '' }, { ref: 'r5', comment: '' }] }), context), /LOCAL_REF_IN_TEXT/)
  assert.throws(() => outputs.readGroundedReview(JSON.stringify({ status: 'ok', title: '本期互动', summary: 'p1带动讨论', refs: ['r1'], statRefs: [],
    dimensions: [{ name: '互动', percentage: 50, comment: '参与交流', refs: ['r1'], statRefs: [] }], completed: true }), context), /LOCAL_REF_IN_TEXT/)
  const snapshot = evidence.createReportEvidence([{ userId: 'a', content: 'p1是原文中使用的标记，GPU p100不是人物编号。' }, { userId: 'a', content: '第二条原话' }, { userId: 'a', content: '第三条原话' }])
  const raw = outputs.createGroundedOutputContext(snapshot, [{ sourceId: 1 }, { sourceId: 2 }, { sourceId: 3 }])
  const quote = outputs.readGroundedQuotes(JSON.stringify({ items: [{ ref: 'r1', comment: '讨论了GPU p100标记。' }, { ref: 'r2', comment: '' }, { ref: 'r3', comment: '' }] }), raw)
  assert.equal(quote[0].content, snapshot.sources[0].content)
  assert(outputs.getGroundedOutputInstructions('portraits').includes('展示文字不能出现'))
  // 反馈指出真正违规编号，保持出现顺序、去重及容量界限，不能回显无关原句。
  const refs = Array.from({ length: 12 }, (_, index) => 'p' + (index + 1))
  const privateText = '不应回显的原句与unknown_alias ' + ['p3', 'p3', 'r1', ...refs].join('，')
  assert.throws(() => assertReportDisplayText(privateText, [...refs, 'r1'], '测试文字'), error => {
    assert(error.message.includes('检测到：p3,r1,p1,p2,p4,p5,p6,p7（仅列前八项）'))
    assert(error.message.includes('结构化引用字段'))
    assert(!error.message.includes('不应回显') && !error.message.includes('unknown_alias'))
    assert(!error.message.includes('p12'))
    return true
  })
  assert.doesNotThrow(() => assertReportDisplayText('GPU p100、xp1、p1_suffix及unknown_alias保持原样。', ['p1', 'r1'], '测试文字'))
}

// 正式插件测试入口验证当前契约，旧版固定维度及人格要求不作用于新结果。
async function runReportOutputTests(check) {
  for (const [label, run] of [['有据金句恢复完整本人原话与合法不足', checkQuotes], ['本人画像归属、精确空结果及唯一缺漏恢复', checkPortraits],
    ['简明锐评一至五维、主观指数及程序统计引用', checkReview], ['独立输出恢复失败保留每轮精确缺失引用诊断', checkOutputFailureDiagnostics],
    ['真实局部人物编号泄漏拒绝且原始金句保持逐字', checkDisplayAliases]]) {
    try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportOutputTests }
