/** 单一编排器的真实材料、模块结果、实际请求预算和取消行为。 */
'use strict'
const assert = require('assert').strict
const { runGroundedReport } = require('../lib/report-runner')
const { ReportRequestPool, ReportRequestBoundaryError } = require('../lib/report-request-pool')
const { createReportEvidence } = require('../lib/report-evidence')
const { updateReportBatchCatalog, selectReportCatalogBatches } = require('../lib/report-batch-catalog')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = loadManagementModule('daily.reportPeriod')
const { createReportAnalysisDiagnostics } = loadManagementModule('daily.reportAnalysis')
const { requestAnalysisUnit, AnalysisUnitRequestTimeoutError } = require('../lib/complete-input')

// 外部模型是唯一替身，材料构造、读取器、恢复、计数及结果组装全部使用生产代码。
function modelReply(stage, payload, mode = 'normal') {
  if (stage === 'classification') return { groups: { [mode === 'social' ? 'social:1' : 'event:1']: '安装讨论' }, records: Object.fromEntries(payload.items.map(item => [item.ref, mode === 'social' ? 'social:1' : 'event:1'])),
    quotes: mode === 'quote' ? payload.items.slice(0, 3).map(item => ({ kind: 'quote', ref: item.ref, criterion: 'useful_insight' })) : [], completed: true }
  if (payload.kind === 'topic-cards-2') return { cards: Object.fromEntries(payload.candidates.map(candidate => {
    const source = candidate.sources[0]
    const ok = mode !== 'social' && (mode !== 'tail-priority' || candidate.sources.some(source => source.text.includes('TAIL_SENTINEL')))
    return [candidate.ref, { status: ok ? 'ok' : 'insufficient', scope: ok ? '安装讨论' : '', summary: ok ? '安装与设置的具体问题' : '',
      evidence: ok ? [{ ref: source.ref, text: Array.from(source.text).slice(0, 64).join('') }] : [] }]
  })) }
  if (stage === 'grouping') return { groups: payload.candidates.length > 1 ? [{ refs: payload.candidates.map(candidate => candidate.ref),
    scope: '安装讨论', summary: '讨论安装与设置', representatives: [payload.candidates[0].ref] }] : [], completed: true }
  if (payload.kind === 'topic-selection-2') return { selected: payload.candidates.slice(0, payload.displayLimit).map(candidate => candidate.ref), completed: true }
  if (stage === 'overview') return { title: '安装与配置讨论', summary: '交流了安装方案与设置。', refs: [payload.sources[0].ref], completed: true }
  if (stage === 'quotes') return { items: payload.sources.filter(source => source.role === 'primary').slice(0, 3).map(source => ({ ref: source.ref, comment: '' })) }
  if (stage === 'portraits') return { members: payload.members.map(member => ({ member: member.ref, status: 'ok', title: '', description: '本期参与了具体讨论。', refs: member.refs.slice(0, 1) })), completed: true }
  if (stage === 'review') return { status: 'ok', title: '本期互动', dimensions: [{ name: '讨论', percentage: 0, comment: '围绕实际问题交流。', refs: [payload.sources[0].ref], statRefs: ['s1'] }],
    summary: '参与了本期讨论。', refs: [payload.sources[0].ref], statRefs: [], completed: true }
  throw new Error('未知测试阶段')
}

// 用固定原话和真实永久身份构造输入，不把重复正文当同一消息。
function reportData(count = 6) {
  return { messages: Array.from({ length: count }, (_, index) => ({ messageId: 'source-' + index, realMessageId: true,
    userId: 'member-' + index % 3, user: '同名', ts: index, time: '12:00:00', content: '讨论安装与设置' + index })),
    totalMessages: count, activeMembers: Math.min(count, 3), sourceCompleteness: 'complete' }
}

// 保留实际提交钩子、完整材料和成功产物；所有上游替身显式报一次实际尝试。
function runnerOptions(mode = 'normal') {
  const calls = [], saved = [], options = { deadlineMs: Date.now() + 600000, concurrency: 2,
    onUnitCompleted(unit, attempts, result) { saved.push({ unit, attempts, result }) },
    request: async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true })
      calls.push({ stage, attempt, system, input, tokens })
      return JSON.stringify(modelReply(stage, JSON.parse(input), mode))
    } }
  return { calls, saved, options }
}

