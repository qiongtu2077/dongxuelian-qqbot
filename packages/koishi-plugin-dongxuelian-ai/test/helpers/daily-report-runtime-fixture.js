'use strict'

const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const paths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const { createReportAnalysisDiagnostics } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis')
const dailyWorkerPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/daily-worker')
const pipelinePath = require.resolve('../../../koishi-plugin-daily-report/lib/report-pipeline')
const dailyWorker = require(dailyWorkerPath)
let dispatched = 0
let actualAbort = 0
let mode = 'queued'
let pipelineOptions

// 保留真实日报worker窗口解析，只在模型管线边界控制挂起与返回。
require.cache[pipelinePath] = { id: pipelinePath, filename: pipelinePath, loaded: true, exports: {
  async generateDailyReportResult(options) { pipelineOptions = options; return { ok: true, mode: 'text', reason: 'fixture' } },
} }
require.cache[dailyWorkerPath] = { id: dailyWorkerPath, filename: dailyWorkerPath, loaded: true, exports: {
  async runDailyWorkerTask(task, runtime) {
    dispatched++
    if (mode === 'queued') return dailyWorker.runDailyWorkerTask(task, runtime)
    const diagnostics = createReportAnalysisDiagnostics({ windowMessageCount: 591, selectedMessageCount: 591, sourceCompleteness: 'complete' })
    diagnostics.submittedMessageCount = 300
    diagnostics.summarizedMessageCount = 200
    diagnostics.stages.compression = 'processing'
    diagnostics.tokenUsage = { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
    diagnostics.usageReadableRequests = 1
    const resultDir = paths.getTaskResultDir(task.id)
    fs.mkdirSync(resultDir, { recursive: true })
    fs.writeFileSync(path.join(resultDir, 'analysis-progress.json'), JSON.stringify({ taskId: task.id, reportPolicyVersion: 2, analysisMeta: diagnostics }))
    return new Promise((_resolve, reject) => runtime.signal.addEventListener('abort', () => { actualAbort++; reject(runtime.signal.reason) }, { once: true }))
  },
} }
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')

// 使用实际任务文件和短余量触发统一600秒截止，创建时间不参与运行时限。
async function run() {
  const submittedAt = Date.parse('2026-10-01T23:59:00+08:00')
  const period = createReportPeriod(submittedAt)
  const queued = store.submitResourceTask({ id: 'runtime-queued', kind: 'daily_report', channelKey: 'runtime-fixture', payload: { ...period, reportPolicyVersion: 2 } })
  const startedAtMs = Date.now()
  queued.createdAt = new Date(submittedAt).toISOString()
  queued.startedAt = new Date(startedAtMs).toISOString()
  queued.timeoutMs = 600000
  await worker.runTaskWithTimeout(queued)
  assert.equal(pipelineOptions.deadlineMs, startedAtMs + 600000)
  assert.equal(pipelineOptions.startedAtMs, startedAtMs)
  assert.equal(pipelineOptions.reportPeriod.cutoffMs, period.cutoffMs)
  assert.equal(pipelineOptions.reportPeriod.reportDate, period.reportDate)
  assert(pipelineOptions.signal instanceof AbortSignal)

  const expired = { ...queued, startedAt: new Date(Date.now() - 600001).toISOString() }
  const beforeExpired = dispatched
  await assert.rejects(worker.runTaskWithTimeout(expired), error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
  assert.equal(dispatched, beforeExpired)

  const hanging = store.submitResourceTask({ id: 'runtime-hanging', kind: 'daily_report', channelKey: 'runtime-fixture' })
  hanging.startedAt = new Date(Date.now() - 599960).toISOString()
  hanging.timeoutMs = 600000
  mode = 'hanging'
  let failure
  try { await worker.runTaskWithTimeout(hanging) } catch (error) { failure = error }
  assert.equal(failure.code, 'DAILY_REPORT_TOTAL_TIMEOUT')
  assert.equal(actualAbort, 1)
  await new Promise(resolve => setTimeout(resolve, 12))
  const failed = store.failTask(hanging, failure)
  assert.equal(failed.status, 'failed')
  const saved = JSON.parse(fs.readFileSync(path.join(paths.getTaskResultDir(hanging.id), 'result.json'), 'utf8'))
  assert.equal(saved.failureKind, 'total_timeout')
  assert.equal(saved.analysisMeta.windowMessageCount, 591)
  assert.equal(saved.analysisMeta.submittedMessageCount, 300)
  assert.equal(saved.analysisMeta.summarizedMessageCount, 200)
  assert.equal(saved.analysisMeta.tokenUsage.totalTokens, 150)
  assert.equal(saved.analysisMeta.analysisState, 'total_timeout')
  assert.equal(failed.notify.failureNotificationVersion, 2)
  mode = 'queued'
  await worker.runTaskWithTimeout({ ...queued, startedAt: new Date().toISOString() })
  assert.equal(actualAbort, 1)
  console.log(JSON.stringify({ queueExcluded: true, fixedPeriod: true, noExpiredDispatch: true, actualAbort: true, diagnosticPreserved: true, nextTask: true }))
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
