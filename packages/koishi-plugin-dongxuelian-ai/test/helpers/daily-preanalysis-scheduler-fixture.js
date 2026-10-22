/** 默认关闭的维护调度→真实S0/S2→单批复验；模型HTTP只有固定替身。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path')
const NativeDate = Date
let clock = NativeDate.parse('2026-10-16T12:00:00+08:00'), live = true, cancelDuringLoad = false
let onLoad
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return clock }
}
const config = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
let configuredModel = 'deepseek-v4-flash'
config.loadConfig = async () => {
  if (cancelDuringLoad) live = false
  onLoad?.()
  return { apiKey: 'fake-scheduler-key', provider: 'fixture', model: configuredModel, baseURL: 'https://example.invalid/v1', chatProtocol: 'openai-chat' }
}
// 配置替身仍执行原规划取消钩子；未配置精确节点时禁止回落到其他型号。
require('koishi-plugin-dongxuelian-ai/lib/core/ai-capability-config').resolveConfiguredCapabilityModel = (capability, provider, model) => {
  if (cancelDuringLoad) live = false
  onLoad?.()
  assert.equal(capability, 'text'); assert.equal(provider, 'custom-1c571761199978de80368aba')
  if (model !== configuredModel) throw new Error('指定模型节点必须唯一匹配已配置能力模型池')
  return { capability, provider, providerName: '配置替身', model, apiKey: 'fake-scheduler-key', baseURL: 'https://example.invalid/v1', chatProtocol: 'openai-chat', priorityIndex: 0 }
}
require('koishi-plugin-dongxuelian-ai/lib/core/capability-failure-notifier').notifyCapabilityStepFailure = async () => false
const gates = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const tasks = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const records = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const { PagedReportStore } = require('../../../koishi-plugin-daily-report/lib/report-storage')
const { provisionReportBackgroundLedger } = require('../../../koishi-plugin-daily-report/lib/report-background-ledger')
const { runDailyPreanalysisPlanningTick: tick } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/daily-preanalysis-submission')
const { runTaskWithTimeout } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const kind = 'daily_report_preanalysis', period = createReportPeriod(clock), logs = []
const ctx = { logger() { return { warn(message) { logs.push(message) } } } }
let calls = 0, gate

// 频道发现仅提供候选提示；真正的全文与完成判定仍由正式规划器核验。
function seed(channel, content, age) {
  for (let index = 0; index < 3; index++) records.appendReportRecord(period.reportDate, channel, {
    messageId: channel + '-' + index, timestamp: period.cutoffMs - age + index * 100,
    userId: 'member', userName: '成员', text: content + (content === '[图片]' ? '' : index),
  })
  const file = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'daily-precompute/coverage', period.reportDate, channel + '.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ channelKey: channel, date: period.reportDate, totalMessages: 3, updatedAt: new Date(clock).toISOString() }))
}

// 显式交付建账独占步骤不在定时器内，缺失时调度必须停止且零请求。
async function provision() {
  gate = await gates.acquireResourceGate({ taskId: 'provision', kind, owner: 'fixture', waitTimeoutMs: 0 })
  await assert.rejects(gates.acquireResourceGate({ taskId: 'contender', kind, owner: 'fixture', waitTimeoutMs: 0 }), error => error instanceof gates.ResourceGateBusyTimeoutError)
  const store = new PagedReportStore({ taskId: 'provision', channelKey: 'a-ready', deadlineMs: clock + 90000,
    assertActive() {}, assertLease() { assert.equal(gates.getResourceGateStatus().meta.ticketId, gate.ticketId) } })
  provisionReportBackgroundLedger(store)
  gate.release('provision-finished'); gate = null
}

// 规划不调用fetch；实际工作器单批完成后，下一次规划应精确跳过已可信完成项。
async function main() {
  const oldFetch = global.fetch
  global.fetch = async (_url, options) => {
    calls++
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.enable_thinking, false)
    const input = JSON.parse(body.messages[1].content)
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      groups: { 'social:1': '社交互动' }, records: Object.fromEntries(input.items.map(item => [item.ref, 'social:1'])), quotes: [], completed: true,
    }) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { status: 200 })
  }
  try {
    seed('a-ready', '可追溯的原话', 30 * 60000)
    seed('b-tail', '尾部原话', 1000)
    seed('c-image', '[图片]', 30 * 60000)
    delete process.env.DAILY_REPORT_PREANALYSIS_ENABLED
    assert.equal((await tick(ctx)).reason, 'disabled')
    assert.equal(tasks.listActiveDailyReportTasks().length, 0)
    process.env.DAILY_REPORT_PREANALYSIS_ENABLED = '1'
    assert.equal((await tick(ctx)).reason, 'disabled')
    process.env.DAILY_REPORT_GROUNDED_ENABLED = '1'
    process.env.DAILY_REPORT_GROUNDED_PROVIDER = 'custom-1c571761199978de80368aba'
    process.env.DAILY_REPORT_GROUNDED_MODEL = 'deepseek-v4-flash'
    configuredModel = 'fixture-other-model'
    assert.equal((await tick(ctx)).reason, 'planning_failed'); assert.equal(calls, 0)
    assert(logs.some(line => line.includes('指定模型节点必须唯一匹配')))
    assert.equal(tasks.listActiveDailyReportTasks().length, 0)
    configuredModel = 'deepseek-v4-flash'
    assert.equal((await tick(ctx)).reason, 'planning_failed'); assert.equal(calls, 0)
    assert(logs.some(line => line.includes('锚点缺失')))
    await provision()
    assert.equal((await tick(ctx)).planned, 1); assert.equal(calls, 0)
    let pending = tasks.listActiveDailyReportTasks()
    assert.equal(pending.length, 1); assert.equal(pending[0].channelKey, 'a-ready')
    assert.equal(pending[0].priority, 99); assert.equal(pending[0].timeoutMs, 90000)
    assert.equal(pending[0].notify.target, 'none'); assert.equal(pending[0].startedAt, undefined)
    assert.equal((await tick(ctx)).reason, 'active_report_task')
    tasks.cancelTask(pending[0].id)
    assert.equal((await tick(ctx)).planned, 0); assert.equal(calls, 0)
    clock += 300000
    assert.equal((await tick(ctx)).planned, 1)
    pending = tasks.listActiveDailyReportTasks(); assert.equal(pending.length, 1)
    const running = tasks.markTaskRunning(tasks.claimTaskById(pending[0].id, 'fixture-worker'), 'fixture-worker')
    gate = await gates.acquireResourceGate({ taskId: running.id, kind, owner: 'fixture-worker', waitTimeoutMs: 0 })
    const result = await runTaskWithTimeout(running)
    assert.equal(result.status, 'complete'); assert.equal(calls, 1)
    tasks.completeTask(running, result); gate.release('classified'); gate = null
    clock += 300000
    assert.equal((await tick(ctx)).planned, 0); assert.equal(calls, 1)
    assert.equal(tasks.listActiveDailyReportTasks().length, 0)
    tasks.submitResourceTask({ id: 'front', kind: 'daily_report', channelKey: 'a-ready', payload: { ...period } })
    assert.equal((await tick(ctx)).reason, 'active_report_task'); tasks.cancelTask('front')
    cancelDuringLoad = true
    await assert.rejects(tick(ctx, () => live), /规划已取消/)
    assert.equal(gates.getResourceGateStatus().locked, false)
    assert.equal(tasks.listActiveDailyReportTasks().length, 0); assert.equal(calls, 1)
    // 触发实际维护回调，在规划await中dispose；不得重新挂定时器或提交后台。
    const startup = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
    const nativeSet = global.setTimeout, nativeClear = global.clearTimeout, timers = new Map()
    global.setTimeout = (callback, ms) => { const handle = { unref() {} }; timers.set(handle, { callback, ms }); return handle }
    global.clearTimeout = handle => { if (!timers.delete(handle)) nativeClear(handle) }
    try {
      cancelDuringLoad = false; onLoad = () => startup.clearStartupSchedulers()
      startup.scheduleDailyPrecomputePlanning(ctx)
      assert.equal(timers.size, 1)
      const first = [...timers.entries()][0]; timers.delete(first[0])
      await first[1].callback()
      assert.equal(timers.size, 0)
      assert.equal(tasks.listActiveDailyReportTasks().length, 0); assert.equal(calls, 1)
    } finally { startup.clearStartupSchedulers(); global.setTimeout = nativeSet; global.clearTimeout = nativeClear; onLoad = undefined }
    console.log(JSON.stringify({ defaultOff: true, zeroWaitGate: true, missingLedgerStops: true, plannerZeroCalls: true,
      candidateOnly: true, activeDedupe: true, durableScheduleCooldown: true, workerRevalidates: true,
      completedCacheSkipped: true, foregroundPriority: true, disposedNoSubmission: true, existingTimerDispose: true, onlyConfiguredDeepseek: true }))
  } finally {
    if (gate) gate.release('fixture-finally')
    global.fetch = oldFetch; global.Date = NativeDate; delete process.env.DAILY_REPORT_PREANALYSIS_ENABLED
    require('koishi-plugin-dongxuelian-ai/lib/core/api').flushTokenUsage()
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