// 详细版不凑五个话题，四模块独立供料，原话与本人身份由程序组装。
async function checkCompleteRunner() {
  const { options, calls, saved } = runnerOptions('quote'), data = reportData()
  const result = await runGroundedReport(data, true, options)
  assert.equal(result.analysisVersion, 'grounded-report-1'); assert.equal(result.topics.length, 1)
  assert.equal(result.goldenQuotes[0].content, data.messages[0].content)
  assert.equal(result.goldenQuotes[0].userId, data.messages[0].userId)
  assert.equal(result.userTitles.length, 3); assert.ok(result.userTitles.every(member => member.mbti === '' && member.title === '本期参与者'))
  assert.equal(result.qualityReview.dimensions.length, 1); assert.ok(result.qualityReview.subtitle.includes('主观指数'))
  assert.ok(result.qualityReview.dimensions[0].comment.includes('窗口消息量：6条'))
  assert.equal(result.meta.evidence.processedMessageCount, 6)
  assert.equal(result.meta.evidence.deepReadMessageCount, 6)
  assert.equal(result.meta.evidence.displayedTopicMessageCount, 1)
  assert.ok(['classification', 'selection', 'overview', 'quotes', 'portraits', 'review'].every(stage => calls.some(call => call.stage === stage)))
  assert.equal(saved.length, calls.length)
  assert.ok(calls.every(call => Array.from(call.system + call.input).length <= (['grouping', 'selection'].includes(call.stage) ? 32000 : 16000)))
  assert.ok(calls.every(call => call.tokens === (['classification', 'grouping', 'selection'].includes(call.stage) ? 4096 : 2048)))
  for (const call of calls.filter(value => JSON.parse(value.input).kind === 'topic-cards-2')) {
    const payload = JSON.parse(call.input)
    assert.deepEqual(payload.requiredCandidateRefs, payload.candidates.map(candidate => candidate.ref))
    assert.equal(payload.candidateCount, payload.candidates.length)
    assert(payload.candidates.every(candidate => candidate.scopeHints.includes('安装讨论')))
  }
  for (const call of calls.filter(value => value.stage === 'overview')) {
    const payload = JSON.parse(call.input)
    assert(payload.candidates.every(candidate => candidate.scopeHints.includes('安装讨论')))
  }
  assert(calls.filter(call => call.stage !== 'selection').every(call => !('requiredCandidateRefs' in JSON.parse(call.input))))
  assert.equal(calls.filter(call => JSON.parse(call.input).kind === 'topic-selection-2').length, 1)
}

// 零消息和精确纯图片不调用模型；非空短互动仍需各模块明确判断。
async function checkRunnerEmptyStates() {
  for (const count of [0, 4]) {
    const data = reportData(count); data.messages.forEach(message => { message.content = '[图片]' })
    const result = await runGroundedReport(data, true, { deadlineMs: Date.now() + 600000, request: async () => { throw new Error('不应调用模型') } })
    assert.deepEqual(result.topics, []); assert.deepEqual(result.goldenQuotes, []); assert.deepEqual(result.userTitles, [])
    assert.equal(result.qualityReview, null); assert.equal(result.meta.requestCount, 0)
    assert.equal(result.meta.evidence.processedMessageCount, count)
    assert.equal(result.meta.evidence.deterministicMessageCount, count)
  }
  const { options, calls } = runnerOptions('social')
  options.request = async (stage, attempt, system, input, tokens, extra) => {
    extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); calls.push({ stage })
    const payload = JSON.parse(input)
    if (stage === 'portraits') return JSON.stringify({ members: payload.members.map(member => ({ member: member.ref, status: 'insufficient', title: '', description: '', refs: [] })), completed: true })
    if (stage === 'review') return JSON.stringify({ status: 'insufficient', title: '', dimensions: [], summary: '', refs: [], statRefs: [], completed: true })
    return JSON.stringify(modelReply(stage, payload, 'social'))
  }
  const result = await runGroundedReport(reportData(), true, options)
  assert.equal(result.topics.length, 0); assert.equal(result.userTitles.length, 0); assert.equal(result.qualityReview, null)
  assert.ok(calls.some(call => call.stage === 'portraits') && calls.some(call => call.stage === 'review'))
  assert.equal(result.audit.modules.review, 'insufficient')
}

