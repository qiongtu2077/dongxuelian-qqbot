/** 真实S0/S2与正式管线：同任务更换票据不能让旧模型返回继续写入。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const { getTaskResultDir } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const { acquireResourceGate, getResourceGateStatus } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const { appendReportRecord } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const api = require('koishi-plugin-dongxuelian-ai/lib/core/api')
const config = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
const { runTaskWithTimeout } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const { makeModelRequest } = require('../../../koishi-plugin-daily-report/test/analysis-entry-test')
const { listPagedStoreFiles } = require('../../../koishi-plugin-daily-report/test/helpers/report-store-fixture')
const period = createReportPeriod(Date.now()), taskId = 'report-lease-replaced', channelKey = 'lease-replaced-group'

// 配置与模型是明确替身，资源票据、任务身份、管线及所有文件仍使用真实实现。
async function run() {
  let gate, calls = 0, oldTicket, newTicket
  const request = api.requestChatCompletions, load = config.loadConfig
  try {
    config.loadConfig = async () => ({ apiKey: 'fake-fixture-key', model: 'fixture-model', provider: 'opencode', baseURL: 'https://example.invalid' })
    for (let index = 0; index < 3; index++) appendReportRecord(period.reportDate, channelKey, {
      messageId: 'lease-message-' + index, timestamp: period.cutoffMs - 3000 + index * 1000,
      userId: 'fixture-member', userName: '测试成员', text: '明确原话' + index,
    })
    taskStore.submitResourceTask({ id: taskId, kind: 'daily_report', channelKey, timeoutMs: 600000,
      payload: { ...period, renderImage: false }, notify: { target: 'none', status: 'pending' } })
    const task = taskStore.markTaskRunning(taskStore.claimTaskById(taskId, 'lease-fixture'), 'lease-fixture')
    gate = await acquireResourceGate({ taskId, kind: task.kind, owner: 'lease-fixture', waitTimeoutMs: 0 })
    oldTicket = gate.ticketId
    api.requestChatCompletions = async (...args) => {
      calls++
      const value = await makeModelRequest([])(...args)
      gate.release('fixture lease replaced during model')
      gate = await acquireResourceGate({ taskId, kind: task.kind, owner: 'lease-fixture', waitTimeoutMs: 0 })
      newTicket = gate.ticketId
      return value
    }
    await assert.rejects(runTaskWithTimeout(task), error => {
      assert.match(error.message, /S0独占租约已失效/)
      assert.equal(error.code, 'DAILY_REPORT_GENERATION_FAILED')
      assert.equal(error.diagnostics.requestCount, 1)
      assert(error.diagnostics.warnings.some(text => text.includes('失败进度保存失败')))
      return true
    })
    assert.equal(calls, 1); assert.notEqual(oldTicket, newTicket)
    assert.equal(taskStore.getResourceTaskById(taskId).status, 'running')
    assert.equal(getResourceGateStatus().meta.ticketId, newTicket)
    const root = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'daily-analysis')
    assert(!listPagedStoreFiles(root).some(file => /\.(?:success|failure)\.json$/.test(file)))
    assert(!fs.existsSync(path.join(getTaskResultDir(taskId), 'result.json')))
    assert(!fs.existsSync(path.join(getTaskResultDir(taskId), 'report.txt')))
    taskStore.failTask(task, new Error('fixture verified old lease rejected'))
    console.log(JSON.stringify({ actualS0TicketGuard: true, sameTaskNewTicketRejected: true, noLateSuccessOrDiagnostic: true, noMoreModelCalls: true }))
  } finally {
    api.requestChatCompletions = request; config.loadConfig = load
    if (gate) gate.release('lease-fixture-finished')
    api.flushTokenUsage()
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1 })
