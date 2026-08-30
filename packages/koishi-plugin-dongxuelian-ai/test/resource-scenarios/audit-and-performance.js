'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// === Scenario 26: 阶段 D.20 固定 taskId 重复提交不得重新制造 pending / task_created ===
function testExplicitTaskIdResubmitDoesNotRecreatePendingOrEvents() {
  const dataDir = createTempDataDir('resource-regress-submit-idempotent-')
  const script = String.raw`
const fs = require('fs')
const taskClient = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-client')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function countTaskCreated(taskId) {
  return readEvents().filter(event => event.event === 'task_created' && event.taskId === taskId).length
}

function listLiveStatuses(taskId, kind) {
  return ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => fs.existsSync(taskPaths.getTaskFile(status, kind, taskId)))
}

taskStore.ensureTaskDirs()

// Case A: same explicit taskId resubmitted while canonical pending already exists.
const pendingInput = {
  id: 'task-submit-explicit-pending-1',
  kind: 'daily_summary',
  source: 'resource-regression-submit',
  channelKey: 'group-submit-idempotent',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { slotId: 'pending-explicit-1' },
  notify: { target: 'none', status: 'pending' },
}
const pendingFirst = taskClient.submitWorkerTaskWithAdmission(pendingInput, { checkAdmission: false, exclusive: false })
const pendingSecond = taskClient.submitWorkerTaskWithAdmission(pendingInput, { checkAdmission: false, exclusive: false })

// Case B: same explicit taskId resubmitted after canonical failed already exists.
const failedInput = {
  id: 'task-submit-explicit-failed-1',
  kind: 'daily_summary',
  source: 'resource-regression-submit',
  channelKey: 'group-submit-idempotent',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { slotId: 'failed-explicit-1' },
  notify: { target: 'none', status: 'pending' },
}
const failedSeed = taskClient.submitWorkerTaskWithAdmission(failedInput, { checkAdmission: false, exclusive: false })
taskStore.failTask(failedSeed.task, new Error('seed failed canonical copy'), { reason: 'seed failed canonical copy' })
const failedResubmit = taskClient.submitWorkerTaskWithAdmission(failedInput, { checkAdmission: false, exclusive: false })

// Case C: same explicit taskId resubmitted after canonical deferred already exists.
const deferredInput = {
  id: 'task-submit-explicit-deferred-1',
  kind: 'daily_summary',
  source: 'resource-regression-submit',
  channelKey: 'group-submit-idempotent',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { slotId: 'deferred-explicit-1' },
  notify: { target: 'none', status: 'pending' },
}
const deferredSeed = taskClient.submitWorkerTaskWithAdmission(deferredInput, { checkAdmission: false, exclusive: false })
taskStore.deferTask(deferredSeed.task, 'seed deferred canonical copy')
const deferredResubmit = taskClient.submitWorkerTaskWithAdmission(deferredInput, { checkAdmission: false, exclusive: false })

console.log(JSON.stringify({
  pendingFirstTaskId: pendingFirst.task && pendingFirst.task.id || '',
  pendingSecondTaskId: pendingSecond.task && pendingSecond.task.id || '',
  pendingSecondStatus: pendingSecond.task && pendingSecond.task.status || '',
  pendingTaskCreatedCount: countTaskCreated(pendingInput.id),
  pendingLiveStatuses: listLiveStatuses(pendingInput.id, pendingInput.kind),
  failedResubmitStatus: failedResubmit.task && failedResubmit.task.status || '',
  failedTaskCreatedCount: countTaskCreated(failedInput.id),
  failedLiveStatuses: listLiveStatuses(failedInput.id, failedInput.kind),
  failedCanonicalStatusAfter: taskStore.getResourceTaskById(failedInput.id) && taskStore.getResourceTaskById(failedInput.id).status || '',
  deferredResubmitStatus: deferredResubmit.task && deferredResubmit.task.status || '',
  deferredTaskCreatedCount: countTaskCreated(deferredInput.id),
  deferredLiveStatuses: listLiveStatuses(deferredInput.id, deferredInput.kind),
  deferredCanonicalStatusAfter: taskStore.getResourceTaskById(deferredInput.id) && taskStore.getResourceTaskById(deferredInput.id).status || '',
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.20 explicit taskId resubmit idempotency compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.20 resubmitting the same explicit pending task does not write a second task_created event',
    summary.pendingFirstTaskId === 'task-submit-explicit-pending-1'
      && summary.pendingSecondTaskId === 'task-submit-explicit-pending-1'
      && summary.pendingSecondStatus === 'pending'
      && summary.pendingTaskCreatedCount === 1
      && JSON.stringify(summary.pendingLiveStatuses) === JSON.stringify(['pending']),
    JSON.stringify(summary))
  check('D.20 resubmitting the same explicit failed task does not recreate pending beside canonical failed copy',
    summary.failedResubmitStatus === 'failed'
      && summary.failedTaskCreatedCount === 1
      && JSON.stringify(summary.failedLiveStatuses) === JSON.stringify(['failed'])
      && summary.failedCanonicalStatusAfter === 'failed',
    JSON.stringify(summary))
  check('D.20 resubmitting the same explicit deferred task does not recreate pending beside canonical deferred copy',
    summary.deferredResubmitStatus === 'deferred'
      && summary.deferredTaskCreatedCount === 1
      && JSON.stringify(summary.deferredLiveStatuses) === JSON.stringify(['deferred'])
      && summary.deferredCanonicalStatusAfter === 'deferred',
    JSON.stringify(summary))
}

// === Scenario 27: 阶段 D.21 deferred 审计不应把 no-op 迁移误记成 restored/failed ===
function testDeferredAuditDoesNotCountNoOpTransitions() {
  const dataDir = createTempDataDir('resource-regress-deferred-audit-noop-')
  const script = String.raw`
const fs = require('fs')
const Module = require('module')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  if (normalized.endsWith('/resource-scheduler/admission') || normalized.includes('resource-scheduler/admission')) {
    const decideAdmission = (input) => {
      const taskId = String(input && input.taskId || '')
      if (taskId === 'task-deferred-audit-noop-restore-1') {
        return { decision: 'run_now', reason: 'test restore admission' }
      }
      if (taskId === 'task-deferred-audit-noop-reject-1') {
        return { decision: 'reject', reason: 'test reject admission' }
      }
      return { decision: 'defer', reason: 'unexpected test admission' }
    }
    return {
      admitTask: decideAdmission,
      decideAdmission,
    }
  }
  return originalLoad.apply(this, arguments)
}

const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')

taskStore.ensureTaskDirs()

function createDeferredWithCanonicalDone(taskId) {
  const seed = taskStore.submitResourceTask({
    id: taskId,
    kind: 'daily_summary',
    source: 'resource-regression-deferred-audit',
    channelKey: 'group-deferred-audit',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: { slotId: taskId },
    notify: { target: 'none', status: 'pending' },
  })
  const deferred = taskStore.deferTask(seed, 'seed deferred audit copy')
  const doneFile = taskPaths.getTaskFile('done', deferred.kind, deferred.id)
  fs.writeFileSync(doneFile, JSON.stringify({
    ...deferred,
    status: 'done',
    step: 'done',
    finishedAt: '2026-06-11T00:08:00.000Z',
    error: '',
  }, null, 2), 'utf8')
  return deferred
}

const restoreTask = createDeferredWithCanonicalDone('task-deferred-audit-noop-restore-1')
const rejectTask = createDeferredWithCanonicalDone('task-deferred-audit-noop-reject-1')

const beforeEvents = readEvents()
const beforeAuditEventCount = beforeEvents.filter(event => event.event === 'deferred_tasks_audited').length
const summary = supervisor.auditDeferredTasks(50)
const afterEvents = readEvents()
const afterAuditEvents = afterEvents.filter(event => event.event === 'deferred_tasks_audited')
const requeueEvents = afterEvents.filter(event => event.event === 'task_requeued' && event.taskId === restoreTask.id).length
const failEvents = afterEvents.filter(event => event.event === 'task_failed' && event.taskId === rejectTask.id).length

