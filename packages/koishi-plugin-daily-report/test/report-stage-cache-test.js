/** 真实文件的全阶段缓存与当前人物重绑；外部模型只使用固定返回。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { withPagedStoreFixture, listPagedStoreFiles } = require('./helpers/report-store-fixture')
const { createReportEvidence } = require('../lib/report-evidence')
const { saveReportSnapshot } = require('../lib/report-snapshots')
const { updateReportBatchCatalog } = require('../lib/report-batch-catalog')
const { runGroundedReport } = require('../lib/report-runner')
const { ReportRequestBoundaryError } = require('../lib/report-request-pool')
const { createTopicContext, createTopicOverviewMergeContext, getTopicInstructions, readTopicOverview,
  createTopicCardContext, getTopicCatalogInstructions, readTopicCards, createTopicCatalogContext, readTopicCatalogSelection } = require('../lib/report-topics')
const { createGroundedOutputContext, getGroundedOutputInstructions, readGroundedQuotes } = require('../lib/report-outputs')
const { requestAnalysisUnit } = require('../lib/complete-input')
const { bindTopicStageRequest, bindOutputStageRequest, verifyReportStageOrigin } = require('../lib/report-stage-bindings')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = loadManagementModule('daily.reportPeriod')
const { createReportAnalysisDiagnostics } = loadManagementModule('daily.reportAnalysis')
const stageCachePath = require.resolve('../lib/report-stage-cache'), classificationPath = require.resolve('../lib/report-classification-cache')
const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))

// 固定政策模拟当前公开的单节点身份，不读取配置或凭据。
function stageFixtureDigest(value) { return crypto.createHash('sha256').update(value).digest('hex') }

// 所有阶段明确首轮和恢复节点，不用分类阶段的路线冒充独立输出实际来源。
function stageFixturePolicies() {
  const node = name => ({ routeIdentity: stageFixtureDigest(name), routeRevision: stageFixtureDigest('revision-' + name), provider: 'dashscope', model: name, protocol: 'openai-chat' })
  const quick = node('qwen3.5-omni-flash'), general = node('qwen3.5-plus')
  return { classification: { identity: stageFixtureDigest('classification-policy'), first: quick, recovery: general },
    stages: Object.fromEntries(['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review'].map(stage => [stage,
      { identity: stageFixtureDigest('stage-policy-' + stage), first: ['grouping', 'selection'].includes(stage) ? quick : general, recovery: general }])) }
}

// 三位同名成员各有本人原话，三个讨论段保证整理和独立模块均实际执行。
function stageFixtureMessages(count = 12) {
  return Array.from({ length: count }, (_, index) => ({ messageId: 'permanent-' + index, realMessageId: true, userId: 'member-' + index % 3,
    user: '同名群友', ts: period.periodStartMs + 1000 + index * 100, time: '04:00', content: '本人原话  😀' + index }))
}

// 固定返回仍须通过全部实际读取器，错误恢复、调用计数和落盘均使用生产代码。
function stageFixtureModel(policies, mode = 'normal') {
  const calls = []
  const request = async (stage, attempt, _system, input, _tokens, extra) => {
    const policy = stage === 'classification' ? policies.classification : policies.stages[stage], node = attempt === 1 ? policy.first : policy.recovery
    const step = { ...node, stepIndex: 0, priorityIndex: 0, configurationIdentity: stageFixtureDigest(node.routeIdentity + node.model) }
    const usage = { readable: true, promptTokens: 100, completionTokens: 20, totalTokens: 120 }
    extra._onRequestAttempt(step)
    if (attempt === 1 && ((mode === 'transient-classification' && stage === 'classification') || (mode === 'transient-quotes' && stage === 'quotes'))) {
      calls.push({ stage, attempt, input })
      throw new ReportRequestBoundaryError('upstream', '上游连接超时', { code: 'HTTP_502', status: 502, retryable: true })
    }
    extra._onRequestUsage(usage)
    extra._onRequestExecution({ ...step, modelVersion: null, modelVersionReadable: false,
      finishReason: mode === 'card-finish-repair' && JSON.parse(input).kind === 'topic-cards-9' && attempt === 1 ? 'content_filter' : mode === 'truncated-overview' && stage === 'overview' && attempt === 1 ? 'length' : 'stop', finishReasonReadable: true, usage })
    calls.push({ stage, attempt, input })
    const payload = JSON.parse(input)
    if (stage === 'classification') return JSON.stringify({ groups: Object.fromEntries(payload.items.map((_, index) => [mode === 'insufficient' ? 'social:1' : 'event:' + ((mode === 'global-selection' ? index : Math.floor(index / (mode === 'many-split-cards' ? 6 : 4))) + 1), '测试讨论'])), records: Object.fromEntries(payload.items.map((item, index) => [item.ref,
      mode === 'insufficient' ? 'social:1' : 'event:' + ((mode === 'global-selection' ? index : Math.floor(index / (mode === 'many-split-cards' ? 6 : 4))) + 1)])),
      quotes: payload.items.slice(0, 3).map(item => ({ kind: 'quote', ref: item.ref, criterion: 'distinct_expression' })), completed: true })
    // 固定旧协议仅用于真实文件身份隔离测试，返回原已知的对象式证据。
    if (payload.kind === 'topic-cards-6') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => [candidate.ref,
      [{ refs: candidate.refs, status: 'ok', scope: '实际讨论', evidence: [{ ref: candidate.sources[0].ref, text: candidate.sources[0].text }] }]])) })
    if (payload.kind === 'topic-cards-9') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.filter((_, index) => mode !== 'card-repair' || attempt !== 1 || index < payload.candidates.length - 1).map((candidate, index) => {
      const source = candidate.sources[0], ok = mode !== 'insufficient'
      if (mode === 'many-split-cards') return [candidate.ref, candidate.sources.map(entry => ({ refs: [entry.ref], status: 'ok',
        scope: '独立具体讨论', evidence: [entry.ref] }))]
      if (mode === 'split-cards' && candidate.sources.length >= 2) return [candidate.ref, [candidate.sources.slice(0, 1), candidate.sources.slice(1)].map(sources => ({
        refs: sources.map(entry => entry.ref), status: 'ok', scope: '实际子问题', evidence: [sources[0].ref] }))]
      const omit = (mode === 'card-core-repair' && attempt === 1)
        || (mode === 'unassigned-core' && payload.candidates.reduce((sum, value) => sum + value.refs.length, 0) >= 20)
      const refs = omit && candidate === payload.candidates.at(-1) ? candidate.refs.slice(0, -1) : candidate.refs
      const evidence = mode === 'multi-evidence' ? candidate.refs.slice(0, 3) : [source.ref]
      if (mode === 'tolerant-cards') return [candidate.ref, [{ refs: candidate.refs, status: 'ok', scope: '实际讨论',
        evidence: [...candidate.sources.map(entry => ({ ref: entry.ref, text: entry.text })), source.ref] },
        { refs: [], status: 'insufficient', scope: '', evidence: [] }]]
      if (mode === 'card-evidence-repair' && attempt === 1) evidence[0] = payload.candidates[(index + 1) % payload.candidates.length].refs[0]
      return [candidate.ref, [{ refs, status: ok ? 'ok' : 'insufficient', scope: ok ? '实际讨论' : '',
        evidence: ok ? evidence : [] }]]
    })) })
    if (stage === 'grouping') return JSON.stringify({ groups: mode === 'long-overview' && payload.candidates.length > 1 ? [{ refs: payload.candidates.map(candidate => candidate.ref),
      scope: '实际讨论', representatives: [payload.candidates[0].ref] }] : [], completed: true })
    if (payload.kind === 'topic-selection-4') return JSON.stringify({ selected: ['c' + payload.candidates.length], completed: true })
    if (payload.kind === 'topic-selection-3') return JSON.stringify({ selected: payload.candidates.slice(0, payload.displayLimit).map(candidate => candidate.ref), completed: true })
    if (stage === 'overview') return JSON.stringify({ title: mode === 'truncated-overview' && attempt === 1 ? '不得采用截断返回' : '中性话题概述',
      summary: '围绕本期实际问题展开了讨论。', refs: [payload.sources[0].ref], completed: true })
    if (stage === 'quotes') return JSON.stringify(mode === 'insufficient' ? { items: [] }
      : { items: payload.sources.filter(source => source.role === 'primary').slice(0, 3).map(source => ({ ref: source.ref, comment: '' })) })
    if (stage === 'portraits') {
      let members = payload.members.map(member => mode === 'insufficient' ? { member: member.ref, status: 'insufficient', title: '', description: '', refs: [] }
        : { member: member.ref, status: 'ok', title: '', description: '参与了本期可见讨论。', refs: member.refs.slice(0, 1) })
      if (mode === 'portrait-repair' && attempt === 1) members = members.slice(0, -1)
      return JSON.stringify({ members, completed: true })
    }
    if (stage === 'review') return JSON.stringify(mode === 'insufficient' ? { status: 'insufficient', title: '', dimensions: [], summary: '', refs: [], statRefs: [], completed: true }
      : { status: 'ok', title: '本期互动', dimensions: [{ name: '讨论', percentage: 0, comment: '围绕可见材料交流。', refs: [payload.sources[0].ref], statRefs: ['s3'] }],
        summary: '有本期实际互动。', refs: [payload.sources[0].ref], statRefs: [], completed: true })
    throw new Error('未知阶段')
  }
  return { calls, request }
}

// 模块错误类型和数据根与本次真实文件夹具一致，离开后完全恢复。
async function withStageCacheFixture(run) {
  await withPagedStoreFixture(async fixture => {
    const oldStage = require.cache[stageCachePath], oldClassification = require.cache[classificationPath]
    delete require.cache[stageCachePath]; delete require.cache[classificationPath]
    try { await run({ ...fixture, StageCache: require(stageCachePath).ReportStageCache, ClassificationCache: require(classificationPath).ReportClassificationCache }) } finally {
      if (oldStage) require.cache[stageCachePath] = oldStage; else delete require.cache[stageCachePath]
      if (oldClassification) require.cache[classificationPath] = oldClassification; else delete require.cache[classificationPath]
    }
  })
}

// 每个新任务读取当前完整原话，固定新截止；缓存只是之后的匹配步骤。
function prepareStageTask(fixture, id, messages, policies, mode = 'normal', changes = {}) {
  const currentPeriod = createReportPeriod(period.cutoffMs + (changes.cutoffOffset || 0)), snapshot = createReportEvidence(messages)
  const activeMembers = changes.activeMembers || 3, context = { period: currentPeriod, sourceCompleteness: 'complete', statistics: { totalMessages: messages.length, activeMembers } }
  const directory = changes.directory || updateReportBatchCatalog(null, snapshot, { channelKey: 'group-A', period: currentPeriod,
    nowMs: period.periodStartMs + 600000, sourceCompleteness: 'complete', inputScope: 'full_business_window' })
  const store = fixture.store(id), snapshotCommit = saveReportSnapshot(store, snapshot, context), diagnostics = []
  const options = { store, snapshot, snapshotCommit, context, onDiagnostic(code, commitId, message) { diagnostics.push({ code, commitId, message }) } }
  const classificationCache = new fixture.ClassificationCache({ ...options, policy: policies.classification })
  const stageCache = new fixture.StageCache({ ...options, policies: policies.stages }), model = stageFixtureModel(policies, mode)
  return { store, snapshot, snapshotCommit, directory, diagnostics, model, options: { taskId: id, deadlineMs: store.taskIdentity.deadlineMs,
    startedAtMs: fixture.state.now, now: () => fixture.state.now, concurrency: 2, request: model.request,
    classificationCatalog: { channelKey: 'group-A', value: directory }, classificationCache, stageCache },
    data: { messages, reportPeriod: currentPeriod, sourceCompleteness: 'complete', totalMessages: messages.length, activeMembers } }
}

// 单元存储边界用正式请求入口产生真实尝试记录；不跳过实际读取器来构造成功缓存。
async function executeFixtureStageUnit(task, descriptor, validate) {
  let round = 0
  const diagnostics = createReportAnalysisDiagnostics({ selectedMessageCount: task.snapshot.sources.length, windowMessageCount: task.snapshot.sources.length,
    sourceCompleteness: 'complete', reportPeriod: task.data.reportPeriod })
  return requestAnalysisUnit({ deadlineMs: task.options.deadlineMs, now: task.options.now, requireNormalFinish: descriptor.requireNormalFinish,
    request: (system, input, tokens, extra) => task.model.request(descriptor.stage, ++round, system, input, tokens, extra),
    onUnitCompleted(_unit, attempts, value) { task.options.stageCache.save(task.snapshot, descriptor, attempts, value, validate) } }, diagnostics,
  { id: 'fixed-stage-unit', stage: descriptor.stage, sourceIds: task.snapshot.sources.map(source => source.sourceId), timestamps: [] },
  descriptor.system, descriptor.input, descriptor.maxTokens, 45000, validate)
}

// 每项都执行真实文件检查，模型的语义质量和真实时延仍须另行验收。
async function stageCacheCase(check, name, run) {
  try { await withStageCacheFixture(run); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 紧凑目录仍经实际文件校验，隐式行号在新任务恢复当前候选，不能串用普通对象协议。
async function runCompactCatalogStageCacheTest(check) {
  await stageCacheCase(check, '紧凑六百项目录实际缓存零请求重绑末项，原对象协议不误命中', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(3), cold = prepareStageTask(fixture, 'compact-cold', messages, policies)
    const cards = (snapshot, prefix) => Array.from({ length: 600 }, (_, index) => {
      const fragment = snapshot.fragments[index % 3]
      return { status: 'ok', scope: '独立具体讨论' + index, leaves: [prefix + index], candidate: { id: prefix + index, fragments: [fragment] },
        evidence: [{ fragment, text: fragment.text, excerptOnly: true, truncated: false, sourceCharacters: Array.from(fragment.text).length }] }
    })
    const original = cards(cold.snapshot, 'old-'), context = createTopicCatalogContext(cold.snapshot, original, 10, true)
    assert.equal(JSON.parse(context.input).candidates.length, 600)
    const descriptor = { stage: 'selection', mode: 'detailed', system: getTopicCatalogInstructions('selection'), input: context.input,
      maxTokens: 4096, bindings: bindTopicStageRequest(cold.snapshot, context, cold.snapshot.fragments) }
    await executeFixtureStageUnit(cold, descriptor, text => readTopicCatalogSelection(text, context, 10))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'compact-hot', messages.map(message => ({ ...message, user: '当前昵称' })), policies)
    const current = cards(hot.snapshot, 'current-'), rebuilt = createTopicCatalogContext(hot.snapshot, current, 10, true)
    assert.equal(rebuilt.input, context.input)
    const bindings = bindTopicStageRequest(hot.snapshot, rebuilt, hot.snapshot.fragments)
    const hit = hot.options.stageCache.read(hot.snapshot, { ...descriptor, bindings }, text => readTopicCatalogSelection(text, rebuilt, 10))
    assert(hit); assert.equal(hit.value[0].id, 'current-599'); assert.equal(hit.value[0].fragments[0], hot.snapshot.fragments[2])
    assert.equal(hot.model.calls.length, 0)
    const ordinary = createTopicCatalogContext(hot.snapshot, current, 10)
    assert.equal(hot.options.stageCache.read(hot.snapshot, { ...descriptor, input: ordinary.input, bindings }, text => readTopicCatalogSelection(text, ordinary, 10)), null)
  })
}

// 覆盖同任务编排、模式隔离、恢复、摘要依据、损坏失效和当前成员恢复。
async function runReportStageCacheTests(check) {
  await runCompactCatalogStageCacheTest(check)
  await stageCacheCase(check, '临时5xx恢复完成但缺首轮执行证明不发布可信缓存，后续新任务只重算该模块', async fixture => {
    const policies = stageFixturePolicies()
    for (const stage of ['classification', 'quotes']) {
      const messages = stageFixtureMessages(12).map(message => ({ ...message, content: message.content + ' ' + stage }))
      const cold = prepareStageTask(fixture, 'transient-' + stage, messages, policies, 'transient-' + stage)
      const first = await runGroundedReport(cold.data, true, cold.options)
      assert.equal(first.meta.retryCount, 1)
      assert(cold.diagnostics.some(value => value.code === 'actual_model_unverified'))
      fixture.state.now++
      const hot = prepareStageTask(fixture, 'transient-hot-' + stage, messages, policies, 'normal', { directory: cold.directory })
      const second = await runGroundedReport(hot.data, true, hot.options)
      assert.equal(hot.model.calls.length, 1); assert.equal(hot.model.calls[0].stage, stage)
      assert.equal(second.meta.evidence.processedMessageCount, 12)
      fixture.state.now++
    }
  })
  await stageCacheCase(check, '已知容器错层及空未知父经真实缓存保留原返回、告警与当前来源', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(12)
    const cold = prepareStageTask(fixture, 'container-cold', messages, policies)
    const request = cold.options.request
    cold.options.request = async (...args) => {
      const text = await request(...args)
      if (JSON.parse(args[3]).kind !== 'topic-cards-9') return text
      const entries = Object.entries(JSON.parse(text).cards), first = entries.shift()
      return JSON.stringify({ cards: { [first[0]]: first[1], c999: [] }, ...Object.fromEntries(entries) })
    }
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.audit.recoveries, 0); assert.equal(first.audit.topicCards.length, 3)
    assert.equal(first.audit.topicCards[0].formatWarnings[0].code, 'ignored_empty_unknown_parent')
    assert(first.audit.topicCards.slice(1).every(card => card.formatWarnings[0].code === 'misplaced_parent_container'))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'container-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.equal(second.meta.evidence.deepReadMessageCount, 12); assert.deepEqual(second.audit.selected, first.audit.selected)
  })
  await stageCacheCase(check, '少量未归类来源审计与警告保留，实际缓存重放不猜语义归属且零新请求', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(60)
    const cold = prepareStageTask(fixture, 'unassigned-cold', messages, policies, 'unassigned-core')
    const first = await runGroundedReport(cold.data, true, cold.options)
    const unassigned = first.audit.topicCards.flatMap(card => card.unassignedFragmentIds || [])
    assert.deepEqual(unassigned, ['48:1']); assert.equal(first.audit.recoveries, 0)
    assert(first.audit.topicCards.every(card => !card.fragmentIds.includes('48:1')))
    assert(first.meta.warnings.some(warning => warning.includes('1条原文已完成分类但未归入话题卡')))
    assert.equal(new Set(first.audit.topicCards.flatMap(card => [...card.fragmentIds, ...(card.unassignedFragmentIds || [])])).size, 60)
    assert(!first.audit.selected.some(candidate => candidate.fragmentIds.includes('48:1')))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'unassigned-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.deepEqual(second.meta.warnings, first.meta.warnings); assert.deepEqual(second.audit.selected, first.audit.selected)
  })
  await stageCacheCase(check, '已知格式告警经实际缓存重放保留，原回包不改且全部来源按新任务重绑', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(12)
    const cold = prepareStageTask(fixture, 'tolerant-cold', messages, policies, 'tolerant-cards')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.audit.recoveries, 0); assert.equal(first.audit.topicCards.length, 3)
    assert(first.audit.topicCards.every(card => card.fragmentIds.length === 4 && card.evidence.length === 3))
    assert(first.audit.topicCards.every(card => card.formatWarnings.length === 3))
    assert.equal(new Set(first.audit.topicCards.flatMap(card => card.fragmentIds)).size, 12)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'tolerant-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.equal(second.meta.evidence.deepReadMessageCount, 12)
    assert.deepEqual(second.audit.selected, first.audit.selected)
  })
  await stageCacheCase(check, '旧对象式证据缓存不能命中新引用协议，真实新任务重绑摘录零请求复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(4)
    const cold = prepareStageTask(fixture, 'reference-evidence-cold', messages, policies)
    const candidates = [{ id: 'first', fragments: cold.snapshot.fragments.slice(0, 2) }, { id: 'second', fragments: cold.snapshot.fragments.slice(2) }]
    const current = createTopicCardContext(cold.snapshot, candidates)
    const legacy = { ...current, input: JSON.stringify({ ...JSON.parse(current.input), kind: 'topic-cards-6' }) }
    const previousReply = { cards: Object.fromEntries(JSON.parse(legacy.input).candidates.map(candidate => [candidate.ref,
      [{ refs: candidate.refs, status: 'ok', scope: '实际讨论', evidence: [{ ref: candidate.sources[0].ref, text: candidate.sources[0].text }] }]])) }
    const previousCards = candidates.map(candidate => ({ candidate: { ...candidate, scopeHints: ['实际讨论'], cardRange: '实际讨论' },
      parentId: candidate.id, leaves: [candidate.id], status: 'ok', scope: '实际讨论', evidence: [{ fragment: candidate.fragments[0], text: candidate.fragments[0].text }] }))
    // 保存旧版身份与产物作隔离对照；可容错读取不代表旧请求自动命中新请求。
    const readPrevious = text => { assert.deepEqual(JSON.parse(text), previousReply); return previousCards }
    const descriptor = { stage: 'selection', mode: 'detailed', system: '受控旧topic-cards-6固定协议', input: legacy.input,
      maxTokens: 4096, requireNormalFinish: true, bindings: bindTopicStageRequest(cold.snapshot, legacy, cold.snapshot.fragments) }
    await executeFixtureStageUnit(cold, descriptor, readPrevious)
    assert(readTopicCards(JSON.stringify(previousReply), current).every(card => card.formatWarnings[0].code === 'legacy_evidence_object'))
    const revised = { ...descriptor, system: getTopicCatalogInstructions('cards'), input: current.input,
      bindings: bindTopicStageRequest(cold.snapshot, current, cold.snapshot.fragments) }
    assert.equal(cold.options.stageCache.read(cold.snapshot, revised, text => readTopicCards(text, current)), null)
    await executeFixtureStageUnit(cold, revised, text => readTopicCards(text, current))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'reference-evidence-hot', messages, policies, 'normal', { directory: cold.directory })
    const rebound = createTopicCardContext(hot.snapshot, candidates.map(candidate => ({ ...candidate,
      fragments: candidate.fragments.map(fragment => hot.snapshot.byFragmentId.get(fragment.id)) })))
    const hit = hot.options.stageCache.read(hot.snapshot, { ...revised, input: rebound.input,
      bindings: bindTopicStageRequest(hot.snapshot, rebound, hot.snapshot.fragments) }, text => readTopicCards(text, rebound))
    assert(hit); assert.equal(hot.model.calls.length, 0)
    assert(hit.value.every(card => card.evidence.every(entry => entry.excerptOnly && entry.fragment === hot.snapshot.byFragmentId.get(entry.fragment.id))))
  })
  await stageCacheCase(check, '多条原文证据经正式编排与目录保留，当前人物重绑和新任务零请求复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(12)
    const cold = prepareStageTask(fixture, 'multi-evidence-cold', messages, policies, 'multi-evidence')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.audit.topicCards.length, 3)
    assert(first.audit.topicCards.every(card => card.evidence.length === 3))
    const directoryCall = cold.model.calls.find(call => JSON.parse(call.input).kind === 'topic-directory-3')
    assert(JSON.parse(directoryCall.input).candidates.every(candidate => candidate.evidence.length === 3))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'multi-evidence-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.deepEqual(second.audit.selected, first.audit.selected)
    assert.equal(second.meta.evidence.deepReadMessageCount, 12)
  })
  await stageCacheCase(check, '每父六子卡共享整批24上限，正式目录／最终深读与新任务零请求重放', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(24)
    const cold = prepareStageTask(fixture, 'many-split-cold', messages, policies, 'many-split-cards')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.audit.topicCards.length, 24)
    const counts = new Map()
    for (const card of first.audit.topicCards) counts.set(card.parentId, (counts.get(card.parentId) || 0) + 1)
    assert.deepEqual([...counts.values()], [6, 6, 6, 6])
    assert.equal(new Set(first.audit.topicCards.flatMap(card => card.fragmentIds)).size, 24)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'many-split-hot', messages, policies, 'many-split-cards', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.deepEqual(second.audit.selected, first.audit.selected)
    assert.equal(second.meta.evidence.deepReadMessageCount, first.meta.evidence.deepReadMessageCount)
  })
  await stageCacheCase(check, '漏核心父完整重制一次，实际缓存定向重放与新任务零请求保持完整来源', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(12)
    const cold = prepareStageTask(fixture, 'card-core-cold', messages, policies, 'card-core-repair')
    const first = await runGroundedReport(cold.data, false, cold.options)
    const calls = cold.model.calls.filter(call => JSON.parse(call.input).kind === 'topic-cards-9')
    assert.equal(calls.length, 2); assert.equal(first.audit.recoveries, 1)
    const initial = JSON.parse(calls[0].input), repaired = JSON.parse(calls[1].input)
    assert.deepEqual(repaired.requiredCandidateRefs, [initial.candidates.at(-1).ref])
    assert.deepEqual(repaired.candidates, [initial.candidates.at(-1)]); assert.equal(repaired.maxCards, 22)
    assert.equal(new Set(first.audit.topicCards.flatMap(card => card.fragmentIds)).size, 12)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'card-core-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert(second.audit.stageCache.length > 0)
  })
  await stageCacheCase(check, '子卡父身份与来源经实际全编排缓存重放，新任务零请求保持子范围', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(12)
    const cold = prepareStageTask(fixture, 'split-cards-cold', messages, policies, 'split-cards')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.audit.topicCards.length, 6)
    assert.equal(cold.model.calls.filter(call => JSON.parse(call.input).kind === 'topic-cards-9').length, 1)
    assert(first.audit.topicCards.every(card => card.parentId && card.fragmentIds.length < 4))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'split-cards-hot', messages, policies, 'split-cards', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0)
    assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
    assert.deepEqual(second.audit.selected, first.audit.selected)
    assert.equal(second.meta.evidence.deepReadMessageCount, 12)
  })
  await stageCacheCase(check, '卡片局部上下文使旧供料失效，新请求真实文件零调用复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(30)
    const cold = prepareStageTask(fixture, 'card-local-old', messages, policies)
    const candidates = [{ id: 'first', fragments: [cold.snapshot.fragments[4]] }, { id: 'second', fragments: [cold.snapshot.fragments[24]] }]
    const legacy = createTopicContext(cold.snapshot, candidates, 'inline')
    legacy.input = JSON.stringify({ kind: 'topic-cards-9', supply: 'candidate-inline-unhinted-2', ...JSON.parse(legacy.input),
      requiredCandidateRefs: [...legacy.candidates.keys()], candidateCount: legacy.candidates.size })
    const provenance = candidates.flatMap(candidate => candidate.fragments)
    const descriptor = { stage: 'selection', mode: 'detailed', system: getTopicCatalogInstructions('cards'), input: legacy.input,
      maxTokens: 4096, requireNormalFinish: true, bindings: bindTopicStageRequest(cold.snapshot, legacy, provenance) }
    await executeFixtureStageUnit(cold, descriptor, text => readTopicCards(text, legacy))
    const current = createTopicCardContext(cold.snapshot, candidates)
    const revised = { ...descriptor, input: current.input, bindings: bindTopicStageRequest(cold.snapshot, current, provenance) }
    assert.equal(cold.options.stageCache.read(cold.snapshot, revised, text => readTopicCards(text, current)), null)
    await executeFixtureStageUnit(cold, revised, text => readTopicCards(text, current))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'card-local-hot', messages, policies, 'normal', { directory: cold.directory })
    const rebound = createTopicCardContext(hot.snapshot, candidates.map(candidate => ({ ...candidate,
      fragments: candidate.fragments.map(fragment => hot.snapshot.byFragmentId.get(fragment.id)) })))
    const hit = hot.options.stageCache.read(hot.snapshot, { ...revised, input: rebound.input,
      bindings: bindTopicStageRequest(hot.snapshot, rebound, [...rebound.sources.values()].flat()) }, text => readTopicCards(text, rebound))
    assert(hit); assert.equal(hit.value.length, 2); assert.equal(hot.model.calls.length, 0)
    assert(hit.value.every(card => card.candidate.fragments.every(fragment => hot.snapshot.byFragmentId.get(fragment.id) === fragment)))
  })
  await stageCacheCase(check, '新卡片正常结束是缓存身份条件，非正常首轮仅整输入恢复且下次零请求', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'card-finish-cold', messages, policies, 'card-finish-repair')
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(first.audit.recoveries, 1)
    const selected = cold.store.list('unit').candidates.filter(unit => unit.metadata.stage === 'selection')
      .map(unit => cold.store.inspect(unit.id, 'unit', () => {})).find(unit => unit.records.some(row => row.type === 'exchange' && row.value.recovery === 'full'))
    assert(selected); assert.equal(selected.metadata.actualAttempts[0].execution.finishReason, 'content_filter')
    assert.equal(selected.metadata.actualAttempts[1].execution.finishReason, 'stop')
    assert.equal(selected.records.find(row => row.type === 'exchange').value.responses.length, 1)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'card-finish-hot', messages, policies, 'normal', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
  })
  await stageCacheCase(check, '卡片证据非法整输入唯一恢复后只存合法交换，下一任务零请求复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'card-evidence-cold', messages, policies, 'card-evidence-repair')
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(first.audit.recoveries, 1)
    const selected = cold.store.list('unit').candidates.filter(unit => unit.metadata.stage === 'selection')
      .map(unit => cold.store.inspect(unit.id, 'unit', () => {})).find(unit => unit.records.some(row => row.type === 'exchange' && row.value.recovery === 'full'))
    assert(selected)
    const exchange = selected.records.find(row => row.type === 'exchange').value
    assert.equal(exchange.responses.length, 1)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'card-evidence-hot', messages, policies, 'card-evidence-repair', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
  })
  await stageCacheCase(check, '材料卡合法缺漏只补候选全文，首轮与恢复可信交换新任务零请求复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'card-repair-cold', messages, policies, 'card-repair')
    const first = await runGroundedReport(cold.data, false, cold.options)
    const calls = cold.model.calls.filter(call => JSON.parse(call.input).kind === 'topic-cards-9')
    assert.equal(calls.length, 2)
    const initial = JSON.parse(calls[0].input), repaired = JSON.parse(calls[1].input)
    assert.equal(repaired.candidates.length, 1)
    assert.deepEqual(repaired.requiredCandidateRefs, [initial.candidates.at(-1).ref])
    assert(repaired.candidates[0].sources.every(source => initial.candidates.at(-1).refs.includes(source.ref)))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'card-repair-hot', messages, policies, 'card-repair', { directory: cold.directory })
    const second = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.deepEqual(second.topics, first.topics)
    assert.deepEqual(second.audit.topicCards, first.audit.topicCards)
  })
  await stageCacheCase(check, '完整目录绑定卡片文字及全部永久来源，新任务实际零请求复用', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(24)
    const cold = prepareStageTask(fixture, 'global-comparison-cold', messages, policies, 'global-selection')
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert(cold.model.calls.some(call => JSON.parse(call.input).kind === 'topic-selection-3'))
    const comparisons = cold.store.list('unit').candidates.filter(unit => unit.metadata.stage === 'selection')
      .map(unit => cold.store.inspect(unit.id, 'unit', () => {})).filter(unit => unit.records[0]?.material === 'topic-summary')
    assert(comparisons.length > 0)
    for (const unit of comparisons) {
      const source = unit.records.find(row => row.type === 'source' && row.value.role === 'summary').value
      assert.equal(source.range, null); assert(source.textIdentity)
    }
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'global-comparison-hot', messages, policies, 'global-selection')
    const second = await runGroundedReport(hot.data, false, hot.options)
    assert.deepEqual(second.topics, first.topics); assert.equal(hot.model.calls.length, 0)
    assert.equal(second.meta.evidence.processedMessageCount, 24)
  })
  await stageCacheCase(check, '范围提示纳入实际请求身份，原文相同但提示变更不能复用旧阶段', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'scope-cold', messages, policies)
    const candidate = { id: 'scope', fragments: cold.snapshot.fragments.slice(0, 2), scopeHints: ['机制讨论'] }
    const context = createTopicContext(cold.snapshot, [candidate])
    const descriptor = { stage: 'overview', mode: 'detailed', system: getTopicInstructions('overview'), input: context.input, maxTokens: 2048,
      bindings: bindTopicStageRequest(cold.snapshot, context, candidate.fragments) }
    await executeFixtureStageUnit(cold, descriptor, text => readTopicOverview(text, context))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'scope-hot', messages, policies)
    const same = createTopicContext(hot.snapshot, [{ ...candidate, fragments: hot.snapshot.fragments.slice(0, 2) }])
    const unchanged = { ...descriptor, input: same.input, bindings: bindTopicStageRequest(hot.snapshot, same, hot.snapshot.fragments.slice(0, 2)) }
    assert(hot.options.stageCache.read(hot.snapshot, unchanged, text => readTopicOverview(text, same)))
    const changed = createTopicContext(hot.snapshot, [{ id: 'scope', fragments: hot.snapshot.fragments.slice(0, 2), scopeHints: ['另一个待核实问题'] }])
    const revised = { ...descriptor, input: changed.input, bindings: bindTopicStageRequest(hot.snapshot, changed, hot.snapshot.fragments.slice(0, 2)) }
    assert.equal(hot.options.stageCache.read(hot.snapshot, revised, text => readTopicOverview(text, changed)), null)
    assert.equal(hot.model.calls.length, 0)
  })
  await stageCacheCase(check, '详细版所有阶段及已知未编码旧单元真实文件复用，零请求且按当前昵称恢复', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'all-stages-cold', messages, policies)
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert(['classification', 'grouping', 'selection', 'overview', 'quotes', 'portraits', 'review'].every(stage => cold.model.calls.some(call => call.stage === stage)))
    // 旧版stage-cache-1按同一逻辑记录直接分页；读取不能要求后台迁移才获得命中。
    const encoded = cold.store.list('unit').candidates.find(unit => unit.metadata.stage === 'quotes')
    const saved = cold.store.inspect(encoded.id, 'unit', () => {})
    const legacy = cold.store.commit('unit', saved.metadata, saved.records, () => {})
    fs.unlinkSync(listPagedStoreFiles(fixture.root).find(file => file.endsWith(encoded.id + '.json')))
    fixture.state.now++
    const renamed = messages.map(message => ({ ...message, user: '当前昵称-' + message.userId }))
    const hot = prepareStageTask(fixture, 'all-stages-hot', renamed, policies, 'normal', { cutoffOffset: 1000, directory: cold.directory })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.equal(result.meta.requestCount, 0); assert.equal(result.meta.tokenUsage.totalTokens, 0)
    assert(result.audit.stageCache.some(unit => unit.commitId === legacy))
    assert.equal(result.topics.length, first.topics.length); assert.equal(result.goldenQuotes[0].content, messages[0].content)
    assert.equal(result.goldenQuotes[0].sender, '当前昵称-member-0')
    assert(result.userTitles.every(member => member.name === '当前昵称-' + member.userId && member.mbti === ''))
    assert(result.topics.every(topic => topic.participants.every(name => name.startsWith('当前昵称-'))))
    assert(['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review'].every(stage => result.audit.stageCache.some(unit => unit.stage === stage)))
    assert(result.audit.stageCache.every(unit => unit.origin.taskId === 'all-stages-cold' && unit.actualAttempts[0].execution.usage.totalTokens === 120))
    assert.equal(result.meta.reportPeriod.cutoffMs, period.cutoffMs + 1000)
  })
  await stageCacheCase(check, '普通/详细输出按模式隔离，分类事实可共享且各自再次生成均零请求', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'detail-mode', messages, policies)
    await runGroundedReport(cold.data, true, cold.options)
    fixture.state.now++
    const ordinary = prepareStageTask(fixture, 'ordinary-mode', messages, policies, 'normal', { directory: cold.directory })
    const result = await runGroundedReport(ordinary.data, false, ordinary.options)
    assert(!ordinary.model.calls.some(call => call.stage === 'classification' || call.stage === 'portraits' || call.stage === 'review'))
    assert(ordinary.model.calls.some(call => call.stage === 'overview') && ordinary.model.calls.some(call => call.stage === 'quotes'))
    assert.equal(result.audit.modules.portraits, 'not_requested')
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'ordinary-hot', messages, policies, 'normal', { directory: cold.directory })
    await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.model.calls.length, 0)
  })
  await stageCacheCase(check, '画像定向恢复重放首轮合法成员与缺失成员，历史恢复不计新请求', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'portrait-recovered', messages, policies, 'portrait-repair')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.meta.retryCount, 1)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'portrait-reuse', messages.map(message => ({ ...message, user: '重绑-' + message.userId })), policies, 'normal', { directory: cold.directory })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0); assert.equal(result.meta.retryCount, 0)
    assert(result.userTitles.every(member => member.name === '重绑-' + member.userId))
    const history = result.audit.stageCache.find(unit => unit.stage === 'portraits')
    assert.equal(history.actualAttempts.length, 2)
    assert(history.actualAttempts.every(attempt => attempt.execution.model === 'qwen3.5-plus'))
  })
  await stageCacheCase(check, '明确长度截断的结构合法首轮不能采用，完整恢复缓存只重放最终结果', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'overview-truncated', messages, policies, 'truncated-overview')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert(first.meta.retryCount > 0)
    assert(first.topics.every(topic => !topic.title.includes('不得采用')))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'overview-recovered-hot', messages, policies, 'normal', { directory: cold.directory })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0)
    assert(result.audit.stageCache.filter(unit => unit.stage === 'overview').every(unit => unit.actualAttempts.length === 2))
    assert(result.topics.every(topic => !topic.title.includes('不得采用')))
  })
  await stageCacheCase(check, '分段原文概述及摘要合成均可重绑复用，完整长文尾片段未被省略', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(1)
    messages[0].content = '长正文😀'.repeat(5000) + '最后更正哨兵'
    const cold = prepareStageTask(fixture, 'long-cold', messages, policies, 'long-overview')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert(cold.model.calls.filter(call => call.stage === 'overview').length >= 3)
    assert(cold.model.calls.some(call => call.stage === 'overview' && call.input.includes('最后更正哨兵')))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'long-hot', messages, policies, 'long-overview', { directory: cold.directory })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0)
    assert.equal(result.meta.evidence.deepReadFragmentCount, first.meta.evidence.selectedFragmentCount)
    assert.equal(result.meta.evidence.processedMessageCount, 1)
  })
  await stageCacheCase(check, '合法零话题与三个独立不足结果完整保存，复用时不重新生成评价', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'insufficient-cold', messages, policies, 'insufficient')
    const first = await runGroundedReport(cold.data, true, cold.options)
    assert.equal(first.topics.length, 0); assert.equal(first.goldenQuotes.length, 0); assert.equal(first.userTitles.length, 0); assert.equal(first.qualityReview, null)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'insufficient-hot', messages, policies, 'insufficient', { directory: cold.directory })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.equal(hot.model.calls.length, 0)
    assert.deepEqual(result.audit.modules, { topics: 'insufficient', quotes: 'insufficient', portraits: 'insufficient', review: 'insufficient' })
  })
  await stageCacheCase(check, '程序统计改变只使锐评请求失效，其他来源相同的模块继续实际命中', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'stats-original', messages, policies)
    await runGroundedReport(cold.data, true, cold.options)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'stats-changed', messages, policies, 'normal', { directory: cold.directory, activeMembers: 4 })
    const result = await runGroundedReport(hot.data, true, hot.options)
    assert.deepEqual(hot.model.calls.map(call => call.stage), ['review'])
    assert(result.qualityReview.dimensions[0].comment.includes('窗口活跃成员：4人。'))
  })
  await stageCacheCase(check, '单模块交换文件损坏只重做对应模块，永久源与其他模块保持可信', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'stage-before-corrupt', messages, policies)
    await runGroundedReport(cold.data, true, cold.options)
    const file = listPagedStoreFiles(fixture.root).find(file => file.includes(path.sep + 'commits' + path.sep)
      && JSON.parse(fs.readFileSync(file)).body.metadata.stage === 'review')
    const manifest = JSON.parse(fs.readFileSync(file)), object = path.join(path.dirname(path.dirname(file)), 'objects', manifest.body.pages[0] + '.json')
    fs.writeFileSync(object, '{')
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'stage-after-corrupt', messages, policies, 'normal', { directory: cold.directory })
    await runGroundedReport(hot.data, true, hot.options)
    assert.deepEqual(hot.model.calls.map(call => call.stage), ['review'])
    assert(hot.diagnostics.some(diagnostic => diagnostic.code === 'invalid_cache_data'))
  })
  await stageCacheCase(check, '永久绑定拒绝辅助人物冒充本人、来源范围篡改和候选所有权错换', () => {
    const snapshot = createReportEvidence(stageFixtureMessages())
    const context = createGroundedOutputContext(snapshot, [{ sourceId: 1 }, { sourceId: 2, role: 'auxiliary', text: snapshot.sources[1].content.slice(0, 3) }])
    const bindings = bindOutputStageRequest(snapshot, context, [snapshot.fragments[0]])
    verifyReportStageOrigin(snapshot, bindings)
    const badMember = JSON.parse(JSON.stringify(bindings)); badMember.members[0].memberId = 'member-2'
    assert.throws(() => verifyReportStageOrigin(snapshot, badMember))
    const badRange = JSON.parse(JSON.stringify(bindings)); badRange.sources[0].range.utf16End--
    assert.throws(() => verifyReportStageOrigin(snapshot, badRange), /范围或文字摘要/)
    const topic = createTopicContext(snapshot, [{ id: 'first', fragments: snapshot.fragments.slice(0, 2) }])
    const topicBinding = bindTopicStageRequest(snapshot, topic, snapshot.fragments.slice(0, 2))
    topicBinding.fragments[0].memberId = 'member-2'
    assert.throws(() => verifyReportStageOrigin(snapshot, topicBinding), /永久来源或本人/)
  })
  await stageCacheCase(check, '窗口滑动后的新卡片及完整目录零请求命中，候选与原文恢复为当前编号', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(40), cold = prepareStageTask(fixture, 'card-shift-old', messages, policies)
    const oldContext = createTopicCardContext(cold.snapshot, [{ id: 'original-candidate', fragments: cold.snapshot.fragments.slice(17, 18), scopeHints: ['实际讨论'] }])
    const oldBindings = bindTopicStageRequest(cold.snapshot, oldContext, cold.snapshot.fragments.slice(17, 18))
    const descriptor = { stage: 'selection', mode: 'detailed', system: getTopicCatalogInstructions('cards'), input: oldContext.input,
      maxTokens: 4096, bindings: oldBindings, requireNormalFinish: true }
    const oldCards = await executeFixtureStageUnit(cold, descriptor, text => readTopicCards(text, oldContext))
    const oldDirectory = createTopicCatalogContext(cold.snapshot, oldCards, 5)
    const directoryRequest = { stage: 'selection', mode: 'detailed', system: getTopicCatalogInstructions('selection'), input: oldDirectory.input,
      maxTokens: 4096, bindings: bindTopicStageRequest(cold.snapshot, oldDirectory, cold.snapshot.fragments.slice(17, 18)) }
    await executeFixtureStageUnit(cold, directoryRequest, text => readTopicCatalogSelection(text, oldDirectory, 5))
    fixture.state.now++
    const selected = messages.slice(5).map(message => ({ ...message, user: '当前-' + message.userId }))
    const hot = prepareStageTask(fixture, 'card-shift-new', selected, policies)
    const context = createTopicCardContext(hot.snapshot, [{ id: 'current-candidate', fragments: hot.snapshot.fragments.slice(12, 13), scopeHints: ['实际讨论'] }])
    assert.equal(context.input, oldContext.input)
    const bindings = bindTopicStageRequest(hot.snapshot, context, hot.snapshot.fragments.slice(12, 13))
    assert.deepEqual(bindings, oldBindings)
    const cards = hot.options.stageCache.read(hot.snapshot, { ...descriptor, input: context.input, bindings }, text => readTopicCards(text, context))
    assert(cards)
    assert.equal(cards.value[0].candidate.id, 'current-candidate'); assert.deepEqual(cards.value[0].leaves, ['current-candidate'])
    assert.equal(cards.value[0].candidate.fragments[0], hot.snapshot.fragments[12])
    assert.equal(cards.value[0].evidence[0].fragment.sourceId, 13)
    assert.equal(cards.value[0].evidence[0].text, messages[17].content)
    const directory = createTopicCatalogContext(hot.snapshot, cards.value, 5)
    assert.equal(directory.input, oldDirectory.input)
    const directoryBindings = bindTopicStageRequest(hot.snapshot, directory, hot.snapshot.fragments.slice(12, 13))
    assert.deepEqual(directoryBindings, directoryRequest.bindings)
    const chosen = hot.options.stageCache.read(hot.snapshot, { ...directoryRequest, input: directory.input, bindings: directoryBindings }, text => readTopicCatalogSelection(text, directory, 5))
    assert(chosen); assert.equal(chosen.value[0].id, 'current-candidate')
    assert.equal(chosen.value[0].fragments[0], hot.snapshot.fragments[12])
    assert.equal(hot.model.calls.length, 0)
  })
  await stageCacheCase(check, '全局序号滑动后的金句实际文件命中，局部短引用恢复到当前本人和编号', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(40), cold = prepareStageTask(fixture, 'shift-old', messages, policies)
    const oldContext = createGroundedOutputContext(cold.snapshot, [{ sourceId: 18 }, { sourceId: 19 }, { sourceId: 20 }])
    const oldBindings = bindOutputStageRequest(cold.snapshot, oldContext, cold.snapshot.fragments.slice(17, 18))
    const descriptor = { stage: 'quotes', mode: 'detailed', system: getGroundedOutputInstructions('quotes'), input: oldContext.input,
      maxTokens: 2048, bindings: oldBindings, requireNormalFinish: true }
    await executeFixtureStageUnit(cold, descriptor, text => readGroundedQuotes(text, oldContext))
    fixture.state.now++
    const selected = messages.slice(5).map(message => ({ ...message, user: '本次-' + message.userId }))
    const hot = prepareStageTask(fixture, 'shift-new', selected, policies)
    const context = createGroundedOutputContext(hot.snapshot, [{ sourceId: 13 }, { sourceId: 14 }, { sourceId: 15 }])
    const bindings = bindOutputStageRequest(hot.snapshot, context, hot.snapshot.fragments.slice(12, 13))
    assert.deepEqual(bindings, oldBindings)
    const cached = hot.options.stageCache.read(hot.snapshot, { ...descriptor, input: context.input, bindings }, text => readGroundedQuotes(text, context))
    assert(cached); assert.equal(hot.model.calls.length, 0)
    assert.equal(cached.value[0].sourceId, 13); assert.equal(cached.value[0].userId, messages[17].userId)
    assert.equal(cached.value[0].sender, '本次-' + messages[17].userId)
    assert.equal(cached.value[0].content, messages[17].content)
  })
  await stageCacheCase(check, '四千永久来源的单摘要巨记录和完整返回分页，清单小且零请求重绑全部来源', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(4000), cold = prepareStageTask(fixture, 'large-binding-cold', messages, policies)
    // 每个固定分段先经真实概述读取器校验，再组织一次摘要合成；不声称模型真实阅读了夹具。
    const mergeContext = snapshot => {
      const parts = []
      for (let index = 0; index < snapshot.fragments.length; index += 80) {
        const context = createTopicContext(snapshot, [{ id: 'chunk-' + index, fragments: snapshot.fragments.slice(index, index + 80) }])
        parts.push(readTopicOverview(JSON.stringify({ title: '分段讨论', summary: '简短中性概述。', refs: [...context.sources.keys()], completed: true }), context))
      }
      const all = createTopicOverviewMergeContext(parts)
      const combined = readTopicOverview(JSON.stringify({ title: '全部分段的同一讨论', summary: '完整分段材料的中性概述。',
        refs: [...all.sources.keys()], completed: true }), all, snapshot.fragments)
      return createTopicOverviewMergeContext([combined])
    }
    const context = mergeContext(cold.snapshot), descriptor = { stage: 'overview', mode: 'detailed', system: getTopicInstructions('overview'),
      input: context.input, maxTokens: 2048, bindings: bindTopicStageRequest(cold.snapshot, context, cold.snapshot.fragments) }
    assert(Buffer.byteLength(JSON.stringify(descriptor.bindings)) > 512 * 1024)
    assert(Buffer.byteLength(JSON.stringify(descriptor.bindings.sources[0])) > 256 * 1024)
    // 合法JSON外围空白也属于实际完整返回；不靠trim丢弃原始交换记录来满足单文件限制。
    const originalRequest = cold.model.request
    cold.model.request = async (...args) => ' '.repeat(600000) + await originalRequest(...args)
    await executeFixtureStageUnit(cold, descriptor, text => readTopicOverview(text, context, cold.snapshot.fragments))
    const commits = listPagedStoreFiles(fixture.root).filter(file => file.includes(path.sep + 'commits' + path.sep))
    const unitFile = commits.find(file => JSON.parse(fs.readFileSync(file)).body.metadata.stage === 'overview')
    const unit = JSON.parse(fs.readFileSync(unitFile))
    assert(unit.body.pages.length > 1); assert(fs.statSync(unitFile).size < 16 * 1024)
    assert.equal(unit.body.bodyEncoding, 'unit-record-fragments-1')
    const restored = cold.store.inspect(path.basename(unitFile, '.json'), 'unit', () => {})
    assert(restored.records.find(row => row.type === 'exchange').value.responses[0].startsWith(' '.repeat(600000)))
    assert(listPagedStoreFiles(fixture.root).every(file => fs.statSync(file).size <= (file.includes(path.sep + 'objects' + path.sep) ? 256 : 512) * 1024))
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'large-binding-hot', messages, policies, 'normal', { directory: cold.directory })
    const current = mergeContext(hot.snapshot), bindings = bindTopicStageRequest(hot.snapshot, current, hot.snapshot.fragments)
    const cached = hot.options.stageCache.read(hot.snapshot, { ...descriptor, input: current.input, bindings }, text => readTopicOverview(text, current, hot.snapshot.fragments))
    assert(cached); assert.equal(hot.model.calls.length, 0); assert.equal(cached.value.submitted.length, 4000)
    assert(cached.value.submitted.every(fragment => hot.snapshot.byFragmentId.get(fragment.id) === fragment))
  })
  await stageCacheCase(check, '缓存重放越过570秒模型截止仍失败，不能用本地命中消耗预留交付时间', async fixture => {
    const policies = stageFixturePolicies(), messages = stageFixtureMessages(), cold = prepareStageTask(fixture, 'budget-cold', messages, policies)
    await runGroundedReport(cold.data, true, cold.options)
    fixture.state.now++
    const hot = prepareStageTask(fixture, 'budget-hot', messages, policies, 'normal', { directory: cold.directory })
    const inspect = hot.store.inspect.bind(hot.store); let advanced = false
    hot.store.inspect = (...args) => {
      const value = inspect(...args)
      if (!advanced && value?.metadata?.stage === 'portraits') { advanced = true; fixture.state.now += 571000 }
      return value
    }
    await assert.rejects(runGroundedReport(hot.data, true, hot.options), /分析预算已耗尽/)
    assert(advanced); assert.equal(hot.model.calls.length, 0)
  })
}

module.exports = { runReportStageCacheTests, runCompactCatalogStageCacheTest }