// 所有类别先阅读全文，独立短互动实质性由模型判断，不按类别过滤。
async function checkIndependentInteractionSelection() {
  for (const mixed of [true, false]) {
    const texts = mixed ? ['event-A', 'response-A', 'social-SENTINEL', 'media-A', 'uncertain-A', 'event-B'] : ['social-SENTINEL', 'media-A', 'uncertain-A']
    const data = reportData(texts.length), calls = []
    data.messages.forEach((message, index) => { message.content = texts[index] })
    const result = await runGroundedReport(data, false, { deadlineMs: Date.now() + 600000, concurrency: 2,
      request: async (stage, attempt, system, input, tokens, extra) => {
        extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); const payload = JSON.parse(input); calls.push({ stage, payload })
        if (stage === 'classification') return JSON.stringify({ groups: mixed ? { 'event:1': '事项甲', 'event:2': '事项乙' } : {},
          records: Object.fromEntries(payload.items.map(item => [item.ref, item.text === 'event-B' ? 'event:2' : item.text.split('-')[0] + ':1'])), quotes: [], completed: true })
        if (payload.kind === 'topic-cards-2') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => {
          const source = candidate.sources[0], ok = source.text === 'social-SENTINEL'
          return [candidate.ref, { status: ok ? 'ok' : 'insufficient', scope: ok ? '独立互动' : '', summary: ok ? '有具体对象的短互动' : '', evidence: ok ? [{ ref: source.ref, text: source.text }] : [] }]
        })) })
        if (stage === 'grouping') return '{"groups":[],"completed":true}'
        if (payload.kind === 'topic-selection-2') return JSON.stringify({ selected: payload.candidates.map(candidate => candidate.ref), completed: true })
        assert.equal(stage, 'overview'); assert(payload.sources.some(source => source.text === 'social-SENTINEL'))
        return JSON.stringify({ title: '本期独立互动', summary: '保留原始互动的选题结果。', refs: [payload.sources[0].ref], completed: true })
      } })
    const supplied = new Set(calls.filter(call => call.payload.kind === 'topic-cards-2').flatMap(call => call.payload.candidates.flatMap(candidate => candidate.sources.map(source => source.text))))
    assert(texts.every(text => supplied.has(text)))
    assert.equal(result.topics.length, 1)
    assert(result.audit.selected.some(candidate => candidate.fragmentIds.includes((texts.indexOf('social-SENTINEL') + 1) + ':1')))
    assert.equal(result.meta.evidence.processedMessageCount, texts.length); assert.equal(result.meta.evidence.unprocessedMessageCount, 0)
    assert.equal(result.audit.topicCards.length, texts.length)
  }
}

// 五十候选共同整理，无四十项淘汰；中段证据保留且最终按全部来源回读。
async function checkGlobalRepresentativeSelection() {
  const data = reportData(50), calls = []
  let emptySelection = false, emptyAttempts = 0
  data.messages.forEach((message, index) => { message.content = '开头'.repeat(120) + (index < 44 ? '安装范围' : '出行范围') + '中间证据' + index + '结尾'.repeat(120) + '完整尾部' })
  const options = { deadlineMs: Date.now() + 600000, concurrency: 2,
    request: async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); const payload = JSON.parse(input); calls.push({ stage, payload })
      if (stage === 'classification') return JSON.stringify({ groups: Object.fromEntries(payload.items.map((item, index) => ['event:' + (index + 1), '具体讨论'])),
        records: Object.fromEntries(payload.items.map((item, index) => [item.ref, 'event:' + (index + 1)])), quotes: [], completed: true })
      if (payload.kind === 'topic-cards-2') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => {
        const source = candidate.sources[0], scope = source.text.includes('安装范围') ? '安装范围' : '出行范围'
        assert(source.text.endsWith('完整尾部'))
        return [candidate.ref, { status: 'ok', scope, summary: '讨论了该范围的具体问题', evidence: [{ ref: source.ref, text: scope + '中间证据' }] }]
      })) })
      if (stage === 'grouping') {
        assert.equal(payload.candidates.length, data.messages.length > 6 ? 50 : 6)
        assert(payload.candidates.every(candidate => candidate.evidence[0].includes('中间证据')))
        return JSON.stringify({ groups: ['安装范围', '出行范围'].map(scope => ({ refs: payload.candidates.filter(candidate => candidate.scope === scope).map(candidate => candidate.ref), scope,
          summary: '讨论了这一范围的具体问题', representatives: [payload.candidates.find(candidate => candidate.scope === scope)?.ref] })).filter(group => group.refs.length > 1), completed: true })
      }
      if (payload.kind === 'topic-selection-2') {
        if (emptySelection) { emptyAttempts++; return '{"selected":[],"completed":true}' }
        assert.equal(payload.candidates.length, 2)
        assert.deepEqual(payload.candidates.map(candidate => candidate.sourceCount).sort((a,b)=>a-b), [6,44])
        return JSON.stringify({ selected: payload.candidates.map(candidate => candidate.ref), completed: true })
      }
      assert.equal(stage, 'overview')
      if (payload.candidates) assert(payload.sources.some(source => source.text.endsWith('完整尾部')))
      return JSON.stringify({ title: payload.candidates ? payload.candidates[0].scopeHints[0] : payload.sources[0].title,
        summary: '对照原文概括该具体范围。', refs: [payload.sources[0].ref], completed: true })
    } }
  const result = await runGroundedReport(data, false, options)
  assert.equal(result.topics.length, 2); assert.deepEqual(new Set(result.topics.map(topic => topic.title)), new Set(['安装范围', '出行范围']))
  assert.equal(new Set(calls.filter(call => call.payload.kind === 'topic-cards-2').flatMap(call => call.payload.candidates.flatMap(candidate => candidate.sources.map(source => source.text)))).size, 50)
  assert.equal(calls.filter(call => call.payload.kind === 'topic-selection-2').length, 1)
  assert.equal(result.audit.topicCards.length, 50); assert.equal(result.audit.topicCatalog.flatMap(card => card.leaves).length, 50)
  assert.equal(result.meta.evidence.deepReadMessageCount, 50)
  data.messages = data.messages.slice(0,6); data.totalMessages=6; emptySelection=true
  await assert.rejects(runGroundedReport(data, false, options), /完整目录需/)
  assert.equal(emptyAttempts, 2)
}

