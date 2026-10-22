/** 单封闭分类批次与前台可信复用，真实文件/原计时/计额/取消，仅模型HTTP为替身。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path')
const { withPagedStoreFixture, listPagedStoreFiles } = require('./helpers/report-store-fixture')
const { createReportEvidence } = require('../lib/report-evidence')
const { saveReportSnapshot } = require('../lib/report-snapshots')
const { updateReportBatchCatalog, selectReportCatalogBatches } = require('../lib/report-batch-catalog')
const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
const { runGroundedReport } = require('../lib/report-runner')
const { ReportRequestBoundaryError } = require('../lib/report-request-pool')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = loadManagementModule('daily.reportPeriod')
const reloadPaths = ['report-classification-cache', 'report-background-ledger', 'report-background'].map(name => require.resolve('../lib/' + name))
const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))

// 正式来源与成员都有永久身份；同正文不合并身份，供料范围固定。
function backgroundMessages(count = 12, start = 0) {
  return Array.from({ length: count }, (_, offset) => { const index = offset + start; return {
    messageId: 'background-real-' + index, realMessageId: true, userId: 'member-' + index % 3, user: '成员' + index % 3,
    ts: period.periodStartMs + 1000 + index * 100, time: '04:00', content: '本期完整原文😀-' + index,
  } })
}

// 替身严格走实际单节点/执行/用量回调，不请求其他阶段；失败钩子可模拟真实边界。
function backgroundModel(policy, mode = 'normal', hook) {
  const calls = []
  const request = async (stage, attempt, system, input, maxTokens, extra) => {
    const node = attempt === 2 ? policy.recovery : policy.first
    const step = { ...node, stepIndex: 0, priorityIndex: 0, configurationIdentity: digest('actual-' + node.model) }
    extra._onRequestAttempt(step)
    calls.push({ stage, attempt, system, input, maxTokens })
    if (mode === 'hidden-retry') extra._onRequestAttempt(step)
    if (mode === 'upstream') throw new ReportRequestBoundaryError('upstream', 'AI 上游请求失败（HTTP 403）', { code: 'HTTP_403', status: 403, retryable: true })
    if (mode === 'quota') throw new ReportRequestBoundaryError('upstream', '已核实的测试额度故障', { code: 'TEST_CONFIRMED_QUOTA', status: 402, retryable: false })
    if (hook) await hook({ stage, attempt, extra })
    const usage = { readable: true, promptTokens: 100, completionTokens: 20, totalTokens: 120 }
    extra._onRequestUsage?.(usage)
    if (mode !== 'unknown-source') extra._onRequestExecution?.({ ...step, modelVersion: null, modelVersionReadable: false,
      finishReason: 'stop', finishReasonReadable: true, usage })
    const payload = JSON.parse(input)
    if (stage === 'classification') {
      const records = Object.fromEntries(payload.items.map(item => [item.ref, 'social:1']))
      if ((mode === 'repair' || mode === 'missing-both') && (attempt === 1 || mode === 'missing-both')) delete records[payload.items.at(-1).ref]
      if (mode === 'invalid-first' && attempt === 1) records.r999 = 'social:1'
      return JSON.stringify({ groups: { 'social:1': '社交互动' }, records, quotes: [], completed: true })
    }
    if (stage === 'grouping') return '{"groups":[],"completed":true}'
    if (payload.kind === 'topic-cards-9') return JSON.stringify({ cards: Object.fromEntries(payload.candidates.map(candidate => [candidate.ref, [{ refs: candidate.refs, status: 'insufficient', scope: '', evidence: [] }]])) })
    throw new Error('固定社交材料不能请求输出：' + stage)
  }
  return { calls, request }
}

// 每个用例独立真实存储根，重载模块使错误类型与存储契约属于当前夹具。
async function backgroundCase(check, name, run) {
  try {
    await withPagedStoreFixture(async fixture => {
      fixture.state.now = period.cutoffMs
      const previous = reloadPaths.map(file => require.cache[file])
      reloadPaths.forEach(file => delete require.cache[file])
      const { ReportClassificationCache: Cache } = require('../lib/report-classification-cache')
      const { provisionReportBackgroundLedger } = require('../lib/report-background-ledger')
      const { runReportBackgroundBatch: runBatch } = require('../lib/report-background')
      const node = model => ({ provider: 'test', model, protocol: 'openai-chat', routeIdentity: digest('route-' + model), routeRevision: digest('rev-' + model) })
      const policy = { identity: digest('background-policy'), first: node('primary'), recovery: node('backup') }
      const prepare = (id, messages = backgroundMessages(), previousCatalog = null, catalogNow = fixture.state.now, timeoutMs = 90000) => {
        const snapshot = createReportEvidence(messages), store = fixture.store(id, 'group-A', timeoutMs)
        const catalog = updateReportBatchCatalog(previousCatalog, snapshot, { channelKey: 'group-A', period, nowMs: catalogNow, sourceCompleteness: 'complete', inputScope: 'full_business_window' })
        const context = { period, sourceCompleteness: 'complete', statistics: { totalMessages: messages.length } }, snapshotCommit = saveReportSnapshot(store, snapshot, context)
        const options = { store, snapshot, snapshotCommit, context, catalog, startedAtMs: fixture.state.now, policy,
          hasForegroundPending: () => false, request: backgroundModel(policy).request }
        return { ...options, options }
      }
      try { await run({ ...fixture, runBatch, Cache, policy, prepare, initialize: () => provisionReportBackgroundLedger(fixture.store('enable-ledger')) }) }
      finally { reloadPaths.forEach((file, index) => { if (previous[index]) require.cache[file] = previous[index]; else delete require.cache[file] }) }
    })
    check(name, true)
  } catch (error) { check(name, false, error.stack || String(error)) }
}

// 前台复用与所有失败判据都经正式编排/存储入口，不用“文件存在”代替成功。
async function runReportBackgroundTests(check) {
  await backgroundCase(check, '后台只完成一个封闭分类批次，前台实际精确命中且零重复分类请求', async f => {
    f.initialize(); const background = f.prepare('background-one'), model = backgroundModel(f.policy)
    const result = await f.runBatch({ ...background.options, request: model.request })
    assert.equal(result.status, 'complete'); assert.equal(result.requestCount, 1); assert(result.commitId)
    assert(model.calls.every(call => call.stage === 'classification'))
    f.state.now++
    const foreground = f.prepare('foreground-new', backgroundMessages(), background.catalog, f.state.now, 600000)
    const cache = new f.Cache({ ...foreground, policy: f.policy }), frontModel = backgroundModel(f.policy)
    const report = await runGroundedReport({ messages: backgroundMessages(), reportPeriod: period, sourceCompleteness: 'complete' }, false,
      { taskId: foreground.store.taskIdentity.taskId, startedAtMs: f.state.now, deadlineMs: foreground.store.taskIdentity.deadlineMs, now: () => f.state.now,
        concurrency: 1, request: frontModel.request, classificationCatalog: { channelKey: 'group-A', value: foreground.catalog }, classificationCache: cache })
    assert.equal(frontModel.calls.filter(call => call.stage === 'classification').length, 0)
    assert.equal(report.meta.evidence.processedMessageCount, 12); assert.equal(report.audit.classificationCache.length, 1)
    assert.equal(report.audit.classificationCache[0].origin.taskId, 'background-one')
    assert.equal(report.meta.tokenUsage.totalTokens, frontModel.calls.length * 120)
  })
  await backgroundCase(check, '一次定向补漏仅发缺失核心，首轮有效归属不改，实际两节点和两次计额保存', async f => {
    f.initialize(); const task = f.prepare('repair-once'), model = backgroundModel(f.policy, 'repair')
    const result = await f.runBatch({ ...task.options, request: model.request })
    assert.equal(result.requestCount, 2); assert.equal(result.recoveryCount, 1)
    const first = JSON.parse(model.calls[0].input), second = JSON.parse(model.calls[1].input)
    assert.equal(second.items.length, 1); assert.equal(second.items[0].ref, first.items.at(-1).ref)
    const unit = task.store.read(result.commitId, 'unit', () => {})
    assert.deepEqual(unit.metadata.actualAttempts.map(attempt => attempt.execution.model), ['primary', 'backup'])
    const day = task.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value
    assert.equal(day.entries.length, 2); assert(day.entries.every(entry => entry.status === 'returned'))
  })
  await backgroundCase(check, '首轮非法全量恢复一次，恢复仍缺失准确失败且没有完成产物', async f => {
    f.initialize(); const task = f.prepare('invalid-first'), model = backgroundModel(f.policy, 'invalid-first')
    await f.runBatch({ ...task.options, request: model.request })
    assert.equal(JSON.parse(model.calls[1].input).items.length, JSON.parse(model.calls[0].input).items.length)
    assert(model.calls[1].system.includes('一个完整JSON对象，completed必须为true'))
    assert(!model.calls[1].system.includes('最后输出end记录'))
    f.state.now += 300000
    const failed = f.prepare('missing-both', backgroundMessages(12, 100)), missing = backgroundModel(f.policy, 'missing-both')
    await assert.rejects(f.runBatch({ ...failed.options, request: missing.request }), /REF_UNCOVERED/)
    assert.equal(missing.calls.length, 2)
    assert.equal(failed.store.list('unit').candidates.length, 1)
  })
  await backgroundCase(check, '未封闭尾部、裁切首批和纯图片不调用后台模型；完整封闭批次一任务只做一个', async f => {
    f.initialize(); const open = f.prepare('open-tail', backgroundMessages(), null, period.periodStartMs + 2000), model = backgroundModel(f.policy)
    assert.equal((await f.runBatch({ ...open.options, request: model.request })).status, 'idle'); assert.equal(model.calls.length, 0)
    const images = f.prepare('images', backgroundMessages().map(message => ({ ...message, content: '[图片]' })))
    assert.equal((await f.runBatch({ ...images.options, request: model.request })).status, 'idle')
    const multi = f.prepare('multi', backgroundMessages(240)), views = selectReportCatalogBatches(multi.catalog, multi.snapshot)
    assert(views.length > 1)
    const result = await f.runBatch({ ...multi.options, request: model.request })
    assert.equal(result.catalogId, views[0].catalogId); assert.equal(model.calls.length, 1)
    const messages = backgroundMessages(240).slice(1), snapshot = createReportEvidence(messages)
    const context = { period, sourceCompleteness: 'complete', statistics: {} }
    f.state.now += 300000
    const clippedStore = f.store('clipped-next', 'group-A', 90000), copiedCommit = saveReportSnapshot(clippedStore, snapshot, context)
    const clipped = await f.runBatch({ ...multi.options, store: clippedStore, startedAtMs: f.state.now, snapshot, snapshotCommit: copiedCommit, context, request: model.request })
    assert.equal(clipped.catalogId, views[1].catalogId)
  })
  await backgroundCase(check, '相同快照再次后台只读可信完成项，无新增调用也不消耗后台额度', async f => {
    f.initialize(); const task = f.prepare('cached-first'), model = backgroundModel(f.policy)
    await f.runBatch({ ...task.options, request: model.request }); f.state.now++
    const hot = f.prepare('cached-new', backgroundMessages(), task.catalog)
    const result = await f.runBatch({ ...hot.options, request: model.request })
    assert.equal(result.status, 'idle'); assert.equal(result.skippedCached, 1); assert.equal(model.calls.length, 1)
    assert.equal(hot.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value.entries.length, 1)
  })
  await backgroundCase(check, '缺总账、取消或原截止在入口零请求拒绝，不靠缓存延长原预算', async f => {
    const task = f.prepare('missing-ledger'), model = backgroundModel(f.policy)
    await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /锚点缺失/)
    const controller = new AbortController(); controller.abort(new Error('测试明确取消'))
    await assert.rejects(f.runBatch({ ...task.options, request: model.request, signal: controller.signal }), /测试明确取消/)
    f.state.now += 90000
    await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /原任务截止/)
    assert.equal(model.calls.length, 0)
  })
  await backgroundCase(check, '前台到达时不新发补漏；已返回首轮计额保留且不发布半成品', async f => {
    f.initialize(); const task = f.prepare('foreground-interrupt'); let foreground = false
    const model = backgroundModel(f.policy, 'repair', async () => { foreground = true })
    await assert.rejects(f.runBatch({ ...task.options, request: model.request, hasForegroundPending: () => foreground }), /前台日报/)
    assert.equal(model.calls.length, 1); assert.equal(task.store.list('unit').candidates.length, 0)
    assert.equal(task.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value.entries[0].status, 'returned')
  })
  await backgroundCase(check, '未知实际模型来源或隐藏重试不能发布后台完成产物', async f => {
    f.initialize(); const model = backgroundModel(f.policy, 'unknown-source'), task = f.prepare('unknown-model')
    await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /实际来源不可验证/)
    assert.equal(model.calls.length, 1); assert.equal(task.store.list('unit').candidates.length, 0)
    f.state.now += 300000
    const retry = f.prepare('hidden-model'), hidden = backgroundModel(f.policy, 'hidden-retry')
    await assert.rejects(f.runBatch({ ...retry.options, request: hidden.request }), /隐藏重试/)
    assert.equal(hidden.calls.length, 1); assert.equal(retry.store.list('unit').candidates.length, 0)
  })
  await backgroundCase(check, 'HTTP403事实不猜余额且不恢复，明确测试额度错误才暂停当日后台', async f => {
    f.initialize(); const task = f.prepare('http-failure'), model = backgroundModel(f.policy, 'upstream')
    await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /HTTP 403/)
    assert.equal(model.calls.length, 1)
    let day = task.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value
    assert.equal(day.globalPaused, false); assert.equal(day.pausedGroups.length, 0); assert.equal(day.entries[0].status, 'failed')
    f.state.now += 300000
    const quota = f.prepare('confirmed-quota'), confirmed = backgroundModel(f.policy, 'quota')
    await assert.rejects(f.runBatch({ ...quota.options, request: confirmed.request,
      classifyQuotaFailure: error => error.upstreamFailure?.code === 'TEST_CONFIRMED_QUOTA' ? 'group' : 'none' }), /测试额度故障/)
    day = quota.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value
    assert.equal(day.pausedGroups.length, 1)
    f.state.now += 300000
    await assert.rejects(f.runBatch({ ...f.prepare('after-quota').options, request: model.request }), /已因明确额度错误暂停/)
    assert.equal(model.calls.length, 1)
  })
  await backgroundCase(check, '总账结算rename失败留下未知预留，重启新任务零请求停手', async f => {
    f.initialize(); const task = f.prepare('settlement-failure'), model = backgroundModel(f.policy), rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (/day-2026-10-06\.json$/.test(String(to))) {
        const body = JSON.parse(fs.readFileSync(from)).body
        if (body.value.entries.some(entry => entry.status !== 'reserved')) throw new Error('模拟结算落盘失败')
      }
      return rename(from, to)
    }
    try { await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /结算持久化失败/) } finally { fs.renameSync = rename }
    assert.equal(model.calls.length, 1); assert.equal(task.store.list('unit').candidates.length, 0)
    f.state.now += 300000
    const next = f.prepare('after-settlement-crash')
    await assert.rejects(f.runBatch({ ...next.options, request: model.request }), /结果未知的后台预留/)
    assert.equal(model.calls.length, 1)
  })
  await backgroundCase(check, '可信产物提交失败不再调用恢复，取消/超时迟到结果不能发布完成', async f => {
    f.initialize(); const task = f.prepare('commit-failure'), model = backgroundModel(f.policy), rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (String(to).includes(path.sep + 'commits' + path.sep) && JSON.parse(fs.readFileSync(from)).body.kind === 'unit') throw new Error('模拟可信分类提交失败')
      return rename(from, to)
    }
    try { await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /可信分类提交失败/) } finally { fs.renameSync = rename }
    assert.equal(model.calls.length, 1)
    f.state.now += 300000
    const late = f.prepare('late-clock'), lateModel = backgroundModel(f.policy, 'normal', async () => { f.state.now += 90000 })
    const originalTimeout = global.setTimeout, originalClear = global.clearTimeout, pending = new Set()
    global.setTimeout = (...args) => { const timer = originalTimeout(...args); pending.add(timer); return timer }
    global.clearTimeout = timer => { pending.delete(timer); return originalClear(timer) }
    try { await assert.rejects(f.runBatch({ ...late.options, request: lateModel.request }), /原任务截止|总时限/) }
    finally { global.setTimeout = originalTimeout; global.clearTimeout = originalClear; for (const timer of pending) originalClear(timer) }
    assert.equal(pending.size, 0, '受控时钟拒绝过期后仍必须清理全部请求与任务定时器')
    assert.equal(lateModel.calls.length, 1)
    assert.equal(f.store('post-timeout-inspector').list('unit').candidates.length, 0)
  })
  await backgroundCase(check, '运行中取消会等待实际请求清理结束，未知预留保留且没有迟到分类发布', async f => {
    f.initialize(); const task = f.prepare('cancel-in-flight'), controller = new AbortController(); let cleaned = false
    const model = backgroundModel(f.policy, 'normal', async ({ extra }) => {
      controller.abort(new Error('用户取消后台测试'))
      await new Promise(resolve => setTimeout(resolve, 10))
      assert(extra.signal.aborted); cleaned = true
      throw extra.signal.reason
    })
    await assert.rejects(f.runBatch({ ...task.options, request: model.request, signal: controller.signal }), /用户取消后台测试/)
    assert.equal(cleaned, true); assert.equal(model.calls.length, 1)
    assert.equal(task.store.list('unit').candidates.length, 0)
    const day = task.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value
    assert.equal(day.entries.length, 1); assert.equal(day.entries[0].status, 'reserved')
  })
  await backgroundCase(check, '首次请求预留落盘失败零提交，必要源损坏或索引禁用不消耗模型', async f => {
    f.initialize(); const task = f.prepare('reserve-rename-failure'), model = backgroundModel(f.policy), rename = fs.renameSync
    fs.renameSync = (from, to) => { if (/day-2026-10-06\.json$/.test(String(to))) throw new Error('模拟预留原子发布失败'); return rename(from, to) }
    try { await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /预留原子发布失败/) } finally { fs.renameSync = rename }
    assert.equal(model.calls.length, 0)
    assert.equal(task.store.readPreanalysisControl({ kind: 'day', date: period.reportDate }).value.entries.length, 0)
    const source = listPagedStoreFiles(f.root).find(file => file.endsWith(task.snapshotCommit + '.json'))
    fs.writeFileSync(source, '{}')
    await assert.rejects(f.runBatch({ ...task.options, request: model.request }), /提交清单校验失败/)
    assert.equal(model.calls.length, 0)
    f.state.now++
    const fresh = f.prepare('index-publish-failure')
    fs.renameSync = (from, to) => { if (String(to).endsWith('unit-root.json')) throw new Error('模拟索引发布失败'); return rename(from, to) }
    try { await assert.rejects(f.runBatch({ ...fresh.options, request: model.request }), /可信缓存发布资格/) } finally { fs.renameSync = rename }
    assert.equal(model.calls.length, 0)
  })
}
module.exports = { runReportBackgroundTests }
