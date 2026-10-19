/** 真实S0/S2、原始索引、单批/总账/缓存链；仅HTTP和配置为隔离替身。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path')
process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES = '200'
const NativeDate = Date
let clock = NativeDate.parse('2026-10-16T12:00:00+08:00')
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return clock }
}
const config = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
let configuredModel = 'deepseek-v4-flash'
config.loadConfig = async () => ({ apiKey: 'test-isolated-key', provider: 'test-preanalysis',
  model: configuredModel, baseURL: 'https://example.invalid/v1', chatProtocol: 'openai-chat', searchEnabled: false })
// 模型池与凭据读取属于此工作器夹具的外部配置边界；实际HTTP与S0/落盘仍走正式实现。
require('koishi-plugin-dongxuelian-ai/lib/core/ai-capability-config').resolveConfiguredCapabilityModel = (capability, provider, model) => {
  assert.equal(capability, 'text'); assert.equal(provider, 'custom-1c571761199978de80368aba')
  if (model !== configuredModel) throw new Error('指定模型节点必须唯一匹配已配置能力模型池')
  return { capability, provider, providerName: '配置替身', model, apiKey: 'test-isolated-key', baseURL: 'https://example.invalid/v1', chatProtocol: 'openai-chat', priorityIndex: 0 }
}
require('koishi-plugin-dongxuelian-ai/lib/core/capability-failure-notifier').notifyCapabilityStepFailure = async () => false
const { acquireResourceGate, getResourceGateStatus } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const { createReportPeriod, getReportRecordExpiryMs } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const records = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const { PagedReportStore } = require('../../../koishi-plugin-daily-report/lib/report-storage')
const { provisionReportBackgroundLedger } = require('../../../koishi-plugin-daily-report/lib/report-background-ledger')
const { readReportBatchCatalog } = require('../../../koishi-plugin-daily-report/lib/report-batch-catalog')
const { runTaskWithTimeout } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const { runDailyPreanalysisWorkerTask } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/daily-worker')
const { notifyCompletedTasks } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const period = createReportPeriod(clock), channelKey = 'preanalysis-real-worker', kind = 'daily_report_preanalysis'
let calls = 0, gate, current, inspector

// 只让本次实际任务拥有的独占票据访问存储，复用真实跨进程文件锁。
function assertLease() {
  const state = getResourceGateStatus()
  assert(state.locked); assert.equal(state.meta.taskId, current.id); assert.equal(state.meta.ticketId, gate.ticketId)
}

// 配置默认关闭、总账缺失不请求，已启用且显式建账后完整走真实HTTP解析及持久化。
async function run() {
  const originalFetch = global.fetch, rename = fs.renameSync
  global.fetch = async (_url, options) => {
    calls++
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.enable_thinking, false)
    const payload = JSON.parse(body.messages[1].content)
    const ledgerRoot = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'daily-analysis/v2/background-ledger')
    assert(fs.existsSync(path.join(ledgerRoot, 'day-' + period.reportDate + '.json')))
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      groups: { 'social:1': '社交互动' }, records: Object.fromEntries(payload.items.map(item => [item.ref, 'social:1'])), quotes: [], completed: true,
    }) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { status: 200 })
  }
  try {
    for (let index = 0; index < 12; index++) records.appendReportRecord(period.reportDate, channelKey, {
      messageId: 'source-' + index, timestamp: clock - 30 * 60000 + index * 1000,
      userId: 'member-' + index % 3, userName: '成员' + index % 3, text: '完整的原始讨论' + index,
    })
    delete process.env.DAILY_REPORT_PREANALYSIS_ENABLED
    await assert.rejects(runDailyPreanalysisWorkerTask({ id: 'disabled', kind, channelKey }), /尚未启用/)
    process.env.DAILY_REPORT_PREANALYSIS_ENABLED = '1'
    await assert.rejects(runDailyPreanalysisWorkerTask({ id: 'bad-notify', kind, channelKey, notify: { target: 'group' } }), /禁止结果通知/)
    store.submitResourceTask({ id: 'real-background', kind, channelKey, timeoutMs: 600000,
      payload: { ...period }, notify: { target: 'none', status: 'pending' } })
    current = store.markTaskRunning(store.claimTaskById('real-background', 'preanalysis-test'), 'preanalysis-test')
    gate = await acquireResourceGate({ taskId: current.id, kind, channelKey, owner: 'preanalysis-test', timeoutMs: 90000, waitTimeoutMs: 1000 })
    inspector = new PagedReportStore({ taskId: current.id, channelKey, deadlineMs: clock + 90000,
      assertLease, assertActive() { assert.equal(store.getResourceTaskById(current.id).status, 'running') } })
    await assert.rejects(runTaskWithTimeout(current), /总账|锚点/)
    assert.equal(calls, 0)
    // 即使全局另有可用型号，后台也不能回落发出一次请求或预留用量。
    configuredModel = 'fixture-other-model'
    await assert.rejects(runTaskWithTimeout(current), /指定模型节点必须唯一匹配/)
    assert.equal(calls, 0)
    configuredModel = 'deepseek-v4-flash'
    provisionReportBackgroundLedger(inspector)
    let result = await runTaskWithTimeout(current)
    assert.equal(result.status, 'complete'); assert.equal(result.requestCount, 1); assert.equal(calls, 1)
    assert.equal(result.processedMessageCount, 12); assert(result.commitId)
    const repeated = await runTaskWithTimeout(current)
    assert.equal(repeated.status, 'idle'); assert.equal(repeated.skippedCached, 1); assert.equal(calls, 1)
    const firstCatalog = readReportBatchCatalog(inspector, inspector.list('catalog').candidates[0].id)
    store.completeTask(current, result)
    gate.release('first-batch-finished')
    clock += 300001
    for (let index = 0; index < 205; index++) records.appendReportRecord(period.reportDate, channelKey, {
      messageId: 'later-' + index, timestamp: period.cutoffMs - 20 * 60000 + index * 1000,
      userId: 'member-' + index % 3, userName: '成员' + index % 3, text: '持续新增的原始讨论' + index,
    })
    store.submitResourceTask({ id: 'real-background-next', kind, channelKey, timeoutMs: 600000,
      payload: { ...period }, notify: { target: 'none', status: 'pending' } })
    current = store.markTaskRunning(store.claimTaskById('real-background-next', 'preanalysis-test'), 'preanalysis-test')
    gate = await acquireResourceGate({ taskId: current.id, kind, channelKey, owner: 'preanalysis-test', timeoutMs: 90000, waitTimeoutMs: 1000 })
    inspector = new PagedReportStore({ taskId: current.id, channelKey, deadlineMs: clock + 90000,
      assertLease, assertActive() { assert.equal(store.getResourceTaskById(current.id).status, 'running') } })
    result = await runTaskWithTimeout(current)
    assert.equal(result.status, 'complete'); assert.equal(calls, 2)
    const latestCatalog = inspector.list('catalog').candidates.sort((a, b) => b.createdAtMs - a.createdAtMs)[0]
    const catalog = readReportBatchCatalog(inspector, latestCatalog.id)
    assert.equal(catalog.sources.length, 217); assert.equal(catalog.initialMessageId, 'source-0')
    assert.equal(catalog.baselineIdentity, firstCatalog.baselineIdentity)
    assert.deepEqual(catalog.batches[0], firstCatalog.batches[0])
    const snapshot = inspector.list('snapshot').candidates.sort((a, b) => b.createdAtMs - a.createdAtMs)[0]
    assert.equal(snapshot.metadata.sourceCount, 200); assert.equal(snapshot.metadata.statistics.totalMessages, 217)
    assert(store.listActiveDailyReportTasks().some(task => task.id === current.id))
    store.submitResourceTask({ id: 'foreground-pending', kind: 'daily_report', channelKey, payload: { ...period } })
    const deferred = await runTaskWithTimeout(current)
    assert.equal(deferred.defer, true); assert.equal(calls, 2)
    store.cancelTask('foreground-pending')
    // 原始索引已到清理时间仍由活动预分析保护；取消后才能释放。
    clock = getReportRecordExpiryMs(period.cutoffMs - 30 * 60000) + 1
    await records.cleanupReportRecords({ now: clock })
    assert.equal(records.readReportRecords(channelKey, period).windowMessageCount, 217)
    store.completeTask(current, result)
    let sent = 0
    await notifyCompletedTasks({ sender: async () => { sent++; return true } })
    assert.equal(sent, 0); assert.equal(store.getResourceTaskById(current.id).notify.status, 'skipped')
    await records.cleanupReportRecords({ now: clock })
    assert.equal(records.readReportRecords(channelKey, period).windowMessageCount, 0)
    console.log(JSON.stringify({ defaultOff: true, missingLedgerNoCall: true, actualGateAndWorker: true,
      durableBatch: true, repeatedCacheNoCall: true, fullWindowSeparateFromSelection: true,
      foregroundPriority: true, activeSourceProtection: true, noNotification: true, onlyConfiguredDeepseek: true }))
  } finally {
    fs.renameSync = rename; global.fetch = originalFetch; global.Date = NativeDate
    delete process.env.DAILY_REPORT_PREANALYSIS_ENABLED
    if (gate) gate.release('preanalysis-fixture-complete')
    require('koishi-plugin-dongxuelian-ai/lib/core/api').flushTokenUsage()
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1 })