// 大量不合并卡片只做两层；完整目录超限时不启动最终选题、不丢尾部、不自动第三层。
async function checkCatalogCapacityFailure() {
  const data = reportData(300), calls = []
  await assert.rejects(runGroundedReport(data, false, { deadlineMs: Date.now() + 600000, concurrency: 2,
    request: async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); const payload = JSON.parse(input); calls.push({ stage, payload })
      if (stage === 'classification') return JSON.stringify({ groups: Object.fromEntries(payload.items.map((_, index) => ['event:' + (index + 1), '具体问题'])),
        records: Object.fromEntries(payload.items.map((item, index) => [item.ref, 'event:' + (index + 1)])), quotes: [], completed: true })
      if (payload.kind === 'topic-cards-2') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => {
        const source = candidate.sources[0]
        return [candidate.ref, { status: 'ok', scope: '范围'.repeat(16), summary: '实质内容'.repeat(20), evidence: [{ ref: source.ref, text: source.text }] }]
      })) })
      assert.equal(payload.kind, 'topic-directory-1'); return '{"groups":[],"completed":true}'
    } }), /最多两层整理仍超过容量/)
  assert.equal(calls.filter(call => call.payload.kind === 'topic-cards-2').flatMap(call => call.payload.candidates).length, 300)
  const grouping = calls.filter(call => call.stage === 'grouping')
  assert.equal(grouping.flatMap(call => call.payload.candidates).length, 600)
  assert(!calls.some(call => call.payload.kind === 'topic-selection-2'))
}

// 长正文每片都处理，选中事件按完整片段深读并合成；并发不改变输出顺序。
async function checkLongRunner() {
  const data = reportData(1); data.messages[0].content = '长正文'.repeat(7000) + '实际尾部更正'
  const { options, calls } = runnerOptions()
  const result = await runGroundedReport(data, false, options)
  assert.equal(result.meta.evidence.processedMessageCount, 1)
  assert.equal(result.meta.evidence.processedFragmentCount, 9)
  assert.equal(result.meta.evidence.deepReadFragmentCount, 9)
  assert.ok(calls.some(call => call.stage === 'overview' && call.input.includes('实际尾部更正')))
  assert.ok(calls.filter(call => call.stage === 'overview').length >= 3)
  assert.equal(result.audit.modules.portraits, 'not_requested')
}

