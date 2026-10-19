/** 连续原话复核的生产材料/真实请求入口测试；仅外部模型响应模拟。 */
'use strict'
const assert = require('assert').strict
const evidence = require('../lib/report-evidence'), reading = require('../lib/report-reading'), engine = require('../lib/complete-input')
const { createReportAnalysisDiagnostics } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 固定同名异人的实际条件、估算与最后更正，不通过昵称归并身份。
function readingFixture() {
  const messages = [{ userId: 'a', user: '同名', content: '如果每秒一次，持续十秒', ts: 1 },
    { userId: 'b', user: '同名', content: '估算总伤一万', ts: 2 }, { userId: 'b', user: '同名', content: '最后更正为四星', ts: 3 }]
  const snapshot = evidence.createReportEvidence(messages), context = reading.createReportReadingContext(snapshot, snapshot.fragments)
  const value = { titleRef: 'm2', titleExcerpt: messages[1].content,
    records: Object.fromEntries(messages.map((message, index) => ['m' + (index + 1), { excerpt: message.content }])), completed: true }
  return { snapshot, context, value }
}

// 所有原话及本人保持；缺漏不代表闲聊，首尾来源均进入当前实际供料。
function checkReadingMaterial() {
  const { snapshot, context, value } = readingFixture(), result = reading.readReportReading(JSON.stringify(value), context)
  assert.equal(result.topic.title, '围绕「估算总伤一万」的讨论')
  assert.deepEqual(result.reviewed, ['m1', 'm2', 'm3'])
  assert.deepEqual(result.topic.summaryParts.filter(part => typeof part !== 'string'), [{ memberId: 'a' }, { memberId: 'b' }])
  assert.ok(result.topic.summary.includes('如果每秒一次，持续十秒') && result.topic.summary.includes('最后更正为四星'))
  assert.deepEqual(result.topic.fragments, snapshot.fragments)
  const schema = reading.getReportReadingSchema(context.input)
  assert.deepEqual(schema.properties.records.required, ['m1', 'm2', 'm3'])
  assert.deepEqual(schema.properties.titleRef.enum, ['m1', 'm2', 'm3'])
  const short = reading.createReportExcerptContext(snapshot, [{ fragment: snapshot.fragments[2], excerpt: '最后更正' }])
  assert.throws(() => reading.readReportReading(JSON.stringify({ titleRef: 'm1', titleExcerpt: '四星', records: { m1: { excerpt: '最后更正' } }, completed: true }), short), /QUOTE_UNSUPPORTED/)
  assert.throws(() => reading.createReportExcerptContext(snapshot, [{ fragment: { ...snapshot.fragments[0] }, excerpt: '如果每秒' }]), /当前快照/)
  assert.throws(() => reading.createReportExcerptContext(snapshot, [{ fragment: snapshot.fragments[0], excerpt: '改写条件' }]), /连续文字/)
  const empty = evidence.createReportEvidence([{ userId: 'a', content: '' }, { userId: 'b', content: '有实质内容' }])
  const emptyContext = reading.createReportReadingContext(empty, empty.fragments)
  assert.equal(reading.readReportReading(JSON.stringify({ titleRef: 'm2', titleExcerpt: '有实质内容', records: { m1: 'read_only', m2: { excerpt: '有实质内容' } }, completed: true }), emptyContext).reviewed.length, 2)
}

// 未知、错锚、拼接、额外/重复属性和超界先于缺漏，禁止猜补来源。
function checkReadingIllegalPrecedence() {
  const { context, value } = readingFixture(), missing = structuredClone(value)
  delete missing.records.m3
  assert.throws(() => reading.readReportReading(JSON.stringify(missing), context), error => error instanceof reading.ReportReadingCoverageError && error.missing[0] === 'm3')
  for (const change of [v => { v.titleRef = 'm99' }, v => { v.titleExcerpt = '算术验证完毕' },
    v => { v.records.m2 = 'read_only' }, v => { v.records.m1 = { excerpt: '如果每秒一次估算总伤一万' } },
    v => { v.records.m99 = 'read_only' }, v => { v.title = '自由标题' }, v => { v.records.m1.extra = '未知' },
    v => { v.completed = false }, v => { v.titleExcerpt = '字'.repeat(61) }, v => { v.records.m1.excerpt = '字'.repeat(299) }]) {
    const invalid = structuredClone(missing); change(invalid)
    assert.throws(() => reading.readReportReading(JSON.stringify(invalid), context), error => !(error instanceof reading.ReportReadingCoverageError))
  }
  assert.throws(() => reading.readReportReading(JSON.stringify(value).replace('"m3":', '"m3":"read_only","m3":'), context), /FIELD_DUPLICATE/)
  assert.throws(() => reading.readReportReading(JSON.stringify(value).replace('"m3":', '"\\u006d3":"read_only","m3":'), context), /FIELD_DUPLICATE/)
  assert.equal(reading.createReportReadingRepair(new Error('普通非法返回'), context), undefined)
}