console.log(JSON.stringify({
  restored: summary.restored,
  failed: summary.failed,
  auditEventDelta: afterAuditEvents.length - beforeAuditEventCount,
  restoreLiveStatuses: ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => fs.existsSync(taskPaths.getTaskFile(status, 'daily_summary', restoreTask.id))),
  rejectLiveStatuses: ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => fs.existsSync(taskPaths.getTaskFile(status, 'daily_summary', rejectTask.id))),
  restoreCanonicalStatusAfter: taskStore.getResourceTaskById(restoreTask.id) && taskStore.getResourceTaskById(restoreTask.id).status || '',
  rejectCanonicalStatusAfter: taskStore.getResourceTaskById(rejectTask.id) && taskStore.getResourceTaskById(rejectTask.id).status || '',
  requeueEventCount: requeueEvents,
  failEventCount: failEvents,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.21 deferred audit no-op transition compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.21 deferred restore no-op is not counted as restored and does not emit deferred audit summary event',
    summary.restored === 0
      && summary.auditEventDelta === 0
      && JSON.stringify(summary.restoreLiveStatuses) === JSON.stringify(['done', 'deferred'])
      && summary.restoreCanonicalStatusAfter === 'done'
      && summary.requeueEventCount === 0,
    JSON.stringify(summary))
  check('D.21 deferred reject no-op is not counted as failed and does not emit task_failed event',
    summary.failed === 0
      && JSON.stringify(summary.rejectLiveStatuses) === JSON.stringify(['done', 'deferred'])
      && summary.rejectCanonicalStatusAfter === 'done'
      && summary.failEventCount === 0,
    JSON.stringify(summary))
}

// === Scenario 28: 阶段 D.22 stale running 审计不应把 no-op fail 误记成 recovered ===
function testStaleRunningAuditDoesNotCountNoOpFailure() {
  const dataDir = createTempDataDir('resource-regress-stale-running-noop-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

taskStore.ensureTaskDirs()

const seed = taskStore.submitResourceTask({
  id: 'task-stale-running-noop-1',
  kind: 'agent_task',
  source: 'resource-regression-stale-running',
  channelKey: 'group-stale-running',
  userId: 'tester',
  priority: 40,
  timeoutMs: 120000,
  payload: { entry: 'stale-running-noop' },
  notify: { target: 'none', status: 'pending' },
})

const claiming = taskStore.claimTaskById(seed.id, 'stale-running-worker')
if (!claiming) throw new Error('expected claiming task before stale running regression')
const running = taskStore.markTaskRunning(claiming, 'stale-running-worker', 'working')
if (!running || running.status !== 'running') throw new Error('expected running task before stale running regression')

const runningFile = taskPaths.getTaskFile('running', running.kind, running.id)
const staleRunning = JSON.parse(fs.readFileSync(runningFile, 'utf8'))
staleRunning.updatedAt = '2026-06-01T00:00:00.000Z'
staleRunning.startedAt = '2026-06-01T00:00:00.000Z'
fs.writeFileSync(runningFile, JSON.stringify(staleRunning, null, 2), 'utf8')

const doneFile = taskPaths.getTaskFile('done', running.kind, running.id)
fs.writeFileSync(doneFile, JSON.stringify({
  ...staleRunning,
  status: 'done',
  step: 'done',
  finishedAt: '2026-06-11T00:09:00.000Z',
  error: '',
}, null, 2), 'utf8')

const workerStateFile = taskPaths.getWorkerStateFile('stale-running-worker')
fs.mkdirSync(require('path').dirname(workerStateFile), { recursive: true })
fs.writeFileSync(workerStateFile, JSON.stringify({
  name: 'stale-running-worker',
  pid: 0,
  startedAt: '2026-06-01T00:00:00.000Z',
  heartbeatAt: '2026-06-01T00:00:00.000Z',
  alive: false,
  step: 'working',
}, null, 2), 'utf8')

const cleanupBefore = systemProtection.getSystemProtectionStatus().cleanupEvents || []
const recovered = supervisor.auditStaleRunningTasks(30000)
const cleanupAfter = systemProtection.getSystemProtectionStatus().cleanupEvents || []
const staleRecoveredEvents = cleanupAfter.filter(event => event.event === 'worker_stale_recovered' && event.taskId === running.id)

console.log(JSON.stringify({
  recovered,
  cleanupEventDelta: cleanupAfter.length - cleanupBefore.length,
  staleRecoveredEventCount: staleRecoveredEvents.length,
  liveStatuses: ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => fs.existsSync(taskPaths.getTaskFile(status, running.kind, running.id))),
  canonicalStatusAfter: taskStore.getResourceTaskById(running.id) && taskStore.getResourceTaskById(running.id).status || '',
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.22 stale running audit no-op failure compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.22 stale running no-op is not counted as recovered and does not emit worker_stale_recovered',
    summary.recovered === 0
      && summary.cleanupEventDelta === 0
      && summary.staleRecoveredEventCount === 0
      && JSON.stringify(summary.liveStatuses) === JSON.stringify(['running', 'done'])
      && summary.canonicalStatusAfter === 'done',
    JSON.stringify(summary))
}

// === Scenario 29: 阶段 D.23 recorded cleanup 不应把 no-op terminate 误记成 completed ===
function testRecordedCleanupDoesNotCountNoOpTerminateAsCompleted() {
  const dataDir = createTempDataDir('resource-regress-recorded-cleanup-noop-')
  const script = String.raw`
const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

const taskId = 'recorded-cleanup-noop-1'
systemProtection.writeProcessCleanupEvent({
  event: 'chromium_launched',
  taskId,
  kind: 'daily_report',
  source: 'resource-regression-recorded-cleanup',
  browserPid: 65530,
})

const result = systemProtection.terminateRecordedProcessPids({
  taskId,
  kind: 'daily_report',
  owner: 'resource-regression',
  source: 'resource_regression_test',
  reason: 'recorded_cleanup_noop_regression',
})
const cleanupAfter = systemProtection.getSystemProtectionStatus().cleanupEvents || []

console.log(JSON.stringify({
  resultEvent: result.event,
  resultEvents: Array.isArray(result.resultEvents) ? result.resultEvents : [],
  completedEventCount: cleanupAfter.filter(item => item.event === 'recorded_process_cleanup_completed' && item.taskId === taskId).length,
  skippedEventCount: cleanupAfter.filter(item => item.event === 'recorded_process_cleanup_skipped' && item.taskId === taskId).length,
  successfulTerminateCount: cleanupAfter.filter(item => item.event === 'process_tree_terminated' && item.taskId === taskId).length,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.23 recorded cleanup no-op terminate compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.23 recorded cleanup no-op does not emit completed summary event',
    summary.resultEvent === 'recorded_process_cleanup_skipped'
      && summary.completedEventCount === 0
      && summary.skippedEventCount >= 1
      && summary.successfulTerminateCount === 0
      && Array.isArray(summary.resultEvents)
      && !summary.resultEvents.includes('process_tree_terminated'),
    JSON.stringify(summary))
}

// === Scenario 30: 阶段 D.24 notifier summary 不应把 notify no-op 写回误记成 sent/skipped/failed ===
function testNotifierDoesNotCountNoOpNotifyWriteback() {
  const dataDir = createTempDataDir('resource-regress-notify-writeback-noop-')
  const script = String.raw`
const fs = require('fs')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

taskStore.ensureTaskDirs()

function createDoneTask(input, result) {
  const pending = taskStore.submitResourceTask(input)
  const done = taskStore.completeTask(pending, result)
  if (!done || done.status !== 'done') throw new Error('expected done task for notifier no-op regression')
  return done
}

const skippedTask = createDoneTask({
  id: 'notify-noop-skipped-1',
  kind: 'daily_summary',
  source: 'resource-regression-notify-noop',
  channelKey: 'group-notify-noop',
  userId: 'tester',
  priority: 40,
  timeoutMs: 120000,
  payload: { slotId: 'notify-noop-skipped-1' },
  notify: { target: 'none', channelKey: 'group-notify-noop', status: 'pending' },
}, { text: 'skip me' })

const sentTask = createDoneTask({
  id: 'notify-noop-sent-1',
  kind: 'agent_task',
  source: 'resource-regression-notify-noop',
  channelKey: 'group-notify-noop',
  userId: 'tester',
  priority: 41,
  timeoutMs: 120000,
  payload: { entry: 'notify-noop-sent' },
  notify: { target: 'group-notify-noop', channelKey: 'group-notify-noop', status: 'pending' },
}, { reply: 'send me' })

const failedTask = createDoneTask({
  id: 'notify-noop-failed-1',
  kind: 'agent_task',
  source: 'resource-regression-notify-noop',
  channelKey: 'group-notify-noop',
  userId: 'tester',
  priority: 42,
  timeoutMs: 120000,
  payload: { entry: 'notify-noop-failed' },
  notify: { target: 'group-notify-noop', channelKey: 'group-notify-noop', status: 'pending' },
}, { reply: 'fail me' })

const failedThrowTask = createDoneTask({
  id: 'notify-noop-failed-throw-1',
  kind: 'agent_task',
  source: 'resource-regression-notify-noop',
  channelKey: 'group-notify-noop',
  userId: 'tester',
  priority: 43,
  timeoutMs: 120000,
  payload: { entry: 'notify-noop-failed-throw' },
  notify: { target: 'group-notify-noop', channelKey: 'group-notify-noop', status: 'pending' },
}, { reply: 'throw me' })

const doneFiles = new Map([
  [skippedTask.id, true],
  [sentTask.id, true],
  [failedTask.id, true],
  [failedThrowTask.id, true],
])

const originalUpdateTaskNotifyStatus = taskStore.updateTaskNotifyStatus
taskStore.updateTaskNotifyStatus = function noOpUpdateTaskNotifyStatus(task) {
  return task
}
delete require.cache[require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')]
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  try {
    const summary = await notifier.notifyCompletedTasks({
      limit: 100,
      sender: async (task) => {
        const id = String(task && task.id || '')
        if (id === sentTask.id) return true
        if (id === failedTask.id) return false
        if (id === failedThrowTask.id) throw new Error('sender exploded')
        return false
      },
    })
    const events = readEvents()
    console.log(JSON.stringify({
      scanned: summary.scanned,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
      notifyUpdatedCount: events.filter(event =>
        event.event === 'task_notify_updated'
        && doneFiles.has(event.taskId)
      ).length,
      survivingStatuses: Array.from(doneFiles.keys()).map(taskId => ({
        status: taskStore.getResourceTaskById(taskId) && taskStore.getResourceTaskById(taskId).status || '',
        notifyStatus: taskStore.getResourceTaskById(taskId) && taskStore.getResourceTaskById(taskId).notify && taskStore.getResourceTaskById(taskId).notify.status || '',
      })),
    }, null, 2))
    process.exitCode = 0
  } finally {
    taskStore.updateTaskNotifyStatus = originalUpdateTaskNotifyStatus
  }
}

run().catch(error => {
  taskStore.updateTaskNotifyStatus = originalUpdateTaskNotifyStatus
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.24 notifier notify writeback no-op compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.24 notifier no-op writeback is not counted as sent/skipped/failed',
    summary.scanned >= 4
      && summary.sent === 0
      && summary.skipped === 0
      && summary.failed === 0
      && summary.notifyUpdatedCount === 0
      && Array.isArray(summary.survivingStatuses)
      && summary.survivingStatuses.every(item => item.status === 'done' && item.notifyStatus === 'pending'),
    JSON.stringify(summary))
}

// === Scenario 31: 阶段 D.25 failed notify 在再次失败后应重新进入新的 cooldown ===
function testNotifierFailedCooldownRefreshesAfterRepeatedFailure() {
  const dataDir = createTempDataDir('resource-regress-notify-failed-cooldown-refresh-')
  const script = String.raw`
const Module = require('module')
let fakeNowMs = Date.parse('2026-06-11T00:20:00.000Z')
const originalDateNow = Date.now
Date.now = () => fakeNowMs

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      nowIso: () => new Date(fakeNowMs).toISOString(),
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  taskStore.ensureTaskDirs()
  const taskId = 'agent-task-notify-failed-cooldown-refresh-1'
  const pendingTask = taskStore.submitResourceTask({
    id: taskId,
    kind: 'agent_task',
    source: 'resource-regression-notify-failed-cooldown-refresh',
    channelKey: 'group-notify-failed-cooldown-refresh',
    priority: 60,
    timeoutMs: 120000,
    payload: { entry: 'regression-notify-failed-cooldown-refresh' },
    notify: { target: 'group-notify-failed-cooldown-refresh', channelKey: 'group-notify-failed-cooldown-refresh', status: 'pending' },
  })
  const doneTask = taskStore.completeTask(pendingTask, {
    reply: 'background result ready',
  })
  if (!doneTask) throw new Error('expected task to complete')

  let senderCalls = 0
  const sender = async () => {
    senderCalls += 1
    return false
  }

  const first = await notifier.notifyCompletedTasks({ limit: 100, sender })
  const taskAfterFirst = taskStore.getResourceTaskById(taskId)
  const firstUpdatedAtMs = Date.parse(String(taskAfterFirst && taskAfterFirst.notify && taskAfterFirst.notify.updatedAt || ''))

  let second
  let third
  try {
    fakeNowMs = firstUpdatedAtMs + 61 * 1000
    second = await notifier.notifyCompletedTasks({ limit: 100, sender })
    const taskAfterSecond = taskStore.getResourceTaskById(taskId)
    const secondUpdatedAtMs = Date.parse(String(taskAfterSecond && taskAfterSecond.notify && taskAfterSecond.notify.updatedAt || ''))

    fakeNowMs = secondUpdatedAtMs + 1000
    third = await notifier.notifyCompletedTasks({ limit: 100, sender })

    console.log(JSON.stringify({
      firstFailed: first.failed,
      secondFailed: second.failed,
      thirdFailed: third.failed,
      senderCalls,
      firstUpdatedAtMs,
      secondUpdatedAtMs,
      secondUpdatedAtAdvanced: Number.isFinite(secondUpdatedAtMs) && secondUpdatedAtMs > firstUpdatedAtMs,
      notifyStatusAfterThird: taskStore.getResourceTaskById(taskId) && taskStore.getResourceTaskById(taskId).notify && taskStore.getResourceTaskById(taskId).notify.status || '',
    }, null, 2))
  } finally {
    Module._load = originalLoad
    Date.now = originalDateNow
  }
  process.exitCode = 0
}

run().catch(error => {
  Module._load = originalLoad
  Date.now = originalDateNow
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.25 notifier failed cooldown refresh compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.25 repeated failed notify refreshes failed updatedAt and re-enters cooldown',
    summary.firstFailed === 1
      && summary.secondFailed === 1
      && summary.thirdFailed === 0
      && summary.senderCalls === 2
      && summary.secondUpdatedAtAdvanced === true
      && summary.notifyStatusAfterThird === 'failed',
    JSON.stringify(summary))
}

// === Scenario 32: 阶段 D.26 planner 已停止时不应每个 tick 重复写 stop 事件 ===
function testPlannerStopEventsAreDedupedAcrossTicks() {
  const dataDir = createTempDataDir('resource-regress-planner-stop-dedupe-')
  const script = String.raw`
const fs = require('fs')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')

function readEvents() {
  const file = precomputeIndex.precomputeEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

const date = '2026-06-11'
const channelKey = 'group-planner-stop-dedupe'
for (let i = 0; i < 180; i++) {
  precomputeIndex.appendPrecomputeIndex({
    date,
    channelKey,
    messageId: 'planner-stop-msg-' + i,
    timestamp: 1749600000000 + i * 1000,
    userId: 'u' + (i % 4),
    text: 'planner stop regress ' + i,
  })
}

function countStopEvents() {
  return readEvents().filter(event =>
    event.event === 'daily_slot_planning_skipped'
    && event.date === date
    && event.channelKey === channelKey
  ).length
}

process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '50'
process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
const first = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
const second = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
const third = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
const skippedAfterBlackTicks = countStopEvents()

process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
const green = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })

process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '50'
const redAfterGreen = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
const skippedAfterRecovery = countStopEvents()

console.log(JSON.stringify({
  firstCount: Array.isArray(first) ? first.length : -1,
  secondCount: Array.isArray(second) ? second.length : -1,
  thirdCount: Array.isArray(third) ? third.length : -1,
  skippedAfterBlackTicks,
  greenCount: Array.isArray(green) ? green.length : -1,
  redAfterGreenCount: Array.isArray(redAfterGreen) ? redAfterGreen.length : -1,
  skippedAfterRecovery,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.26 planner stop event dedupe compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('D.26 repeated red ticks do not keep appending identical stop events',
    summary.firstCount === 0
      && summary.secondCount === 0
      && summary.thirdCount === 0
      && summary.skippedAfterBlackTicks === 1,
    JSON.stringify(summary))
  check('D.26 planner recovery re-arms a future stop event after green planning resumes',
    summary.greenCount > 0
      && summary.redAfterGreenCount === 0
      && summary.skippedAfterRecovery === 2,
    JSON.stringify(summary))
}

// === Scenario 33: 阶段 D.27 startup daily precompute 在 global backlog 已满时应整轮短路 ===
function testDailyPrecomputeSchedulerStopsBeforePerChannelScanWhenBacklogIsFull() {
  const dataDir = createTempDataDir('resource-regress-precompute-backlog-shortcircuit-')
  const script = String.raw`
const fs = require('fs')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

const originalPlanDailySlotTasks = planner.planDailySlotTasks
let plannerCalls = 0
planner.planDailySlotTasks = function patchedPlanDailySlotTasks() {
  plannerCalls += 1
  return originalPlanDailySlotTasks.apply(this, arguments)
}

const startupSchedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')

function createCtx() {
  const logs = []
  return {
    logs,
    ctx: {
      bots: [{ selfId: '10000' }],
      logger() {
        return {
          info(message) { logs.push({ level: 'info', message: String(message) }) },
          warn(message) { logs.push({ level: 'warn', message: String(message) }) },
        }
      },
    },
  }
}

function readEvents() {
  const file = precomputeIndex.precomputeEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

const today = '2026-06-11'
for (let channelIndex = 0; channelIndex < 6; channelIndex++) {
  const channelKey = 'group-precompute-backlog-' + channelIndex
  for (let i = 0; i < 60; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date: today,
      channelKey,
      messageId: channelKey + '-msg-' + i,
      timestamp: 1749600000000 + channelIndex * 100000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'scheduler backlog regress ' + channelKey + ' #' + i,
    })
  }
}

taskStore.ensureTaskDirs()
for (let i = 0; i < 8; i++) {
  taskStore.submitResourceTask({
    id: 'daily-summary-backlog-' + i,
    kind: 'daily_summary',
    source: 'resource-regression-d27',
    channelKey: 'group-precompute-backlog-seed',
    priority: 70,
    timeoutMs: 120000,
    payload: { slotId: 'seed-' + i },
    notify: { target: 'none', status: 'pending' },
  })
}

async function run() {
  const loggerStore = createCtx()
  try {
    const planning = await startupSchedulers.runDailyPrecomputePlanningTick(loggerStore.ctx)
    const events = readEvents()
    console.log(JSON.stringify({
      planning,
      plannerCalls,
      backlogStopEvents: events.filter(event => event.event === 'daily_slot_planning_backlog_stopped').length,
      taskCreatedEvents: events.filter(event => event.event === 'daily_slot_tasks_planned').length,
    }, null, 2))
    process.exitCode = 0
  } finally {
    planner.planDailySlotTasks = originalPlanDailySlotTasks
  }
}

run().catch(error => {
  planner.planDailySlotTasks = originalPlanDailySlotTasks
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.27 scheduler backlog short-circuit compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.27 startup daily precompute stops before per-channel planner scan when global backlog is full',
    summary.planning
      && summary.planning.parked === false
      && summary.planning.planned === 0
      && summary.plannerCalls === 0,
    JSON.stringify(summary))
  check('D.27 global backlog short-circuit avoids per-channel backlog stop event fan-out',
    summary.backlogStopEvents === 0
      && summary.taskCreatedEvents === 0,
    JSON.stringify(summary))
}

// === Scenario 34: 阶段 D.43 planner 在 backlog 已满时不应继续读取后续频道 index/slot ===
function testPlannerBacklogStopHappensBeforeReadingLaterChannelData() {
  const dataDir = createTempDataDir('resource-regress-planner-backlog-read-guard-')
  const script = String.raw`
const Module = require('module')
const originalLoad = Module._load
const readCounts = {
  firstIndex: 0,
  secondIndex: 0,
  firstSlots: 0,
  secondSlots: 0,
}

Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)

  if (normalized.endsWith('/daily-precompute/precompute-index') || normalized.endsWith('./precompute-index')) {
    return {
      ...loaded,
      readPrecomputeIndex(date, channelKey) {
        if (channelKey === 'group-d43-first') readCounts.firstIndex += 1
        if (channelKey === 'group-d43-second') readCounts.secondIndex += 1
        return loaded.readPrecomputeIndex(date, channelKey)
      },
    }
  }

  if (normalized.endsWith('/daily-precompute/daily-summary-merge') || normalized.endsWith('./daily-summary-merge')) {
    return {
      ...loaded,
      readDailySlots(date, channelKey) {
        if (channelKey === 'group-d43-first') readCounts.firstSlots += 1
        if (channelKey === 'group-d43-second') readCounts.secondSlots += 1
        return loaded.readDailySlots(date, channelKey)
      },
    }
  }

  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')

function appendRecords(channelKey) {
  for (let i = 0; i < 160; i += 1) {
    precomputeIndex.appendPrecomputeIndex({
      date: '2026-06-12',
      channelKey,
      messageId: channelKey + '-msg-' + i,
      timestamp: 1749686400000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'planner backlog read guard ' + channelKey + ' #' + i,
    })
  }
}

function run() {
  taskStore.ensureTaskDirs()
  appendRecords('group-d43-first')
  appendRecords('group-d43-second')

  const first = planner.planDailySlotTasks('2026-06-12', 'group-d43-first', {
    source: 'resource-regression-d43',
    slotSize: 20,
    maxSlots: 8,
  })
  const backlogAfterFirst = taskStore.countResourceTasks({
    kind: 'daily_summary',
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 20000,
  })
  const second = planner.planDailySlotTasks('2026-06-12', 'group-d43-second', {
    source: 'resource-regression-d43',
    slotSize: 20,
    maxSlots: 8,
  })

  console.log(JSON.stringify({
    firstCount: Array.isArray(first) ? first.length : -1,
    secondCount: Array.isArray(second) ? second.length : -1,
    backlogAfterFirst,
    readCounts,
  }, null, 2))
  process.exitCode = 0
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
} finally {
  Module._load = originalLoad
}
`
  const summary = runScenario('D.43 planner backlog read guard compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.43 first planner call should create enough backlog to hit planner stop threshold',
    summary.firstCount >= 8
      && summary.backlogAfterFirst >= 8
      && summary.secondCount === 0,
    JSON.stringify(summary))
  check('D.43 second planner call should stop before reading later channel index or slots',
    summary.readCounts
      && summary.readCounts.firstIndex >= 1
      && summary.readCounts.firstSlots >= 1
      && summary.readCounts.secondIndex === 0
      && summary.readCounts.secondSlots === 0,
    JSON.stringify(summary))
}

// === Scenario 34: 阶段 D.28 worker-main 在 background park 时不应先 claim 再 defer/requeue ===
function testWorkerMainParksBeforeClaimWhenBackgroundDirectiveBlocks() {
  const dataDir = createTempDataDir('resource-regress-worker-main-park-before-claim-')
  const script = String.raw`
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function listStatuses(taskId, kind) {
  return ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => {
      const task = taskStore.listResourceTasks({ statuses: [status], kinds: [kind], limit: 20 })
        .find(item => String(item.id || '') === taskId)
      return !!task
    })
}

async function run() {
  taskStore.ensureTaskDirs()

  const dailyTask = taskStore.submitResourceTask({
    id: 'worker-main-park-daily-1',
    kind: 'daily_report',
    source: 'resource-regression-d28',
    channelKey: 'group-worker-main-park',
    userId: 'tester',
    priority: 20,
    timeoutMs: 120000,
    payload: { renderImage: true },
    notify: { target: 'none', status: 'pending' },
  })

  const agentTask = taskStore.submitResourceTask({
    id: 'worker-main-park-agent-1',
    kind: 'agent_task',
    source: 'resource-regression-d28',
    channelKey: 'group-worker-main-park',
    userId: 'tester',
    priority: 40,
    timeoutMs: 120000,
    payload: { entry: 'worker-main-park-agent' },
    notify: { target: 'none', status: 'pending' },
  })

  const dailyWorked = await workerMain.runWorkerTick({
    type: 'daily',
    workerName: 'worker-main-park-daily',
    gateWaitMs: 1000,
  })
  const agentWorked = await workerMain.runWorkerTick({
    type: 'agent',
    workerName: 'worker-main-park-agent',
    gateWaitMs: 1000,
  })

  console.log(JSON.stringify({
    dailyWorked,
    agentWorked,
    dailyStatuses: listStatuses(dailyTask.id, dailyTask.kind),
    agentStatuses: listStatuses(agentTask.id, agentTask.kind),
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.28 worker-main park-before-claim compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.28 daily worker parks before claim and leaves task pending under red memory',
    summary.dailyWorked === false
      && JSON.stringify(summary.dailyStatuses) === JSON.stringify(['pending']),
    JSON.stringify(summary))
  check('D.28 agent worker parks before claim and leaves task pending under red memory',
    summary.agentWorked === false
      && JSON.stringify(summary.agentStatuses) === JSON.stringify(['pending']),
    JSON.stringify(summary))
}

// === Scenario 35: 阶段 D.29 S6 deferred 冷却期不应重复全盘扫盘 ===
function testMediaQueueDoesNotRescanDeferredBacklogDuringCooldown() {
  const dataDir = createTempDataDir('resource-regress-media-deferred-rescan-')
  const script = String.raw`
const Module = require('module')

let recursiveQueueScans = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      listJsonFiles(root, options) {
        if (options && options.recursive) recursiveQueueScans += 1
        return loaded.listJsonFiles(root, options)
      },
    }
  }
  return loaded
}

const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
Module._load = originalLoad

const originalDateNow = Date.now

function run() {
  mediaQueue.ensureMediaDirs()
  const created = mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'group-media-deferred-rescan',
    messageId: 'media-deferred-rescan-1',
    url: 'http://example.invalid/media-deferred-rescan-1.png',
  })
  const claimed = mediaQueue.claimNextMediaTask('media-worker')
  const requeued = mediaQueue.requeueMediaTask(claimed, 'resource_defer', 60000)

  recursiveQueueScans = 0
  const firstCooldownClaim = mediaQueue.claimNextMediaTask('media-worker')
  const scansAfterFirst = recursiveQueueScans
  const secondCooldownClaim = mediaQueue.claimNextMediaTask('media-worker')
  const scansAfterSecond = recursiveQueueScans

  const deferredUntilMs = Date.parse(String((requeued && (requeued.deferredUntil || requeued.notBefore)) || ''))
  let afterCooldownClaim = null
  if (Number.isFinite(deferredUntilMs) && deferredUntilMs > 0) {
    Date.now = () => deferredUntilMs + 1000
    afterCooldownClaim = mediaQueue.claimNextMediaTask('media-worker')
  }

  console.log(JSON.stringify({
    createdId: created && created.id || '',
    firstCooldownClaimId: firstCooldownClaim && firstCooldownClaim.id || '',
    secondCooldownClaimId: secondCooldownClaim && secondCooldownClaim.id || '',
    scansAfterFirst,
    scansAfterSecond,
    scansSecondDelta: scansAfterSecond - scansAfterFirst,
    afterCooldownClaimId: afterCooldownClaim && afterCooldownClaim.id || '',
    scansAfterCooldown: recursiveQueueScans,
  }, null, 2))
  process.exitCode = 0
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
} finally {
  Date.now = originalDateNow
  Module._load = originalLoad
}
`
  const summary = runScenario('D.29 media queue deferred rescan compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.29 deferred media task is still not claimable during cooldown',
    !summary.firstCooldownClaimId && !summary.secondCooldownClaimId,
    JSON.stringify(summary))
  check('D.29 second cooldown claim does not recursively rescan the whole queue again',
    summary.scansAfterFirst >= 1
      && summary.scansSecondDelta === 0,
    JSON.stringify(summary))
  check('D.29 deferred media task becomes claimable again after cooldown passes',
    summary.afterCooldownClaimId === summary.createdId
      && summary.scansAfterCooldown > summary.scansAfterSecond,
    JSON.stringify(summary))
}

// === Scenario 36: 阶段 D.8 deferred 恢复不应一轮整批灌回 pending ===
function testDeferredAuditRestoresGraduallyWhenBacklogHasRecovered() {
  const dataDir = createTempDataDir('resource-regress-deferred-restore-budget-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function countStatus(status) {
  return taskStore.listResourceTasks({ statuses: [status], limit: 200 })
    .filter(task => task && task.kind === 'daily_summary')
    .length
}

function seedTask(id) {
  return taskStore.submitResourceTask({
    id,
    kind: 'daily_summary',
    source: 'resource-regression-deferred-restore',
    channelKey: 'group-deferred-restore',
    userId: 'tester',
    priority: 70,
    timeoutMs: 120000,
    payload: { slotId: id },
    notify: { target: 'none', status: 'pending' },
  })
}

taskStore.ensureTaskDirs()
seedTask('task-deferred-restore-pending-seed-1')
for (let index = 0; index < 4; index += 1) {
  const seed = seedTask('task-deferred-restore-deferred-' + index)
  taskStore.deferTask(seed, 'seed deferred restore budget regression')
}

const admissionPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const supervisorPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
const originalAdmissionModule = require(admissionPath)

require.cache[admissionPath] = {
  id: admissionPath,
  filename: admissionPath,
  loaded: true,
  exports: {
    ...originalAdmissionModule,
    admitTask() {
      return { decision: 'run_now', reason: 'resource recovered for deferred audit regression' }
    },
  },
}
delete require.cache[supervisorPath]
const supervisor = require(supervisorPath)

const beforeEvents = readEvents()
const beforeAuditEvents = beforeEvents.filter(event => event.event === 'deferred_tasks_audited').length
const beforeRequeueEvents = beforeEvents.filter(event => event.event === 'task_requeued').length

const first = supervisor.auditDeferredTasks(50)
const afterFirstEvents = readEvents()
const afterFirstAuditEvents = afterFirstEvents.filter(event => event.event === 'deferred_tasks_audited').length
const afterFirstRequeueEvents = afterFirstEvents.filter(event => event.event === 'task_requeued').length

const second = supervisor.auditDeferredTasks(50)
const afterSecondEvents = readEvents()
const afterSecondAuditEvents = afterSecondEvents.filter(event => event.event === 'deferred_tasks_audited').length
const afterSecondRequeueEvents = afterSecondEvents.filter(event => event.event === 'task_requeued').length

console.log(JSON.stringify({
  firstRestored: first.restored,
  firstFailed: first.failed,
  secondRestored: second.restored,
  secondFailed: second.failed,
  pendingAfterFirst: countStatus('pending'),
  deferredAfterFirst: countStatus('deferred'),
  pendingAfterSecond: countStatus('pending'),
  deferredAfterSecond: countStatus('deferred'),
  requeueEventDeltaFirst: afterFirstRequeueEvents - beforeRequeueEvents,
  requeueEventDeltaSecond: afterSecondRequeueEvents - afterFirstRequeueEvents,
  auditEventDeltaFirst: afterFirstAuditEvents - beforeAuditEvents,
  auditEventDeltaSecond: afterSecondAuditEvents - afterFirstAuditEvents,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.8 deferred restore budget compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_DEFERRED_RESTORE_MAX_ACTIVE: '2',
  }, 30000)
  if (!summary) return
  check('D.8 deferred audit only restores up to the active backlog budget on first tick',
    summary.firstRestored === 1
      && summary.firstFailed === 0
      && summary.pendingAfterFirst === 2
      && summary.deferredAfterFirst === 3
      && summary.requeueEventDeltaFirst === 1
      && summary.auditEventDeltaFirst === 1,
    JSON.stringify(summary))
  check('D.8 deferred audit does not keep restoring once active backlog is already full',
    summary.secondRestored === 0
      && summary.secondFailed === 0
      && summary.pendingAfterSecond === 2
      && summary.deferredAfterSecond === 3
      && summary.requeueEventDeltaSecond === 0
      && summary.auditEventDeltaSecond === 0,
    JSON.stringify(summary))
}

// === Scenario 37: 阶段 D.9 非 media worker 被资源挡回时不应继续走 200ms worked 快路径 ===
function testWorkerMainDoesNotReportWorkedWhenTaskOnlyDeferredOrRequeued() {
  const dataDir = createTempDataDir('resource-regress-worker-main-nonproductive-backoff-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function createTask(id, kind) {
  return taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-worker-main-backoff',
    channelKey: 'group-worker-main-backoff',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: { slotId: id, renderImage: true, entry: id },
    notify: { target: 'none', status: 'pending' },
  })
}

taskStore.ensureTaskDirs()

const admissionPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const gatePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const workerMainPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')

const originalAdmissionModule = require(admissionPath)
const originalGateModule = require(gatePath)

async function run() {
  const baselineEvents = readEvents().length

  createTask('worker-main-backoff-defer-1', 'daily_report')
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: {
      ...originalAdmissionModule,
      admitTask() {
        return { decision: 'defer', reason: 'resource regression forced defer' }
      },
    },
  }
  delete require.cache[workerMainPath]
  let workerMain = require(workerMainPath)
  const deferWorked = await workerMain.runOneQueuedTask({ type: 'daily', workerName: 'worker-main-backoff-defer' })
  const deferTask = taskStore.getResourceTaskById('worker-main-backoff-defer-1')
  const afterDeferEvents = readEvents()

  createTask('worker-main-backoff-queue-1', 'daily_report')
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: {
      ...originalAdmissionModule,
      admitTask() {
        return { decision: 'queue', reason: 'resource regression forced queue' }
      },
    },
  }
  delete require.cache[workerMainPath]
  workerMain = require(workerMainPath)
  const queueWorked = await workerMain.runOneQueuedTask({ type: 'daily', workerName: 'worker-main-backoff-queue' })
  const queueTask = taskStore.getResourceTaskById('worker-main-backoff-queue-1')
  const afterQueueEvents = readEvents()

  createTask('worker-main-backoff-gatefail-1', 'agent_task')
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: {
      ...originalAdmissionModule,
      admitTask() {
        return { decision: 'run_now', reason: 'resource regression forced run' }
      },
    },
  }
  require.cache[gatePath] = {
    id: gatePath,
    filename: gatePath,
    loaded: true,
    exports: {
      ...originalGateModule,
      acquireResourceGate: async () => {
        throw new Error('resource regression forced gate wait failure')
      },
    },
  }
  delete require.cache[workerMainPath]
  workerMain = require(workerMainPath)
  const gateWorked = await workerMain.runOneQueuedTask({ type: 'agent', workerName: 'worker-main-backoff-gate', gateWaitMs: 1000 })
  const gateTask = taskStore.getResourceTaskById('worker-main-backoff-gatefail-1')
  const afterGateEvents = readEvents()

  console.log(JSON.stringify({
    baselineEvents,
    deferWorked,
    deferStatus: deferTask && deferTask.status || '',
    deferClaimedEvents: afterDeferEvents.filter(event => event.event === 'task_claimed' && event.taskId === 'worker-main-backoff-defer-1').length,
    deferDeferredEvents: afterDeferEvents.filter(event => event.event === 'task_deferred' && event.taskId === 'worker-main-backoff-defer-1').length,
    queueWorked,
    queueStatus: queueTask && queueTask.status || '',
    queueClaimedEvents: afterQueueEvents.filter(event => event.event === 'task_claimed' && event.taskId === 'worker-main-backoff-queue-1').length,
    queueRequeuedEvents: afterQueueEvents.filter(event => event.event === 'task_requeued' && event.taskId === 'worker-main-backoff-queue-1').length,
    gateWorked,
    gateStatus: gateTask && gateTask.status || '',
    gateClaimedEvents: afterGateEvents.filter(event => event.event === 'task_claimed' && event.taskId === 'worker-main-backoff-gatefail-1').length,
    gateRunningEvents: afterGateEvents.filter(event => event.event === 'task_running' && event.taskId === 'worker-main-backoff-gatefail-1').length,
    gateRequeuedEvents: afterGateEvents.filter(event => event.event === 'task_requeued' && event.taskId === 'worker-main-backoff-gatefail-1').length,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: originalAdmissionModule,
  }
  require.cache[gatePath] = {
    id: gatePath,
    filename: gatePath,
    loaded: true,
    exports: originalGateModule,
  }
  delete require.cache[workerMainPath]
})
`
  const summary = runScenario('D.9 worker-main nonproductive backoff compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.9 admission defer path should not report worked=true after only deferring task',
    summary.deferWorked === false
      && summary.deferStatus === 'deferred'
      && summary.deferClaimedEvents === 1
      && summary.deferDeferredEvents === 1,
    JSON.stringify(summary))
  check('D.9 admission queue path should not report worked=true after only requeueing task',
    summary.queueWorked === false
      && summary.queueStatus === 'pending'
      && summary.queueClaimedEvents === 1
      && summary.queueRequeuedEvents === 1,
    JSON.stringify(summary))
  check('D.9 gate wait failure path should not report worked=true after only requeueing task',
    summary.gateWorked === false
      && summary.gateStatus === 'pending'
      && summary.gateClaimedEvents === 1
      && summary.gateRunningEvents === 1
      && summary.gateRequeuedEvents === 1,
    JSON.stringify(summary))
}

// === Scenario 38: 阶段 D.10 媒体入队前门不应为 done 历史背锅 ===
function testMediaQueueEnqueueDoesNotDedupAgainstDoneHistoryWithoutCacheIndex() {
  const dataDir = createTempDataDir('resource-regress-media-done-frontdoor-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

let doneScanCount = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      listJsonFiles(root, options) {
        const rootText = String(root || '').replace(/\\\\/g, '/').toLowerCase()
        if (rootText.includes('media-backpressure/done')) doneScanCount += 1
        return loaded.listJsonFiles(root, options)
      },
    }
  }
  return loaded
}

const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
Module._load = originalLoad

function countPendingImageTasks() {
  const imageDir = path.join(mediaQueue.MEDIA_QUEUE_ROOT, 'image')
  if (!fs.existsSync(imageDir)) return 0
  return fs.readdirSync(imageDir).filter(name => name.endsWith('.json')).length
}

function run() {
  mediaQueue.ensureMediaDirs()
  const input = {
    kind: 'media_image_analysis',
    channelKey: 'group-media-done-frontdoor',
    messageId: 'media-done-frontdoor-1',
    url: 'https://example.test/media-done-frontdoor-1.png',
  }

  const first = mediaQueue.enqueueMediaTask(input)
  const claimed = mediaQueue.claimNextMediaTask('media-worker')
  mediaQueue.completeMediaTask(claimed, { ok: true, analysis: 'cached once' })
  mediaQueue.writeCacheIndex({})

  doneScanCount = 0
  const second = mediaQueue.enqueueMediaTask(input)

  console.log(JSON.stringify({
    secondStatus: second && second.status || '',
    secondHasExisting: !!(second && second.existing),
    secondReusedTrue: !!(second && second.reused === true),
    pendingImageTasks: countPendingImageTasks(),
    doneScanCount,
  }, null, 2))
  process.exitCode = 0
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
} finally {
  Module._load = originalLoad
}
`
  const summary = runScenario('D.10 media queue done history frontdoor compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.10 enqueue should not rescan done history when cache-index has no reusable result',
    summary.doneScanCount === 0,
    JSON.stringify(summary))
  check('D.10 enqueue should create a fresh pending task instead of deduping against done history',
    summary.pendingImageTasks === 1
      && summary.secondStatus === 'pending'
      && summary.secondHasExisting === false
      && summary.secondReusedTrue === false,
    JSON.stringify(summary))
}

// === Scenario 39: 阶段 D.11 S6 cache-index 不应无上限累积 ===
function testMediaQueueCacheIndexIsTrimmedOnWrite() {
  const dataDir = createTempDataDir('resource-regress-media-cache-index-trim-')
  const script = String.raw`
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')

function completeOne(index) {
  const input = {
    kind: 'media_image_analysis',
    channelKey: 'group-media-cache-index-trim',
    messageId: 'media-cache-index-trim-' + index,
    url: 'https://example.test/media-cache-index-trim-' + index + '.png',
  }
  const created = mediaQueue.enqueueMediaTask(input)
  const claimed = mediaQueue.claimNextMediaTask('media-worker')
  mediaQueue.completeMediaTask(claimed, { ok: true, analysis: 'analysis-' + index })
  return { input, created }
}

function run() {
  mediaQueue.ensureMediaDirs()
  const completed = []
  for (let i = 1; i <= 5; i += 1) {
    completed.push(completeOne(i))
  }

  const index = mediaQueue.readCacheIndex()
  const keys = Object.keys(index)
  const reusedLatest = mediaQueue.enqueueMediaTask(completed[4].input)
  const reusedOldest = mediaQueue.enqueueMediaTask(completed[0].input)

  console.log(JSON.stringify({
    cacheKeyCount: keys.length,
    reusedLatest: !!(reusedLatest && reusedLatest.reused === true),
    reusedOldest: !!(reusedOldest && reusedOldest.reused === true),
  }, null, 2))
  process.exitCode = 0
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
}
`
  const summary = runScenario('D.11 media cache-index trim compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    MEDIA_BACKPRESSURE_CACHE_INDEX_MAX_ENTRIES: '3',
  }, 30000)
  if (!summary) return
  check('D.11 cache-index should keep only the recent bounded number of entries',
    summary.cacheKeyCount === 3,
    JSON.stringify(summary))
  check('D.11 newest completed media should still be reusable from cache-index',
    summary.reusedLatest === true,
    JSON.stringify(summary))
  check('D.11 oldest evicted cache entry should no longer be reused from cache-index',
    summary.reusedOldest === false,
    JSON.stringify(summary))
}

// === Scenario 41: 阶段 D.31 预计算索引追加不应在 slot 未变化时每条消息全量重算 coverage ===
function testPrecomputeCoverageAppendDoesNotRecomputeWhenSlotsUnchanged() {
  const dataDir = createTempDataDir('resource-regress-precompute-append-coverage-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const files = require('koishi-plugin-dongxuelian-ai/lib/resource-common/files')
const precompute = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')

const originalReadFileSync = fs.readFileSync
const originalListJsonFiles = files.listJsonFiles
const date = '2026-06-11'
const channelKey = 'group-precompute-append-coverage'
const indexFile = precompute.getPrecomputeIndexFile(date, channelKey)
const coverageFile = precompute.getPrecomputeCoverageFile(date, channelKey)
const slotDir = path.join(precompute.PRECOMPUTE_ROOT, 'slots', files.sanitizeId(date), files.sanitizeId(channelKey))

let indexReadCount = 0
let slotScanCount = 0

function normalize(target) {
  return String(target || '').replace(/\\/g, '/').toLowerCase()
}

fs.readFileSync = function patchedReadFileSync(target) {
  if (normalize(target) === normalize(indexFile)) indexReadCount += 1
  return originalReadFileSync.apply(this, arguments)
}

files.listJsonFiles = function patchedListJsonFiles(target, options) {
  if (normalize(target) === normalize(slotDir)) slotScanCount += 1
  return originalListJsonFiles.apply(this, arguments)
}

function append(messageId, text) {
  precompute.appendPrecomputeIndex({
    date,
    channelKey,
    messageId,
    timestamp: Date.now(),
    userId: 'tester',
    userName: 'Tester',
    text,
  })
}

function readCoverage() {
  return JSON.parse(originalReadFileSync(coverageFile, 'utf8'))
}

try {
  append('precompute-append-1', '第一条预计算消息')
  const afterFirst = { indexReadCount, slotScanCount }
  const firstCoverage = readCoverage()

  append('precompute-append-2', '第二条预计算消息')
  const afterSecond = { indexReadCount, slotScanCount }
  const secondCoverage = readCoverage()

  fs.mkdirSync(slotDir, { recursive: true })
  fs.writeFileSync(path.join(slotDir, 'slot-manual.json'), JSON.stringify({
    slotId: 'slot-manual',
    coveredMessageIds: ['precompute-append-1', 'precompute-append-2'],
  }, null, 2), 'utf8')

  const beforeThird = { indexReadCount, slotScanCount }
  append('precompute-append-3', '第三条预计算消息')
  const afterThird = { indexReadCount, slotScanCount }
  const thirdCoverage = readCoverage()

  console.log(JSON.stringify({
    firstIndexReads: afterFirst.indexReadCount,
    firstSlotScans: afterFirst.slotScanCount,
    secondIndexReadDelta: afterSecond.indexReadCount - afterFirst.indexReadCount,
    secondSlotScanDelta: afterSecond.slotScanCount - afterFirst.slotScanCount,
    secondTotalMessages: Number(secondCoverage.totalMessages || 0),
    secondCoveredMessages: Number(secondCoverage.coveredMessages || 0),
    thirdIndexReadDelta: afterThird.indexReadCount - beforeThird.indexReadCount,
    thirdSlotScanDelta: afterThird.slotScanCount - beforeThird.slotScanCount,
    thirdTotalMessages: Number(thirdCoverage.totalMessages || 0),
    thirdCoveredMessages: Number(thirdCoverage.coveredMessages || 0),
    thirdCoverageRate: Number(thirdCoverage.coverageRate || 0),
  }, null, 2))
  process.exitCode = 0
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
} finally {
  fs.readFileSync = originalReadFileSync
  files.listJsonFiles = originalListJsonFiles
}
`
  const summary = runScenario('D.31 precompute append coverage recompute compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('D.31 second append should not reread whole precompute index when slots are unchanged',
    summary.firstIndexReads >= 1
      && summary.secondIndexReadDelta === 0,
    JSON.stringify(summary))
  check('D.31 second append should not rescan slot files when slots are unchanged',
    summary.firstSlotScans >= 1
      && summary.secondSlotScanDelta === 0,
    JSON.stringify(summary))
  check('D.31 incremental coverage still updates totalMessages while keeping coveredMessages stable',
    summary.secondTotalMessages === 2
      && summary.secondCoveredMessages === 0,
    JSON.stringify(summary))
  check('D.31 slot changes should force one full recompute on the next append',
    summary.thirdIndexReadDelta >= 1
      && summary.thirdSlotScanDelta >= 1
      && summary.thirdTotalMessages === 3
      && summary.thirdCoveredMessages === 2
      && summary.thirdCoverageRate === 0.667,
    JSON.stringify(summary))
}

// === Scenario 42: 阶段 D.32 task-store 正常状态迁移不应再触发全状态目录枚举 ===
function testTaskStoreCanonicalHotPathDoesNotScanTaskDirs() {
  const dataDir = createTempDataDir('resource-regress-task-store-hotpath-scan-')
  const script = String.raw`
const fs = require('fs')
const filesPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-common/files')
const taskStorePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const files = require(filesPath)

const originalListJsonFiles = files.listJsonFiles
let taskDirScanCount = 0

function normalize(target) {
  return String(target || '').replace(/\\/g, '/').toLowerCase()
}

files.listJsonFiles = function patchedListJsonFiles(target, options) {
  const targetText = normalize(target)
  if (targetText.includes('/resource-workers/tasks/')) taskDirScanCount += 1
  return originalListJsonFiles.apply(this, arguments)
}

delete require.cache[taskStorePath]
const taskStore = require(taskStorePath)

function submit(id, kind = 'daily_summary') {
  return taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-hotpath-scan',
    channelKey: 'group-hotpath-scan',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  })
}

function readStatus(status, kind, taskId) {
  const file = taskPaths.getTaskFile(status, kind, taskId)
  if (!fs.existsSync(file)) return ''
  return JSON.parse(fs.readFileSync(file, 'utf8')).status || ''
}

function resetScans() {
  taskDirScanCount = 0
}

try {
  taskStore.ensureTaskDirs()

  const markSeed = submit('task-hotpath-mark')
  const markClaiming = taskStore.claimTaskById(markSeed.id, 'hotpath-worker')
  resetScans()
  const markRunning = taskStore.markTaskRunning(markClaiming, 'hotpath-worker', 'running')
  const markScanCount = taskDirScanCount

  const completeSeed = submit('task-hotpath-complete')
  const completeClaiming = taskStore.claimTaskById(completeSeed.id, 'hotpath-worker')
  const completeRunning = taskStore.markTaskRunning(completeClaiming, 'hotpath-worker', 'running')
  resetScans()
  const completed = taskStore.completeTask(completeRunning, { ok: true })
  const completeScanCount = taskDirScanCount

  const deferSeed = submit('task-hotpath-defer')
  const deferClaiming = taskStore.claimTaskById(deferSeed.id, 'hotpath-worker')
  resetScans()
  const deferred = taskStore.deferTask(deferClaiming, 'hotpath defer')
  const deferScanCount = taskDirScanCount

  const requeueSeed = submit('task-hotpath-requeue')
  const requeueClaiming = taskStore.claimTaskById(requeueSeed.id, 'hotpath-worker')
  resetScans()
  const requeued = taskStore.requeueTask(requeueClaiming, 'hotpath requeue')
  const requeueScanCount = taskDirScanCount

  const failSeed = submit('task-hotpath-fail')
  const failClaiming = taskStore.claimTaskById(failSeed.id, 'hotpath-worker')
  resetScans()
  const failed = taskStore.failTask(failClaiming, new Error('hotpath fail'), { reason: 'hotpath fail' })
  const failScanCount = taskDirScanCount

  console.log(JSON.stringify({
    markScanCount,
    markStatus: markRunning && markRunning.status || '',
    markRunningFileStatus: readStatus('running', markSeed.kind, markSeed.id),
    completeScanCount,
    completeStatus: completed && completed.status || '',
    completeDoneFileStatus: readStatus('done', completeSeed.kind, completeSeed.id),
    deferScanCount,
    deferStatus: deferred && deferred.status || '',
    deferFileStatus: readStatus('deferred', deferSeed.kind, deferSeed.id),
    requeueScanCount,
    requeueStatus: requeued && requeued.status || '',
    requeueFileStatus: readStatus('pending', requeueSeed.kind, requeueSeed.id),
    failScanCount,
    failStatus: failed && failed.status || '',
    failFileStatus: readStatus('failed', failSeed.kind, failSeed.id),
  }, null, 2))
  process.exitCode = 0
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
} finally {
  files.listJsonFiles = originalListJsonFiles
  delete require.cache[taskStorePath]
}
`
  const summary = runScenario('D.32 task-store canonical hot path scan regression', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.32 markTaskRunning on canonical claiming should not rescan task status directories',
    summary.markScanCount === 0
      && summary.markStatus === 'running'
      && summary.markRunningFileStatus === 'running',
    JSON.stringify(summary))
  check('D.32 completeTask on canonical running should not rescan task status directories',
    summary.completeScanCount === 0
      && summary.completeStatus === 'done'
      && summary.completeDoneFileStatus === 'done',
    JSON.stringify(summary))
  check('D.32 defer/requeue/fail on canonical hot path should not rescan task status directories',
    summary.deferScanCount === 0
      && summary.deferStatus === 'deferred'
      && summary.deferFileStatus === 'deferred'
      && summary.requeueScanCount === 0
      && summary.requeueStatus === 'pending'
      && summary.requeueFileStatus === 'pending'
      && summary.failScanCount === 0
      && summary.failStatus === 'failed'
      && summary.failFileStatus === 'failed',
    JSON.stringify(summary))
}

// 运行 no-op 审计、恢复节流和热点路径写放大场景。
function runAuditAndPerformanceScenarios() {
  testExplicitTaskIdResubmitDoesNotRecreatePendingOrEvents()
  testDeferredAuditDoesNotCountNoOpTransitions()
  testStaleRunningAuditDoesNotCountNoOpFailure()
  testRecordedCleanupDoesNotCountNoOpTerminateAsCompleted()
  testNotifierDoesNotCountNoOpNotifyWriteback()
  testNotifierFailedCooldownRefreshesAfterRepeatedFailure()
  testPlannerStopEventsAreDedupedAcrossTicks()
  testDailyPrecomputeSchedulerStopsBeforePerChannelScanWhenBacklogIsFull()
  testPlannerBacklogStopHappensBeforeReadingLaterChannelData()
  testWorkerMainParksBeforeClaimWhenBackgroundDirectiveBlocks()
  testMediaQueueDoesNotRescanDeferredBacklogDuringCooldown()
  testDeferredAuditRestoresGraduallyWhenBacklogHasRecovered()
  testWorkerMainDoesNotReportWorkedWhenTaskOnlyDeferredOrRequeued()
  testMediaQueueEnqueueDoesNotDedupAgainstDoneHistoryWithoutCacheIndex()
  testMediaQueueCacheIndexIsTrimmedOnWrite()
  testPrecomputeCoverageAppendDoesNotRecomputeWhenSlotsUnchanged()
  testTaskStoreCanonicalHotPathDoesNotScanTaskDirs()
}

module.exports = { runAuditAndPerformanceScenarios }