// 稳定目录实际接到同一编排器，真实供料逐批一致，前后窗口都保持完整来源账本。
async function checkCatalogRunner() {
  const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00')), original = reportData(4000)
  original.reportPeriod = period
  original.messages.forEach((message, index) => { message.ts = period.periodStartMs + index * 100 })
  const directory = updateReportBatchCatalog(null, createReportEvidence(original.messages), { channelKey: 'group-A', period,
    nowMs: period.periodStartMs + 10 * 60000, inputScope: 'full_business_window', sourceCompleteness: 'complete' })
  const { options, calls } = runnerOptions('social')
  options.classificationCatalog = { channelKey: 'group-A', value: directory }
  const result = await runGroundedReport(original, false, options)
  const expected = selectReportCatalogBatches(directory, createReportEvidence(original.messages)).map(view => view.batch?.input).filter(Boolean)
  assert.deepEqual(calls.filter(call => call.stage === 'classification').map(call => call.input).sort(), expected.sort())
  assert.equal(result.meta.evidence.processedMessageCount, 4000)
  assert.equal(result.meta.unprocessedCount, 0)
  assert.equal(result.meta.batchCount, expected.length)
  assert(result.audit.firstRequests <= 184)
  const invalid = runnerOptions('social')
  invalid.options.classificationCatalog = { channelKey: 'other-group', value: directory }
  await assert.rejects(runGroundedReport(original, false, invalid.options), /绑定当前完整来源、群/)
  assert.equal(invalid.calls.length, 0)
}

// 合法缺漏只补原范围，统一调用计数与首轮结果保持，不能暗中增加第三次请求。
async function checkRunnerRecovery() {
  const { options, calls } = runnerOptions()
  options.request = async (stage, attempt, system, input, tokens, extra) => {
    extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); const payload = JSON.parse(input); calls.push({ stage, attempt, payload })
    const value = modelReply(stage, payload)
    if (stage === 'classification' && attempt === 1) delete value.records[payload.items.at(-1).ref]
    return JSON.stringify(value)
  }
  const result = await runGroundedReport(reportData(), false, options)
  assert.equal(result.audit.recoveries, 1); assert.equal(result.meta.retryCount, 1)
  assert.equal(calls.filter(call => call.stage === 'classification')[1].payload.items.length, 1)
  assert.equal(result.meta.evidence.processedMessageCount, 6)
  const hidden = runnerOptions()
  hidden.options.request = async (_stage, _attempt, _system, _input, _tokens, extra) => { extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); return '{}' }
  await assert.rejects(runGroundedReport(reportData(), false, hidden.options), /隐藏重试/)
  let unavailableCalls = 0
  await assert.rejects(runGroundedReport(reportData(), false, { deadlineMs: Date.now() + 600000,
    request: async (_stage, _attempt, _system, _input, _tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); unavailableCalls++; throw new ReportRequestBoundaryError('upstream', '实际供应商不可用')
    } }), /实际供应商不可用/)
  assert.equal(unavailableCalls, 1)
}

// 错配原文仍走一次整输入恢复；精确c/r和根结构说明进入恢复，程序不替模型改引用。
async function checkCardEvidenceRecovery() {
  for (const corrected of [true, false]) {
    const { options, calls, saved } = runnerOptions(), failures = []
    options.onUnitFailed = (unit, attempts) => failures.push({ unit, attempts })
    options.request = async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); calls.push({ stage, attempt, system, input, tokens })
      const payload = JSON.parse(input), value = modelReply(stage, payload)
      if (payload.kind === 'topic-cards-2') {
        if (attempt === 2) {
          assert(system.includes('材料卡c1的证据r1正文不含该摘录'))
          assert(system.includes('根字段只能有cards，不返回completed'))
          assert(system.includes('闭合cards容器后闭合根对象'))
          assert(!system.includes(payload.candidates[0].sources[1].text))
          assert.equal(input, calls.find(call => JSON.parse(call.input).kind === 'topic-cards-2').input)
        }
        value.cards.c1.evidence = [{ ref: corrected && attempt === 2 ? 'r2' : 'r1', text: payload.candidates[0].sources[1].text }]
      }
      return JSON.stringify(value)
    }
    if (corrected) {
      const result = await runGroundedReport(reportData(2), false, options)
      assert.equal(result.audit.recoveries, 1)
      assert.equal(result.audit.topicCards[0].evidence[0].fragment, '2:1')
      assert.equal(result.meta.requestCount, calls.length)
    } else {
      await assert.rejects(runGroundedReport(reportData(2), false, options), /材料卡c1的证据r1正文不含该摘录/)
      assert.equal(failures.length, 1); assert.equal(failures[0].attempts.length, 2)
      assert(!saved.some(row => row.unit.stage === 'selection'))
    }
    assert.equal(calls.filter(call => JSON.parse(call.input).kind === 'topic-cards-2').length, 2)
  }
}