// 总字数/段数保留硬界；所有原话已读但没有实质摘录也不能作为话题成功。
function checkReadingBudgets() {
  for (const [count, length] of [[4, 298], [31, 3]]) {
    const snapshot = evidence.createReportEvidence(Array.from({ length: count }, (_, index) => ({ userId: String(index), content: '字'.repeat(length) })))
    const context = reading.createReportReadingContext(snapshot, snapshot.fragments)
    const value = { titleRef: 'm1', titleExcerpt: '字', records: Object.fromEntries([...context.allowed].map(([ref, source]) => [ref, { excerpt: source.parts[1] }])), completed: true }
    assert.throws(() => reading.readReportReading(JSON.stringify(value), context), /TEXT_BUDGET/)
  }
  const { context, value } = readingFixture()
  value.records = { m1: 'read_only', m2: 'read_only', m3: 'read_only' }
  assert.throws(() => reading.readReportReading(JSON.stringify(value), context), /TITLE_UNSELECTED/)
}

// 真实单元入口保持第一次已验证标题/摘录/人物；补漏只发送原缺失m3。
async function checkReadingRequestRepair() {
  const { context, value } = readingFixture(), inputs = [], saved = []
  const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: 3, windowMessageCount: 3, sourceCompleteness: 'complete' })
  const result = await engine.requestAnalysisUnit({ deadlineMs: Date.now() + 60000, recoveryInstructions: '完整连续原话对象',
    request: async (_system, input, _tokens, extra) => {
      extra._onRequestAttempt(); inputs.push(input)
      if (inputs.length === 1) { const first = structuredClone(value); delete first.records.m3; return JSON.stringify(first) }
      assert.deepEqual(JSON.parse(input).facts.map(fact => fact.ref), ['m3'])
      assert.deepEqual(JSON.parse(input).members, JSON.parse(inputs[0]).members)
      return JSON.stringify({ titleRef: 'm3', titleExcerpt: '最后更正', records: { m3: { excerpt: '最后更正为四星' } }, completed: true })
    }, onUnitCompleted(_unit, attempts, result) { saved.push({ attempts, result }) } }, diagnostics,
  { id: 'reading', stage: 'deep_read', sourceIds: [1, 2, 3], timestamps: [] }, reading.getReportReadingInstructions(), context.input, 5000, 1000,
  text => reading.readReportReading(text, context), error => reading.createReportReadingRepair(error, context))
  assert.equal(inputs.length, 2); assert.equal(diagnostics.retryCount, 1); assert.equal(saved.length, 1)
  assert.equal(result.topic.title, '围绕「估算总伤一万」的讨论')
  assert.deepEqual(result.excerpts, { m1: '如果每秒一次，持续十秒', m2: '估算总伤一万', m3: '最后更正为四星' })
  assert.deepEqual(result.reviewed, ['m1', 'm2', 'm3'])
}

// 恢复不能改变首轮或漏原缺失；合并仍受原1000字预算，失败不保存完成。
async function checkReadingRequestFailure() {
  for (const mode of ['rewrite', 'missing', 'budget']) {
    const fixture = mode === 'budget' ? (() => {
      const snapshot = evidence.createReportEvidence(Array.from({ length: 4 }, (_, index) => ({ userId: String(index), content: '字'.repeat(298) })))
      const context = reading.createReportReadingContext(snapshot, snapshot.fragments)
      return { context, value: { titleRef: 'm1', titleExcerpt: '字', records: Object.fromEntries([...context.allowed].map(([ref]) => [ref, { excerpt: '字'.repeat(298) }])), completed: true } }
    })() : readingFixture()
    const { context, value } = fixture, missingRef = [...context.allowed.keys()].at(-1), calls = [], saved = []
    const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: context.allowed.size, windowMessageCount: context.allowed.size, sourceCompleteness: 'complete' })
    await assert.rejects(engine.requestAnalysisUnit({ deadlineMs: Date.now() + 60000, recoveryInstructions: '完整原话对象',
      request: async (_system, input, _tokens, extra) => {
        extra._onRequestAttempt(); calls.push(input)
        if (calls.length === 1) { const first = structuredClone(value); delete first.records[missingRef]; return JSON.stringify(first) }
        return JSON.stringify({ titleRef: missingRef, titleExcerpt: context.allowed.get(missingRef).parts[1].slice(0, 10), records:
          mode === 'missing' ? {} : { [missingRef]: value.records[missingRef], ...(mode === 'rewrite' ? { m1: 'read_only' } : {}) }, completed: true })
      }, onUnitCompleted() { saved.push(true) } }, diagnostics,
    { id: 'reading-failed', stage: 'deep_read', sourceIds: [], timestamps: [] }, reading.getReportReadingInstructions(), context.input, 5000, 1000,
    text => reading.readReportReading(text, context), error => reading.createReportReadingRepair(error, context)))
    assert.equal(calls.length, 2); assert.equal(saved.length, 0)
  }
}

// 接入正式日报测试结果，所有场景使用独立快照/请求状态。
async function runReportReadingTests(check) {
  for (const [label, run] of [['复核完整供料、永久本人、实际摘录域与空正文已读', checkReadingMaterial],
    ['复核非法引用/拼接/标题/重复字段先于覆盖', checkReadingIllegalPrecedence], ['复核1000字/30段与实质摘录预算', checkReadingBudgets],
    ['正式复核单元只补缺失、首次标题原话保持', checkReadingRequestRepair], ['复核恢复失败及合并超界不保存完成', checkReadingRequestFailure]]) {
    try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportReadingTests }
