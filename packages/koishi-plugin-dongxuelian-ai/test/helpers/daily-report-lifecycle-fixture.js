/** 用真实任务文件验证资源等待、同任务截止与重启后的迟到提交。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const paths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const NativeDate = Date
const baseMs = NativeDate.parse('2026-10-01T12:00:00+08:00')
const kind = process.env.REPORT_LIFECYCLE_KIND || 'daily_report'
const duration = kind === 'daily_report_preanalysis' ? 90000 : 600000
let nowMs = baseMs
// 只改变场景时钟，六百秒场景不需要真实等待十分钟。
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [nowMs])) }
  static now() { return nowMs }
}
let gateAction
let releases = 0
let drainedAfterAbort = false
const executions = []
const activeGuards = new Map()

// 在已有资源及执行边界注入确定结果，保留真实领取与状态落盘。
const gatePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
require.cache[gatePath] = { id: gatePath, filename: gatePath, loaded: true, exports: {
  async acquireResourceGate(options) {
    await gateAction(options)
    return { updateStep() {}, release() { releases++ } }
  },
} }
const admissionPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
require.cache[admissionPath] = { id: admissionPath, filename: admissionPath, loaded: true, exports: {
  admitTask() { return { decision: 'allow', reason: 'lifecycle fixture' } },
} }
const dailyPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/daily-worker')
require.cache[dailyPath] = { id: dailyPath, filename: dailyPath, loaded: true, exports: {
  async runDailyWorkerTask(task, runtime) {
    assert.equal(typeof runtime.assertActive, 'function')
    runtime.assertActive()
    activeGuards.set(task.id, runtime.assertActive)
    executions.push({ id: task.id, startedAtMs: runtime.startedAtMs, deadlineMs: runtime.deadlineMs })
    if (task.id === 'timeout-drain') {
      await new Promise(resolve => runtime.signal.addEventListener('abort', () => setTimeout(() => {
        drainedAfterAbort = true; resolve()
      }, 10), { once: true }))
      throw runtime.signal.reason
    }
    return { mode: 'fixture', reason: 'completed' }
  },
} }
require.cache[dailyPath].exports.runDailyPreanalysisWorkerTask = require.cache[dailyPath].exports.runDailyWorkerTask
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')

// 建立明确日报任务，再通过公共状态接口进入实际运行。
function createRunning(id) {
  store.submitResourceTask({ id, kind, channelKey: 'lifecycle', timeoutMs: 600000 })
  return store.markTaskRunning(store.claimTaskById(id, 'lifecycle-worker'), 'lifecycle-worker', 'running')
}

// 资源等待不创建首次起点，锁失败可以回排，等待中取消禁止执行。
async function verifyGateBoundary() {
  store.submitResourceTask({ id: 'gate-waiting', kind, channelKey: 'lifecycle', timeoutMs: 600000 })
  gateAction = async options => {
    const waiting = store.getResourceTaskById(options.taskId)
    assert.equal(waiting.status, 'claiming')
    assert.equal(waiting.startedAt, undefined)
    assert.equal(store.claimTaskById(options.taskId, 'duplicate-worker'), null)
    nowMs += 120000
  }
  await worker.runOneQueuedTask({ type: 'daily', workerName: 'lifecycle-worker' })
  assert.equal(store.getResourceTaskById('gate-waiting').status, 'done')
  assert.deepEqual(executions[0], { id: 'gate-waiting', startedAtMs: nowMs, deadlineMs: nowMs + duration })
  store.submitResourceTask({ id: 'gate-failed', kind, channelKey: 'lifecycle', timeoutMs: 600000 })
  gateAction = async () => { throw new Error('fixture lock unavailable') }
  assert.equal(await worker.runOneQueuedTask({ type: 'daily', workerName: 'lifecycle-worker' }), false)
  const waiting = store.getResourceTaskById('gate-failed')
  assert.equal(waiting.status, 'pending')
  assert.equal(waiting.startedAt, undefined)
  assert.equal(store.cancelTask(waiting.id), true)
  store.submitResourceTask({ id: 'gate-cancelled', kind, channelKey: 'lifecycle', timeoutMs: 600000 })
  gateAction = async () => { store.discardInterruptedResourceTaskState('fixture restart while waiting') }
  await worker.runOneQueuedTask({ type: 'daily', workerName: 'lifecycle-worker' })
  assert.equal(store.getResourceTaskById('gate-cancelled').status, 'cancelled')
  assert.equal(executions.length, 1)
  assert.equal(releases, 2)
}

// 同日报在第五百九十秒回排后只剩原额度，非法起点和过期任务不派发。
async function verifyOriginalDeadline() {
  const running = createRunning('same-task-deadline')
  const originalStart = running.startedAt
  const originalMs = Date.parse(originalStart)
  nowMs = originalMs + duration - 10000
  const pending = store.requeueTask(running, 'fixture retry')
  assert.equal(pending.startedAt, originalStart)
  nowMs = originalMs + duration - 5000
  const resumed = store.markTaskRunning(store.claimTaskById(pending.id, 'retry-worker'), 'retry-worker', 'running')
  assert.equal(resumed.startedAt, originalStart)
  await worker.runTaskWithTimeout(resumed)
  assert.equal(executions.at(-1).deadlineMs, originalMs + duration)
  store.requeueTask(resumed, 'fixture expired retry')
  assert.throws(activeGuards.get(resumed.id), /领取已失效/)
  nowMs = originalMs + duration + 1
  const expired = store.markTaskRunning(store.claimTaskById(pending.id, 'expired-worker'), 'expired-worker', 'running')
  const before = executions.length
  await assert.rejects(worker.runTaskWithTimeout(expired), error => kind === 'daily_report' ? error.code === 'DAILY_REPORT_TOTAL_TIMEOUT' : /timed out/.test(error.message))
  await assert.rejects(worker.runTaskWithTimeout({ ...expired, startedAt: 'invalid' }), /首次运行起点无效/)
  assert.equal(executions.length, before)
  store.failTask(expired, new Error('fixture expired'))
  store.submitResourceTask({ id: 'ordinary-requeue', kind: 'agent_task', channelKey: 'lifecycle' })
  const ordinary = store.markTaskRunning(store.claimTaskById('ordinary-requeue', 'ordinary-worker'), 'ordinary-worker')
  assert.equal(store.requeueTask(ordinary).startedAt, undefined)
}

// 重启取消旧执行的所有等待状态，旧结果不落盘，新任务另有身份与额度。
async function verifyRestartAndLateResults() {
  const oldRunning = createRunning('restart-running')
  const oldPending = store.requeueTask(createRunning('restart-pending'))
  const oldDeferred = store.deferTask(createRunning('restart-deferred'))
  store.submitResourceTask({ id: 'fresh-pending', kind, channelKey: 'lifecycle', timeoutMs: 600000 })
  nowMs += duration - 10000
  const discarded = store.discardInterruptedResourceTaskState('fixture restart at 590 seconds')
  assert.equal(discarded.cancelled, 3)
  for (const old of [oldRunning, oldPending, oldDeferred]) {
    assert.equal(store.getResourceTaskById(old.id).status, 'cancelled')
    store.completeTask(old, { reply: 'forbidden late result' })
    store.requeueTask(old, 'forbidden restart')
    store.failTask(old, new Error('forbidden late failure'))
    assert.equal(store.getResourceTaskById(old.id).status, 'cancelled')
    assert.equal(store.claimTaskById(old.id, 'duplicate-worker'), null)
    assert.equal(fs.existsSync(path.join(paths.getTaskResultDir(old.id), 'result.json')), false)
  }
  assert.equal(store.getResourceTaskById('fresh-pending').status, 'pending')
  const fresh = store.markTaskRunning(store.claimTaskById('fresh-pending', 'fresh-worker'), 'fresh-worker')
  await worker.runTaskWithTimeout(fresh)
  assert.equal(executions.at(-1).startedAtMs, nowMs)
  assert.equal(executions.at(-1).deadlineMs, nowMs + duration)
  store.completeTask(fresh, { reply: 'fresh result' })
}

// 当前领取可以写产物，领取者、领取时刻或首次起点变化均拒绝旧执行。
async function verifyActiveClaim() {
  const running = createRunning('active-claim')
  await worker.runTaskWithTimeout(running)
  const guard = activeGuards.get(running.id)
  assert.doesNotThrow(guard)
  const file = paths.getTaskFile('running', running.kind, running.id)
  for (const [field, value] of [['claimedBy', 'other-worker'], ['claimedAt', new Date(nowMs + 1).toISOString()], ['startedAt', new Date(nowMs + 2).toISOString()]]) {
    fs.writeFileSync(file, JSON.stringify({ ...running, [field]: value }))
    assert.throws(guard, /领取已失效/)
    store.completeTask(running, { reply: 'forbidden replaced-claim result' })
    store.requeueTask(running, 'forbidden replaced-claim retry')
    store.failTask(running, new Error('forbidden replaced-claim failure'))
    assert.equal(store.getResourceTaskById(running.id).status, 'running')
    assert.equal(store.getResourceTaskById(running.id)[field], value)
    assert.equal(fs.existsSync(path.join(paths.getTaskResultDir(running.id), 'result.json')), false)
    fs.writeFileSync(file, JSON.stringify(running))
    assert.doesNotThrow(guard)
  }
  const cancelled = store.cancelResourceTasksByKind(kind, ['running'], 'fixture', 'fixture running cancellation')
  assert(cancelled.some(task => task.id === running.id))
  assert.throws(guard, /已取消/)
  assert.equal(fs.existsSync(path.join(paths.getTaskResultDir(running.id), 'result.json')), false)
}

// 顺序验证真实状态行为，失败直接由隔离子进程报告。
async function run() {
  await verifyGateBoundary()
  await verifyOriginalDeadline()
  await verifyRestartAndLateResults()
  await verifyActiveClaim()
  if (kind === 'daily_report_preanalysis') {
    const running = createRunning('timeout-drain')
    nowMs = Date.parse(running.startedAt) + duration - 20
    await assert.rejects(worker.runTaskWithTimeout(running), /timed out/)
    assert(drainedAfterAbort, '后台超时返回前必须等执行边界实际清理')
    store.failTask(running, new Error('fixture timeout'))
  }
  console.log(JSON.stringify({ gateWaitExcluded: true, gateFailureUnstarted: true, cancelledBeforeRun: true, duplicateClaimRejected: true,
    retryPreservesDeadline: true, expiredDoesNotDispatch: true, otherKindUnchanged: true, restartCancelsWaitingExecution: true,
    lateResultsRejected: true, freshTaskIndependent: true, activeClaimValidated: true, cancelledClaimRejected: true, staleTransitionsRejected: true,
    timeoutDrained: drainedAfterAbort }))
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