// 重现两轮人物编号泄漏；唯一恢复必须收到具体违规编号，仍非法时不能发布完成产物。
async function checkDisplayAliasRecovery() {
  for (const corrected of [true, false]) {
    const { options, calls, saved } = runnerOptions()
    const failed = []
    options.onUnitFailed = (unit, attempts) => failed.push({ unit, attempts })
    options.request = async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); calls.push({ stage, attempt, system, input, tokens })
      const payload = JSON.parse(input), value = modelReply(stage, payload)
      if (stage === 'overview') {
        assert(payload.members.some(member => member.ref === 'p3'))
        if (attempt === 2) {
          assert(system.includes('检测到：p3'))
          assert(system.includes('结构化引用字段'))
          assert(!system.includes('不应回显的原句'))
          assert.equal(input, calls.find(call => call.stage === 'overview').input)
        }
        value.summary = corrected && attempt === 2 ? '有人交流了安装方案与设置。' : 'p3分享了安装方案，不应回显的原句。'
      }
      return JSON.stringify(value)
    }
    if (corrected) {
      const result = await runGroundedReport(reportData(), false, options)
      assert.equal(result.topics[0].summary, '有人交流了安装方案与设置。')
      assert.equal(result.audit.recoveries, 1)
      assert.equal(result.meta.requestCount, calls.length)
      assert.equal(saved.filter(value => value.unit.stage === 'overview').length, 1)
    } else {
      await assert.rejects(runGroundedReport(reportData(), false, options), /LOCAL_REF_IN_TEXT/)
      assert.equal(saved.filter(value => value.unit.stage === 'overview').length, 0)
      assert.equal(failed.length, 1)
      assert.equal(failed[0].attempts.length, 2)
      assert(failed[0].attempts.every(attempt => attempt.error.includes('检测到：p3')))
    }
    assert.equal(calls.filter(call => call.stage === 'overview').length, 2)
  }
}

// 用真实短计时器触发本地超时，旧Promise清理完后才重发相同请求，迟到正文不得采用。
async function checkOwnedTimeoutCleanup() {
  const order = [], sent = [], saved = [], meta = createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
  let reason
  const value = await requestAnalysisUnit({ deadlineMs: Date.now() + 2000, maxRequestCount: 2,
    shouldRecover: error => error instanceof AnalysisUnitRequestTimeoutError,
    onUnitCompleted(_unit, attempts) { saved.push(...attempts) },
    request: async (system, input, _tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); sent.push({ system, input })
      if (sent.length === 1) return await new Promise(resolve => extra.signal.addEventListener('abort', () => {
        reason = extra.signal.reason; order.push('timeout')
        setTimeout(() => { order.push('cleaned'); resolve('late-invalid') }, 15)
      }, { once: true }))
      order.push('recovery'); assert.deepEqual(order, ['timeout', 'cleaned', 'recovery'])
      return 'valid'
    },
  }, meta, { id: 'owned-timeout', stage: 'compression', sourceIds: [1], timestamps: [] }, 'original-system', 'original-input', 10, 10,
  text => { assert.equal(text, 'valid'); return text })
  assert.equal(value, 'valid'); assert(reason instanceof AnalysisUnitRequestTimeoutError)
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1])
  assert.equal(saved[0].response, ''); assert.equal(saved[1].response, 'valid')
  assert.equal(meta.requestCount, 2); assert.equal(meta.retryCount, 1)
}

// 前台只恢复程序明确超时；仍至多两轮、八次恢复，并在原分析截止停止。
async function checkOwnedTimeoutRunner() {
  for (const mode of ['once', 'twice', 'budget', 'exhausted']) {
    let clock = 0
    const calls = [], options = { deadlineMs: 600000, startedAtMs: 0, workDeadlineMs: 570000, now: () => clock, concurrency: 1,
      request: async (stage, attempt, system, input, _tokens, extra) => {
        extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); calls.push({ stage, attempt, system, input })
        if (stage === 'classification' && (attempt === 1 || mode === 'twice')) {
          if (mode === 'exhausted') clock = 570000
          throw new AnalysisUnitRequestTimeoutError()
        }
        return JSON.stringify(modelReply(stage, JSON.parse(input)))
      } }
    const work = runGroundedReport(reportData(mode === 'budget' ? 600 : 6), false, options)
    if (mode === 'once') {
      const result = await work
      assert.equal(result.audit.recoveries, 1); assert.equal(result.meta.evidence.processedMessageCount, 6)
      const pair = calls.filter(call => call.stage === 'classification')
      assert.equal(pair.length, 2); assert.equal(pair[0].input, pair[1].input); assert.equal(pair[0].system, pair[1].system)
    } else {
      await assert.rejects(work, mode === 'budget' ? /恢复实际调用额度已耗尽/ : /超时/)
      if (mode === 'budget') assert.equal(calls.filter(call => call.attempt === 2).length, 8)
      else assert.equal(calls.length, mode === 'twice' ? 2 : 1)
    }
  }
}

