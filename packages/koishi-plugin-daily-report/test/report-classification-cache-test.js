/** 真实文件分类缓存、同编排器命中和失败边界；仅模型返回为固定替身。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { withPagedStoreFixture, listPagedStoreFiles } = require('./helpers/report-store-fixture')
const { createReportEvidence, buildReportEvidenceBatch } = require('../lib/report-evidence')
const { saveReportSnapshot } = require('../lib/report-snapshots')
const { updateReportBatchCatalog, updateStoredReportBatchCatalog, selectReportCatalogBatches } = require('../lib/report-batch-catalog')
const { runGroundedReport } = require('../lib/report-runner')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = loadManagementModule('daily.reportPeriod')
const cachePath = require.resolve('../lib/report-classification-cache')
const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))

// 固定身份只服务模拟冻结政策，不读凭据或联网。
function cacheFixtureHash(value) { return crypto.createHash('sha256').update(value).digest('hex') }

// 使用当前公共执行元数据形状，首轮和唯一恢复均为独立单节点。
function cacheFixturePolicy(revision = 'original') {
  const node = name => ({ routeIdentity: cacheFixtureHash(name + revision), routeRevision: cacheFixtureHash('revision-' + name + revision),
    provider: 'dashscope', model: name, protocol: 'openai-chat' })
  return { identity: cacheFixtureHash('policy-' + revision), first: node('qwen3.5-omni-flash'), recovery: node('qwen3.5-plus') }
}

// 固定永久身份夹具，入库顺序与任务最新4000条选择分开。
function cacheFixtureMessages(count, start = 0) {
  return Array.from({ length: count }, (_, offset) => { const index = start + offset; return {
    messageId: 'real-' + index, realMessageId: true, userId: 'member-' + index % 19, user: '同名群友',
    ts: period.periodStartMs + 1000 + index * 100, time: '04:00', content: index % 23 === 0 ? '[图片]' : '完整😀原文-' + index,
  } })
}

// 模型是唯一替身，实际槽位、恢复、产物保存、重绑及用量计数均走生产入口。
function cachedRunnerOptions(policy, mode = 'normal') {
  const calls = []
  const options = { deadlineMs: Date.now() + 600000, concurrency: 2, request: async (stage, attempt, _system, input, _tokens, extra) => {
    const node = attempt === 2 || !['classification', 'grouping', 'selection'].includes(stage) ? policy.recovery : policy.first
    const step = { ...node, stepIndex: 0, priorityIndex: 0, configurationIdentity: cacheFixtureHash(node.model + node.routeIdentity) }
    extra._onRequestAttempt(step)
    const usage = { readable: true, promptTokens: 100, completionTokens: 20, totalTokens: 120 }
    extra._onRequestUsage(usage)
    if (mode !== 'unknown-source' || stage !== 'classification') extra._onRequestExecution({ ...step, modelVersion: null, modelVersionReadable: false,
      finishReason: 'stop', finishReasonReadable: true, usage })
    calls.push({ stage, attempt, input })
    const payload = JSON.parse(input)
    if (stage === 'classification') {
      const records = Object.fromEntries(payload.items.map(item => [item.ref, 'social:1']))
      if (mode === 'repair' && attempt === 1) delete records[payload.items.at(-1).ref]
      return JSON.stringify({ groups: { 'social:1': '社交互动' }, records, quotes: [], completed: true })
    }
    if (stage === 'grouping') return JSON.stringify({ groups: [], completed: true })
    if (payload.kind === 'topic-cards-2') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => [candidate.ref, { status: 'insufficient', scope: '', summary: '', evidence: [] }])) })
    throw new Error('固定社交夹具不应请求其他输出阶段：' + stage)
  } }
  return { calls, options }
}

// 每个缓存模块实例绑定当前夹具的真实数据根及错误类型，离开后恢复模块缓存。
async function withClassificationCacheFixture(run) {
  await withPagedStoreFixture(async fixture => {
    const old = require.cache[cachePath]
    delete require.cache[cachePath]
    try { await run({ ...fixture, Cache: require(cachePath).ReportClassificationCache }) } finally {
      if (old) require.cache[cachePath] = old; else delete require.cache[cachePath]
    }
  })
}

// 每个新任务先建立真正的当前输入快照和统计，再创建缓存入口。
function prepareCachedTask(fixture, id, messages, directory, policy, cutoff = period.cutoffMs) {
  const snapshot = createReportEvidence(messages), currentPeriod = createReportPeriod(cutoff)
  const context = { period: currentPeriod, sourceCompleteness: 'complete', statistics: { selectedMessages: messages.length } }
  const store = fixture.store(id), snapshotCommit = saveReportSnapshot(store, snapshot, context), diagnostics = []
  const cache = new fixture.Cache({ store, snapshot, snapshotCommit, context, policy,
    onDiagnostic(code, commitId, message) { diagnostics.push({ code, commitId, message }) } })
  const model = cachedRunnerOptions(policy)
  model.options.taskId = id
  model.options.deadlineMs = store.taskIdentity.deadlineMs
  model.options.startedAtMs = fixture.state.now
  model.options.now = () => fixture.state.now
  model.options.classificationCatalog = { channelKey: 'group-A', value: directory }
  model.options.classificationCache = cache
  return { ...model, cache, store, snapshot, snapshotCommit, diagnostics,
    data: { messages, reportPeriod: currentPeriod, sourceCompleteness: 'complete', totalMessages: messages.length, activeMembers: 19 } }
}

// 源窗口输入标签由正式目录入口验证，不能用本次选中数组重新建立原点。
function fixtureDirectory(messages, previous = null) {
  return updateReportBatchCatalog(previous, createReportEvidence(messages), { channelKey: 'group-A', period,
    nowMs: period.periodStartMs + 600000, sourceCompleteness: 'complete', inputScope: 'full_business_window' })
}

// 固定独立验收项，失败继续汇总，不掩盖模型以外的文件错误。
async function cacheCase(check, name, run) {
  try { await withClassificationCacheFixture(run); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 真实文件缓存验证不能代替被用户停止的供应商质量与性能回放。
async function runReportClassificationCacheTests(check) {
  await cacheCase(check, '永久来源成员大表移出根清单且单条长ID分页，新任务完整本人重绑并零分类请求', async f => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(45).map((message, index) => ({ ...message,
      messageId: '真实消息-' + index + '-'.repeat(14000), userId: '真实成员-' + index + '-'.repeat(14000) }))
    const directory = fixtureDirectory(messages), cold = prepareCachedTask(f, 'giant-identities-cold', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const units = cold.store.list('unit').candidates.filter(unit => unit.metadata.version === 'classification-cache-2')
    assert(units.length > 0)
    for (const unit of units) {
      assert(!('bindings' in unit.metadata)); assert(unit.metadata.coreCount > 0); assert(unit.metadata.memberCount > 0)
      const decoded = cold.store.inspect(unit.id, 'unit', () => {})
      assert(Buffer.byteLength(JSON.stringify(decoded.records)) > 512 * 1024)
    }
    assert(listPagedStoreFiles(f.root).every(file => fs.statSync(file).size <= (file.includes(path.sep + 'objects' + path.sep) ? 256 : 512) * 1024))
    f.state.now++
    const hot = prepareCachedTask(f, 'giant-identities-hot', messages.map(message => ({ ...message, user: '当前本人昵称' })), directory, policy)
    const result = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 0)
    assert.equal(result.meta.evidence.processedMessageCount, 45)
    assert.equal(result.audit.classificationCache.length, units.length)
  })
  await cacheCase(check, '已知第一版分类缓存按原明确字段完整读取，不强制迁移或产生重复请求', async f => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(f, 'known-v1-cold', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const unit = cold.store.list('unit').candidates[0], decoded = cold.store.inspect(unit.id, 'unit', () => {})
    const old = { ...decoded.metadata, version: 'classification-cache-1', bindings: { version: 'permanent-classification-1',
      core: decoded.records.filter(row => row.type === 'core').map(row => row.value), members: decoded.records.filter(row => row.type === 'member').map(row => row.value) } }
    for (const key of ['bindingVersion', 'coreCount', 'memberCount', 'classificationCount']) delete old[key]
    const oldRecords = decoded.records.filter(row => row.type === 'classification').map(row => row.value.kind === 'quote' ? row.value : { ...row.value, title: '' })
    old.productIdentity = require('../lib/report-cache-provenance').reportCacheDigest({ requestIdentity: old.requestIdentity, policyIdentity: old.policyIdentity,
      permanent: { ...old.bindings, records: oldRecords }, actualAttempts: old.actualAttempts })
    const legacy = cold.store.commit('unit', old, oldRecords, () => {})
    fs.unlinkSync(listPagedStoreFiles(f.root).find(file => file.endsWith(unit.id + '.json')))
    f.state.now++
    const hot = prepareCachedTask(f, 'known-v1-hot', messages, directory, policy), result = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 0)
    assert.equal(result.audit.classificationCache[0].commitId, legacy)
  })
  await cacheCase(check, '分页分类行即使重新生成文件摘要仍拒绝错索引、类别、所有权和根数量', async f => {
    const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(f, 'semantic-corruption-cold', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const unit = cold.store.list('unit').candidates[0], decoded = cold.store.inspect(unit.id, 'unit', () => {})
    const mutations = [
      (meta, rows) => { rows[0].index = 1 }, (meta, rows) => { rows[0].type = 'member' },
      (meta, rows) => { rows[0].value.memberId = '另一个真实作者'; const permanent = { version: meta.bindingVersion,
        core: rows.filter(row => row.type === 'core').map(row => row.value), members: rows.filter(row => row.type === 'member').map(row => row.value),
        records: rows.filter(row => row.type === 'classification').map(row => row.value) };
        meta.productIdentity = digest({ requestIdentity: meta.requestIdentity, policyIdentity: meta.policyIdentity, permanent, actualAttempts: meta.actualAttempts }) },
      meta => { meta.coreCount++ },
    ]
    for (const mutate of mutations) {
      const meta = JSON.parse(JSON.stringify(decoded.metadata)), rows = JSON.parse(JSON.stringify(decoded.records)); mutate(meta, rows)
      cold.store.commit('unit', meta, rows, () => {}, 'unit-record-fragments-1')
    }
    fs.unlinkSync(listPagedStoreFiles(f.root).find(file => file.endsWith(unit.id + '.json')))
    f.state.now++
    const hot = prepareCachedTask(f, 'semantic-corruption-hot', messages, directory, policy)
    await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 1)
    assert(hot.diagnostics.filter(item => item.code === 'invalid_cache_data').length >= 4)
  })
  await cacheCase(check, '4000条目录局部恢复后同编排器仅重算坏批次页，未受影响分类实际零重复调用', async f => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(4000), evidence = createReportEvidence(messages)
    const context = { channelKey: 'group-A', period, nowMs: period.cutoffMs, sourceCompleteness: 'complete', inputScope: 'full_business_window' }
    const directoryStore = f.store('directory-original'), original = updateStoredReportBatchCatalog(directoryStore, evidence, context)
    const cold = prepareCachedTask(f, 'cold-before-corruption', messages, original.value, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const pages = directoryStore.inspectCatalogPages(original.id).pages.filter(page => page.records.some(row => row.type === 'batch'))
    assert(pages.length > 1)
    const page = pages[Math.floor(pages.length / 2)], oldIds = new Set(original.value.batches.map(batch => batch.id))
    const manifest = listPagedStoreFiles(f.root).find(file => file.endsWith(original.id + '.json'))
    fs.writeFileSync(path.join(path.dirname(path.dirname(manifest)), 'objects', page.id + '.json'), '{broken batch page')
    f.state.now++
    const recovered = updateStoredReportBatchCatalog(f.store('directory-recovery'), evidence, context)
    const views = selectReportCatalogBatches(recovered.value, evidence), expected = views.filter(view => view.batch && !oldIds.has(view.catalogId))
    assert(expected.length > 0); assert(recovered.recovery.preservedBatchCount > 0)
    const warm = prepareCachedTask(f, 'warm-after-recovery', messages, recovered.value, policy)
    const result = await runGroundedReport(warm.data, false, warm.options)
    const actual = warm.calls.filter(call => call.stage === 'classification')
    assert.deepEqual(actual.map(call => call.input).sort(), expected.map(view => view.batch.input).sort())
    assert.equal(result.audit.classificationCache.length, views.filter(view => view.batch && oldIds.has(view.catalogId)).length)
    assert.equal(result.meta.evidence.processedMessageCount, 4000)
    assert.equal(result.meta.selectedMessageCount, 4000)
  })
  await cacheCase(check, '同编排器新任务实际命中分类文件，零新增分类请求并保留历史用量/原任务', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'cold-task', messages, directory, policy)
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(cold.calls.filter(call => call.stage === 'classification').length, 1)
    fixture.state.now++
    const renamed = messages.map(message => ({ ...message, user: '当前昵称-' + message.userId }))
    const hot = prepareCachedTask(fixture, 'hot-task', renamed, directory, policy, period.cutoffMs + 1000)
    const result = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 0)
    assert.equal(result.meta.evidence.processedMessageCount, 10)
    assert.equal(result.meta.evidence.cacheHitMessageCount, 9)
    assert.equal(result.meta.evidence.modelSubmittedMessageCount, 0)
    assert.equal(result.audit.classificationCache.length, 1)
    assert.equal(result.audit.classificationCache[0].origin.taskId, 'cold-task')
    assert.equal(result.audit.classificationCache[0].actualAttempts[0].execution.usage.totalTokens, 120)
    assert.equal(result.meta.tokenUsage.totalTokens, hot.calls.length * 120)
    assert(result.meta.tokenUsage.totalTokens < first.meta.tokenUsage.totalTokens)
    assert.equal(result.meta.reportPeriod.cutoffMs, period.cutoffMs + 1000)
  })
  await cacheCase(check, '4000条持续追加实际复用未变化的封闭分类产物，仅2个分类单元请求且完整处理', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(4000), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'cold-4000', messages, directory, policy)
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(cold.calls.filter(call => call.stage === 'classification').length, first.meta.batchCount)
    fixture.state.now++
    const full = [...messages, ...cacheFixtureMessages(10, 4000)], next = fixtureDirectory(full, directory)
    const hot = prepareCachedTask(fixture, 'next-4000', full.slice(-4000), next, policy, period.cutoffMs + 1000)
    const result = await runGroundedReport(hot.data, false, hot.options)
    const requested = hot.calls.filter(call => call.stage === 'classification').length
    assert.equal(requested, 2)
    assert.equal(result.audit.classificationCache.length, result.meta.batchCount - requested)
    assert(result.audit.classificationCache.length > 40)
    assert.equal(result.meta.evidence.processedMessageCount, 4000)
    assert.equal(result.meta.evidence.unprocessedMessageCount, 0)
    assert.equal(result.meta.evidence.processingCoverageRate, 100)
    assert(result.meta.evidence.cacheHitMessageCount > 3500)
  })
  await cacheCase(check, '唯一恢复的实际快/通用节点均保存并可复用，不重算历史两次用量', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'recovered', messages, directory, policy), model = cachedRunnerOptions(policy, 'repair')
    cold.options.request = model.options.request
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(first.meta.retryCount, 1)
    fixture.state.now++
    const hot = prepareCachedTask(fixture, 'reuse-recovery', messages, directory, policy)
    const result = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 0)
    const attempts = result.audit.classificationCache[0].actualAttempts
    assert.deepEqual(attempts.map(attempt => attempt.execution.model), ['qwen3.5-omni-flash', 'qwen3.5-plus'])
    assert.equal(result.meta.retryCount, 0)
    assert.equal(result.meta.tokenUsage.totalTokens, hot.calls.length * 120)
  })
  await cacheCase(check, '已校验输出文件损坏仅使该缓存失效，从当前来源重做后原子修复同摘要对象', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'before-corruption', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const unit = listPagedStoreFiles(fixture.root).find(file => file.includes(path.sep + 'commits' + path.sep)
      && JSON.parse(fs.readFileSync(file)).body.kind === 'unit')
    const manifest = JSON.parse(fs.readFileSync(unit)), object = path.join(path.dirname(path.dirname(unit)), 'objects', manifest.body.pages[0] + '.json')
    const value = JSON.parse(fs.readFileSync(object)); value.records[0].category = 'unknown-category'
    fs.writeFileSync(object, JSON.stringify(value))
    fixture.state.now++
    const hot = prepareCachedTask(fixture, 'after-corruption', messages, directory, policy)
    const result = await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 1)
    assert(hot.diagnostics.some(item => item.code === 'invalid_cache_data'))
    assert.equal(result.meta.evidence.processedMessageCount, 10)
    fixture.state.now++
    const repaired = prepareCachedTask(fixture, 'after-repair', messages, directory, policy)
    const final = await runGroundedReport(repaired.data, false, repaired.options)
    assert.equal(repaired.calls.filter(call => call.stage === 'classification').length, 0)
    assert.equal(final.audit.classificationCache.length, 1)
  })
  await cacheCase(check, '原来源提交缺失或冻结政策变更必须重做，不用产物假冒源对象齐全', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'original-source', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    const sourceFile = listPagedStoreFiles(fixture.root).find(file => path.basename(file) === cold.snapshotCommit + '.json')
    fs.unlinkSync(sourceFile)
    fixture.state.now++
    const hot = prepareCachedTask(fixture, 'source-rebuilt', messages, directory, policy)
    await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 1)
    assert(hot.diagnostics.some(item => item.code === 'source_unavailable'))
    fixture.state.now++
    const changed = prepareCachedTask(fixture, 'new-policy', messages, directory, cacheFixturePolicy('new-revision'))
    await runGroundedReport(changed.data, false, changed.options)
    assert.equal(changed.calls.filter(call => call.stage === 'classification').length, 1)
  })
  await cacheCase(check, '模型来源缺失允许当前契约完成但不发布可信缓存，下一任务仍实际请求', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'unknown-model-source', messages, directory, policy), model = cachedRunnerOptions(policy, 'unknown-source')
    cold.options.request = model.options.request
    const first = await runGroundedReport(cold.data, false, cold.options)
    assert.equal(first.meta.analysisState, 'complete')
    assert(cold.diagnostics.some(item => item.code === 'actual_model_unverified'))
    assert.equal(cold.store.list('unit').candidates.length, 0)
    fixture.state.now++
    const hot = prepareCachedTask(fixture, 'after-unknown', messages, directory, policy)
    await runGroundedReport(hot.data, false, hot.options)
    assert.equal(hot.calls.filter(call => call.stage === 'classification').length, 1)
  })
  await cacheCase(check, '必要缓存提交rename失败整份失败且不再恢复模型，后续新任务没有幽灵命中', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'commit-failure', messages, directory, policy), rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (to.includes(path.sep + 'commits' + path.sep) && JSON.parse(fs.readFileSync(from)).body.kind === 'unit') throw new Error('模拟缓存提交失败')
      return rename(from, to)
    }
    try { await assert.rejects(runGroundedReport(cold.data, false, cold.options), /缓存提交失败/) } finally { fs.renameSync = rename }
    assert.equal(cold.calls.filter(call => call.stage === 'classification').length, 1)
    assert.equal(cold.store.list('unit').candidates.length, 0)
    fixture.state.now++
    const next = prepareCachedTask(fixture, 'after-failed-commit', messages, directory, policy)
    await runGroundedReport(next.data, false, next.options)
    assert.equal(next.calls.filter(call => call.stage === 'classification').length, 1)
  })
  await cacheCase(check, '取消后的合法模型迟到结果不能发布单元清单', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const task = prepareCachedTask(fixture, 'cancelled-before-save', messages, directory, policy), original = task.options.request
    task.options.request = async (...args) => { const response = await original(...args); fixture.state.alive = false; return response }
    await assert.rejects(runGroundedReport(task.data, false, task.options), /任务已取消/)
    assert.equal(task.calls.length, 1)
    const manifests = listPagedStoreFiles(fixture.root).filter(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith('.json'))
    assert(!manifests.some(file => JSON.parse(fs.readFileSync(file)).body.kind === 'unit'))
  })
  await cacheCase(check, '缓存采用前失去租约必须失败，不能当作未命中再调用模型', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const cold = prepareCachedTask(fixture, 'lease-original', messages, directory, policy)
    await runGroundedReport(cold.data, false, cold.options)
    fixture.state.now++
    const hot = prepareCachedTask(fixture, 'lease-lost', messages, directory, policy), inspect = hot.store.inspect.bind(hot.store)
    hot.store.inspect = (...args) => { const value = inspect(...args); if (args[1] === 'unit') fixture.state.leased = false; return value }
    await assert.rejects(runGroundedReport(hot.data, false, hot.options), /租约已失效/)
    assert.equal(hot.calls.length, 0)
  })
  await cacheCase(check, '缓存任务身份、群或固定截止不匹配零模型请求拒绝，不能借缓存续期', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages)
    const task = prepareCachedTask(fixture, 'fixed-deadline', messages, directory, policy)
    for (const changes of [{ taskId: 'other-task' }, { deadlineMs: task.options.deadlineMs + 600000 },
      { classificationCatalog: { channelKey: 'other-group', value: directory } }]) {
      await assert.rejects(runGroundedReport(task.data, false, { ...task.options, ...changes }), /任务身份、群或原截止不一致/)
    }
    assert.equal(task.calls.length, 0)
  })
  await cacheCase(check, '历史未知完整性和非永久消息标识保持禁用跨任务缓存，不发布伪可信产物', fixture => {
    const snapshot = createReportEvidence(cacheFixtureMessages(3).map(message => ({ ...message, realMessageId: false })))
    const context = { period, sourceCompleteness: 'legacy_unknown', statistics: { selectedMessages: 3 } }, store = fixture.store('legacy-task')
    const snapshotCommit = saveReportSnapshot(store, snapshot, context)
    const cache = new fixture.Cache({ store, snapshot, snapshotCommit, context, policy: cacheFixturePolicy() })
    const batch = buildReportEvidenceBatch(snapshot, snapshot.fragments.slice(1))
    assert.equal(cache.enabled, false)
    assert.equal(cache.read(snapshot, batch, 'legacy-rule'), null)
    assert.equal(cache.save(snapshot, batch, 'legacy-rule', [], []), null)
    assert.equal(store.list('unit').candidates.length, 0)
  })
  await cacheCase(check, '可重建定位索引写入失败禁用本次跨任务缓存，模型结果仍完成且不发布缓存单元', async fixture => {
    const policy = cacheFixturePolicy(), messages = cacheFixtureMessages(10), directory = fixtureDirectory(messages), rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('unit-root.json')) throw new Error('模拟定位发布失败'); return rename(from, to) }
    let task
    try { task = prepareCachedTask(fixture, 'locator-write-failure', messages, directory, policy) } finally { fs.renameSync = rename }
    assert.equal(task.cache.enabled, false); assert(task.diagnostics.some(value => value.code === 'locator_unavailable'))
    const result = await runGroundedReport(task.data, false, task.options)
    assert.equal(result.meta.evidence.processedMessageCount, messages.length)
    assert(task.calls.some(call => call.stage === 'classification'))
    assert.equal(task.store.list('unit').candidates.length, 0)
  })
}

module.exports = { runReportClassificationCacheTests }