// 千条与四千条从同一正式编排入口走全链，末尾主话题须参与全局而非批内截取。
async function checkLargeRunner() {
  for (const count of [1330, 4000]) {
    const data = reportData(count); data.messages.at(-1).content += 'TAIL_SENTINEL'
    const { options, calls } = runnerOptions('tail-priority')
    const result = await runGroundedReport(data, count === 4000, options)
    assert.equal(result.meta.evidence.processedMessageCount, count)
    assert.equal(result.meta.evidence.unprocessedMessageCount, 0)
    assert.equal(result.meta.evidence.processedFragmentCount, count)
    assert.ok(result.audit.selected.some(candidate => candidate.fragmentIds.includes(count + ':1')))
    assert.ok(calls.some(call => call.stage === 'overview' && call.input.includes('TAIL_SENTINEL')))
    assert.ok(result.meta.requestCount <= 192 && result.audit.recoveries <= 8)
    assert.ok(calls.every(call => Array.from(call.system + call.input).length <= (['grouping', 'selection'].includes(call.stage) ? 32000 : 16000)))
  }
}

// 观测真实计时器，并用注入的任务时钟验证等待过期；不替换系统计时。
async function checkUnitTimersAfterSlot() {
  for (const expireWhileWaiting of [false, true]) {
    const originalSet = global.setTimeout, originalClear = global.clearTimeout, timers = new Set()
    let maximum = 0, activeGrouping = 0, release, failure, result, clock = 0
    const submittedStages = []
    const held = new Promise(resolve => { release = resolve })
    global.setTimeout = (callback, milliseconds, ...args) => {
      const timer = originalSet(() => { timers.delete(timer); callback(...args) }, milliseconds)
      if (milliseconds === 45000) { timers.add(timer); maximum = Math.max(maximum, timers.size) }
      return timer
    }
    global.clearTimeout = timer => { timers.delete(timer); originalClear(timer) }
    const { options } = runnerOptions('quote')
    Object.assign(options, { deadlineMs: 600000, startedAtMs: 0, workDeadlineMs: 570000, now: () => clock })
    options.request = async (stage, attempt, system, input, tokens, extra) => {
      extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); submittedStages.push(stage); const payload = JSON.parse(input)
      if (stage === 'classification') return JSON.stringify({ ...modelReply(stage, payload, 'quote'),
        groups: Object.fromEntries(payload.items.map((item, index) => ['event:' + (index + 1), '具体讨论' + index])),
        records: Object.fromEntries(payload.items.map((item, index) => [item.ref, 'event:' + (index + 1)])) })
      if (payload.kind === 'topic-cards-2') { activeGrouping++; await held; activeGrouping-- }
      return JSON.stringify(modelReply(stage, payload, 'quote'))
    }
    const work = runGroundedReport(reportData(100), true, options).then(value => { result = value }, error => { failure = error })
    try {
      for (let index = 0; index < 50 && activeGrouping < 2; index++) await new Promise(setImmediate)
      assert.equal(activeGrouping, 2); await new Promise(setImmediate)
      assert.equal(timers.size, 2, '尚未获得槽位的模块不能启动单次请求计时器')
      if (expireWhileWaiting) clock = 570000
      release(); await work
      if (expireWhileWaiting) {
        assert(failure, '排队期间超过原模型截止仍须失败')
        assert(!submittedStages.includes('quotes') && !submittedStages.includes('portraits'), '过期等待者不能提交新请求')
      } else {
        if (failure) throw failure
        assert.equal(result.meta.evidence.processedMessageCount, 100); assert.equal(result.audit.recoveries, 0)
      }
      assert(maximum <= 2); assert.equal(timers.size, 0)
    } finally { release(); await work; global.setTimeout = originalSet; global.clearTimeout = originalClear }
  }
}

// 上游实际在途槽不随外层取消提前释放，等待者取消后不再运行。
async function checkActualRequestPool() {
  const pool = new ReportRequestPool(1), controller = new AbortController(), order = []
  let finish
  const first = pool.run(controller.signal, () => new Promise(resolve => { finish = () => { order.push('cleaned'); resolve('ok') } }))
  await new Promise(resolve => setImmediate(resolve))
  const waiting = pool.run(controller.signal, async () => { order.push('unexpected'); return 'bad' })
  const waitingFailure = assert.rejects(waiting, /cancel/)
  controller.abort(new Error('cancel'))
  let drained = false; const drain = pool.drain().then(() => { drained = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  finish(); await first; await waitingFailure; await drain
  assert.deepEqual(order, ['cleaned']); assert.equal(drained, true)
}

// 当前正式入口注册全部关键行为，模型真实回放仍是后续独立门槛。
// 无完成字段的两类单元必须见证真实正常结束，闭合正文不能替代未知或异常结束。
async function checkNormalFinishContract() {
  for (const ending of [undefined, { finishReason: null, finishReasonReadable: false }, { finishReason: 'content_filter', finishReasonReadable: true }, { finishReason: 'length', finishReasonReadable: true }]) {
    let calls = 0, saved = 0; const failures = []
    const meta = createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
    await assert.rejects(requestAnalysisUnit({ deadlineMs: Date.now() + 60000, requireNormalFinish: true,
      request: async (_s, _i, _t, extra) => { extra._onRequestAttempt(); calls++; if (ending) extra._onRequestExecution(ending); return '{"items":[]}' },
      onUnitCompleted() { saved++ }, onUnitFailed(_unit, attempts) { failures.push(...attempts) } }, meta,
    { id: 'normal-finish', stage: 'quotes', sourceIds: [1], timestamps: [] }, '完整对象', '{}', 2048, 1000, JSON.parse), /MODEL_UNFINISHED|MODEL_TRUNCATED/)
    assert.equal(calls, 2); assert.equal(saved, 0); assert.equal(failures.length, 2)
    assert(failures.every(attempt => attempt.response === '{"items":[]}'))
  }
  const meta = createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
  const result = await requestAnalysisUnit({ deadlineMs: Date.now() + 60000, requireNormalFinish: true,
    request: async (_s, _i, _t, extra) => { extra._onRequestAttempt(); extra._onRequestExecution({ finishReason: 'stop', finishReasonReadable: true }); return '{"items":[]}' } }, meta,
  { id: 'normal-finish', stage: 'quotes', sourceIds: [1], timestamps: [] }, '完整对象', '{}', 2048, 1000, JSON.parse)
  assert.deepEqual(result, { items: [] }); assert.equal(meta.requestCount, 1)
}

async function runReportRunnerTests(check) {
  for (const [label, run] of [['新编排四模块独立供料、一话题及完整来源账本', checkCompleteRunner], ['新编排零消息、纯图片及短互动合法空状态', checkRunnerEmptyStates],
    ['非事件互动独立进入完整选题且可入选，具体回应参与跨批整理', checkIndependentInteractionSelection],
    ['全文卡片中段证据、五十项共同目录与一次全局选题', checkGlobalRepresentativeSelection],
    ['目录两层不收敛时容量失败，全部卡片仍进入且无分批淘汰', checkCatalogCapacityFailure],
    ['新编排长正文尾片段、分段概述与普通模式', checkLongRunner], ['新编排唯一补漏及隐藏重试拒绝', checkRunnerRecovery],
    ['本地超时等待真实清理、原输入唯一恢复且拒绝迟到正文', checkOwnedTimeoutCleanup], ['前台本地超时恢复仍遵守两轮/八次/原截止', checkOwnedTimeoutRunner],
    ['局部编号错误进入唯一恢复，仍非法时两次准确失败且不发布', checkDisplayAliasRecovery],
    ['卡片证据错配明确反馈c/r及根结构，一次恢复仍非法则失败', checkCardEvidenceRecovery],
    ['新编排真实使用稳定目录的4000条供料，跨群目录零请求拒绝', checkCatalogRunner],
    ['取得实际槽位后才启动45秒计时，排队不消耗单次时限', checkUnitTimersAfterSlot],
    ['新编排1330/4000条完整处理、全局尾部选题及实际输入预算', checkLargeRunner], ['实际请求槽取消等待并等真实清理', checkActualRequestPool],
    ['取消模型自报完成后真实结束可读且正常，未知/异常/截断两次准确失败', checkNormalFinishContract]]) {
    try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportRunnerTests }
