'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// === Scenario 1: S2 notifier 双副本不重复写回 ===
function testNotifierNoDuplicateWriteback() {
  const dataDir = createTempDataDir('resource-regress-notify-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

taskStore.ensureTaskDirs()
const taskId = 'daily_summary-regress-dup-1'
const kind = 'daily_summary'
// 构造同 taskId 的 done + failed 双副本，done 的 notify.status=pending,target=none。
const base = {
  id: taskId, kind, source: 'test', channelKey: '', userId: '', priority: 70,
  createdAt: '2026-06-10T00:00:00.000Z', updatedAt: '2026-06-10T00:00:00.000Z',
  expiresAt: '', timeoutMs: 120000, payload: {},
}
const doneFile = taskPaths.getTaskFile('done', kind, taskId)
const failedFile = taskPaths.getTaskFile('failed', kind, taskId)
fs.writeFileSync(doneFile, JSON.stringify({ ...base, status: 'done', notify: { target: 'none', status: 'pending' } }))
fs.writeFileSync(failedFile, JSON.stringify({ ...base, status: 'failed', notify: { target: 'none', status: 'pending' } }))

async function run() {
  // 第一轮：应把 done 副本标 skipped 一次。
  const r1 = await notifier.notifyCompletedTasks({ limit: 100 })
  const eventsAfter1 = readEvents().filter(e => e.event === 'task_notify_updated' && e.taskId === taskId).length
  // 再跑两轮：done 副本已是 skipped，shouldNotifyTask=false，不应再写 task_notify_updated。
  await notifier.notifyCompletedTasks({ limit: 100 })
  await notifier.notifyCompletedTasks({ limit: 100 })
  const eventsAfter3 = readEvents().filter(e => e.event === 'task_notify_updated' && e.taskId === taskId).length

  // 读 done 副本最终状态，确认写回打到 done 文件（扫描到的实体），而不是 failed 副本。
  const doneTask = JSON.parse(fs.readFileSync(doneFile, 'utf8'))

  const summary = {
    scanned1: r1.scanned,
    skipped1: r1.skipped,
    notifyUpdatedAfter1: eventsAfter1,
    notifyUpdatedAfter3: eventsAfter3,
    doneNotifyStatus: doneTask.notify && doneTask.notify.status,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 notifier double-copy scenario', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('notifier marks target=none daily_summary skipped once', summary.skipped1 >= 1 && summary.notifyUpdatedAfter1 === 1, JSON.stringify(summary))
  check('notifier does not rewrite skipped task on later ticks', summary.notifyUpdatedAfter3 === 1, JSON.stringify(summary))
  check('notifier writes back to the scanned done entity, not failed copy', summary.doneNotifyStatus === 'skipped', JSON.stringify(summary))
}

// === Scenario 1c: 终态任务回收 — cleanupFinishedTasks 删旧 done/result + 孤儿，保留近期 ===
// 命门：done/failed/cancelled 任务文件与 result 目录无运行时 GC，长期累积拖慢全表扫描并占盘。
// 本测试造「4 天前 done + result」「1 小时前 done + result」「孤儿 result（无任务文件）」，
// 跑 cleanupFinishedTasks(retentionDays=3)，断言旧的连同 result 被删、近的保留、孤儿被清。
function testCleanupFinishedTasksRemovesAgedAndOrphans() {
  const dataDir = createTempDataDir('resource-regress-gc-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

taskStore.ensureTaskDirs()
const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000

function writeDone(taskId, kind, finishedAt) {
  const file = taskPaths.getTaskFile('done', kind, taskId)
  fs.writeFileSync(file, JSON.stringify({
    id: taskId, kind, status: 'done', source: 'test', channelKey: '', userId: '', priority: 70,
    createdAt: new Date(finishedAt).toISOString(), updatedAt: new Date(finishedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(), expiresAt: '', timeoutMs: 120000, payload: {}, notify: { target: 'none', status: 'skipped' },
  }))
  const resultDir = taskPaths.getTaskResultDir(taskId)
  fs.mkdirSync(resultDir, { recursive: true })
  fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ taskId, ok: true }))
  return { file, resultDir }
}

// 4 天前的旧任务（应删）
const aged = writeDone('daily_slot-gc-aged-1', 'daily_slot', now - 4 * dayMs)
// 1 小时前的近任务（应保留）
const fresh = writeDone('daily_slot-gc-fresh-1', 'daily_slot', now - 60 * 60 * 1000)
// 孤儿 result：只有 result 目录，没有任何任务文件（应删）
const orphanDir = taskPaths.getTaskResultDir('daily_slot-gc-orphan-1')
fs.mkdirSync(orphanDir, { recursive: true })
fs.writeFileSync(path.join(orphanDir, 'result.json'), JSON.stringify({ taskId: 'daily_slot-gc-orphan-1', ok: true }))

const gc = taskStore.cleanupFinishedTasks({ retentionDays: 3, now })

const summary = {
  removed: gc.removed,
  resultsRemoved: gc.resultsRemoved,
  orphanResultsRemoved: gc.orphanResultsRemoved,
  agedTaskGone: !fs.existsSync(aged.file),
  agedResultGone: !fs.existsSync(aged.resultDir),
  freshTaskKept: fs.existsSync(fresh.file),
  freshResultKept: fs.existsSync(fresh.resultDir),
  orphanGone: !fs.existsSync(orphanDir),
}
console.log(JSON.stringify(summary, null, 2))
process.exitCode = 0
`
  const summary = runScenario('S2 cleanupFinishedTasks scenario', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('cleanup removes aged done task file', summary.agedTaskGone && summary.removed >= 1, JSON.stringify(summary))
  check('cleanup removes aged result dir', summary.agedResultGone && summary.resultsRemoved >= 1, JSON.stringify(summary))
  check('cleanup keeps fresh done task and result', summary.freshTaskKept && summary.freshResultKept, JSON.stringify(summary))
  check('cleanup removes orphan result dir', summary.orphanGone && summary.orphanResultsRemoved >= 1, JSON.stringify(summary))
}

// === Scenario 1b: S2 事件驱动 — fs.watch 监听 done 目录跨进程触发 notifier ===
// 命门：worker 子进程把任务写入 tasks/done/，主进程的 in-process 回调收不到（无 IPC）。
// 唯一主路径是 plugin-lifecycle 在 ready 时对 done 目录起 fs.watch；本测试把轮询间隔顶到
// 极大值，确保 ready 之后新出现的 done 文件只能由 fs.watch 触发 notifier，而非轮询兜底。
function testDoneWatcherTriggersNotifierEventDriven() {
  const dataDir = createTempDataDir('resource-regress-watch-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const lifecycle = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/plugin-lifecycle')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

const readyHandlers = []
const disposeHandlers = []
const ctx = {
  bots: [{ selfId: '90000', sendMessage: async () => {}, sendPrivateMessage: async () => {} }],
  on(event, handler) {
    if (event === 'ready') readyHandlers.push(handler)
    else if (event === 'dispose') disposeHandlers.push(handler)
  },
  logger() { return { info() {}, warn() {} } },
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function run() {
  taskStore.ensureTaskDirs()
  // 注册生命周期：debounce 调到 50ms 让测试更快；轮询间隔无法从这里改（默认 60s），
  // 测试窗口（<3s）内轮询绝不会触发，故任何写回都只能来自 fs.watch。
  process.env.RESOURCE_DONE_WATCH_DEBOUNCE_MS = '50'
  lifecycle.registerPluginLifecycle(ctx, {})
  // 触发 ready：起 fs.watch + 跑一次启动期 notifier（此刻 done 目录为空）。
  for (const handler of readyHandlers) { await handler() }
  await sleep(100)

  const kind = 'daily_summary'
  const taskId = kind + '-watch-eventdriven-1'
  const base = {
    id: taskId, kind, source: 'test', channelKey: '', userId: '', priority: 70,
    createdAt: '2026-06-10T00:00:00.000Z', updatedAt: '2026-06-10T00:00:00.000Z',
    expiresAt: '', timeoutMs: 120000, payload: {},
  }
  const doneFile = taskPaths.getTaskFile('done', kind, taskId)
  // ready 之后才写 done 文件 —— 模拟 worker 子进程完成任务、主进程没有 in-process 事件。
  // target=none 的 done 任务会被 notifier 标 skipped，是 notifier 确实跑过的可观测证据。
  fs.writeFileSync(doneFile, JSON.stringify({ ...base, status: 'done', notify: { target: 'none', status: 'pending' } }))

  // 只等 fs.watch + debounce，不主动调用 notifier。最多等 2.5s（远小于 60s 轮询）。
  let notifyStatus = 'pending'
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    await sleep(60)
    try {
      const task = JSON.parse(fs.readFileSync(doneFile, 'utf8'))
      notifyStatus = task.notify && task.notify.status
      if (notifyStatus && notifyStatus !== 'pending') break
    } catch (e) { /* 文件可能正被原子替换，重试 */ }
  }

  for (const handler of disposeHandlers) { try { handler() } catch (e) {} }

  const summary = { notifyStatusAfterWatch: notifyStatus }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 done watcher event-driven scenario', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_WORKER_SUPERVISOR_ENABLED: '0',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('done dir fs.watch triggers notifier without polling', summary.notifyStatusAfterWatch === 'skipped', JSON.stringify(summary))
}

// === Scenario 2: S3 red 内存下不 planning（green 对照） ===
function testPlannerSkipsUnderPressure() {
  const dataDir = createTempDataDir('resource-regress-plan-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')

const date = '2026-06-10'
const channelKey = 'group-regress-1'
// 写入足够的 precompute 记录，正常情况下应能规划出多个 slot。
for (let i = 0; i < 300; i++) {
  precomputeIndex.appendPrecomputeIndex({
    date,
    channelKey,
    messageId: 'msg-' + i,
    timestamp: 1717977600000 + i * 1000,
    userId: 'u' + (i % 5),
    text: 'regress message ' + i,
  })
}
const planned = planner.planDailySlotTasks(date, channelKey, { slotSize: 50, maxSlots: 12 })

const summary = {
  plannedCount: Array.isArray(planned) ? planned.length : -1,
}
console.log(JSON.stringify(summary, null, 2))
process.exitCode = 0
`
  // red 内存注入：availableMb 低于 300 MB 阈值。
  const summary = runScenario('S3 planner under red memory', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('S3 planner plans 0 slots under red memory', summary.plannedCount === 0, JSON.stringify(summary))
}

// === Scenario 3: S6 media-worker 资源不足不忙等 ===
function testMediaWorkerNoBusyLoop() {
  const dataDir = createTempDataDir('resource-regress-media-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const mediaWorker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')

mediaQueue.ensureMediaDirs()
// 入队一个图片媒体任务。
mediaQueue.enqueueMediaTask({
  kind: 'media_image_analysis',
  channelKey: 'group-regress-media',
  messageId: 'media-msg-1',
  url: 'http://example.invalid/regress-image-1.png',
})

// red 内存下，admission 应拒绝；drainOneMediaTask 必须返回 false（退避），不返回 true（忙等）。
mediaWorker.drainOneMediaTask({ workerName: 'media-worker', gateWaitMs: 1000 }).then(worked => {
  const status = mediaQueue.getMediaBackpressureStatus()
  const summary = {
    worked,
    imagePending: status.imagePending,
    running: Array.isArray(status.running) ? status.running.length : -1,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}).catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S6 media-worker under red memory', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('S6 drainOneMediaTask returns false (backoff) when admission rejects', summary.worked === false, JSON.stringify(summary))
  check('S6 task is requeued back to pending after reject', summary.imagePending === 1 && summary.running === 0, JSON.stringify(summary))
}

// === Scenario 4: S8 / S1 重复写盘节流 ===
function testResourceWriteDeduping() {
  const dataDir = createTempDataDir('resource-regress-dedup-')
  const script = String.raw`
const fs = require('fs')
const admission = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

const originalMemoryUsage = process.memoryUsage
const originalDateNow = Date.now
let fakeNow = Date.parse('2026-07-26T00:00:00.000Z')
Date.now = () => fakeNow
process.memoryUsage = () => ({
  rss: 900 * 1024 * 1024,
  heapTotal: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0,
})

try {
  const admissionInput = {
    taskId: 's1-dedup-task-1',
    kind: 'media_image_analysis',
    source: 'resource-regression',
    channelKey: 'group-dedup-1',
    userId: 'tester',
    exclusive: false,
    priority: 60,
    queueTimeoutMs: 30000,
    runTimeoutMs: 30000,
  }
  const decision1 = admission.admitTask(admissionInput)
  fakeNow += 100
  const decision2 = admission.admitTask({ ...admissionInput, taskId: 's1-dedup-task-2' })
  fakeNow += 1100
  const decision3 = admission.admitTask({ ...admissionInput, taskId: 's1-dedup-task-3' })
  systemProtection.collectProcessMetrics({ workerName: 'daily-worker', workerType: 'daily' })
  systemProtection.collectProcessMetrics({ workerName: 'daily-worker', workerType: 'daily' })
  systemProtection.checkWorkerMemoryLimit('daily-worker')
  systemProtection.checkWorkerMemoryLimit('daily-worker')
  const cleanup1 = systemProtection.terminateRecordedProcessPids({
    taskId: 'no-recorded-pid-task',
    kind: 'daily_report',
    owner: 'resource-regression',
    source: 'resource_regression_test',
  })
  const cleanup2 = systemProtection.terminateRecordedProcessPids({
    taskId: 'no-recorded-pid-task',
    kind: 'daily_report',
    owner: 'resource-regression',
    source: 'resource_regression_test',
  })

  const admissions = readJsonl(admission.admissionEventFile())
  const protection = systemProtection.getSystemProtectionStatus()
  const summary = {
    admissionDecision1: decision1.decision,
    admissionDecision2: decision2.decision,
    admissionDecision3: decision3.decision,
    admissionEvents: admissions.filter(item => item.event === 'admission_decided' && item.kind === 'media_image_analysis').length,
    admissionAggregateTotal: admissions.filter(item => item.event === 'admission_decided' && item.kind === 'media_image_analysis').reduce((sum, item) => sum + Number(item.aggregateCount || 0), 0),
    processMetricsEvents: protection.processMetrics.filter(item => item.event === 'process_metrics' && item.workerName === 'daily-worker').length,
    memoryRedEvents: protection.memoryAlerts.filter(item => item.event === 'memory_red' && item.thresholdMb).length,
    workerMemoryExceededEvents: protection.memoryAlerts.filter(item => item.event === 'worker_memory_limit_exceeded' && item.workerName === 'daily-worker').length,
    workerShouldExitEvents: protection.cleanupEvents.filter(item => item.event === 'worker_should_exit' && item.workerName === 'daily-worker').length,
    recordedCleanupCompletedEvents: protection.cleanupEvents.filter(item => item.event === 'recorded_process_cleanup_completed' && item.taskId === 'no-recorded-pid-task').length,
    cleanupEvent1: cleanup1.event,
    cleanupEvent2: cleanup2.event,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
} finally {
  Date.now = originalDateNow
  process.memoryUsage = originalMemoryUsage
}
`
  const summary = runScenario('S8/S1 write dedupe scenario', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_DAILY_WORKER_RSS_MB: '128',
    RESOURCE_ADMISSION_EVENT_AGGREGATE_MS: '1000',
  }, 30000)
  if (!summary) return
  check('S1 admission aggregates different taskIds by stable decision dimensions', summary.admissionEvents === 2 && summary.admissionAggregateTotal === 3, JSON.stringify(summary))
  check('S8 process metrics duplicate sample writes only one event', summary.processMetricsEvents === 1, JSON.stringify(summary))
  check('S8 memory_red duplicate alert writes only one event', summary.memoryRedEvents === 1, JSON.stringify(summary))
  check('S8 worker memory duplicate alert writes only one event per file', summary.workerMemoryExceededEvents === 1 && summary.workerShouldExitEvents === 1, JSON.stringify(summary))
  check('S8 recorded cleanup without candidates does not write completed summary', summary.recordedCleanupCompletedEvents === 0, JSON.stringify(summary))
}

// === Scenario 5: 阶段 A.1 提交门口 directive 兼容 ===
function testDirectiveBridgeCompatibility() {
  const dataDir = createTempDataDir('resource-regress-directive-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const {
  submitAgentWorkerTask,
} = require('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
const {
  acquireResourceGate,
} = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const constants = require('koishi-plugin-dongxuelian-ai/lib/core/constants')

function clearMaintenance() {
  try { fs.unlinkSync(constants.MAINTENANCE_FILE) } catch {}
}

async function run() {
  clearMaintenance()
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'

  const passResult = submitAgentWorkerTask({
    channel: 'qq',
    channelKey: 'directive-pass-group',
    userId: 'directive-user',
    payload: { entry: 'directive-pass' },
  })

  const gate = await acquireResourceGate({
    taskId: 'directive-lock-task',
    kind: 'daily_report',
    owner: 'resource-regression-test',
    source: 'resource_regression_test',
    exclusive: true,
    waitTimeoutMs: 1000,
  })
  let queueResult = null
  try {
    queueResult = submitAgentWorkerTask({
      channel: 'qq',
      channelKey: 'directive-queue-group',
      userId: 'directive-user-queue',
      payload: { entry: 'directive-queue' },
    })
  } finally {
    gate.release('directive-bridge-test')
  }

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '50'
  const deferResult = submitAgentWorkerTask({
    channel: 'qq',
    channelKey: 'directive-defer-group',
    userId: 'directive-user-defer',
    payload: { entry: 'directive-defer' },
  })

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  fs.mkdirSync(path.dirname(constants.MAINTENANCE_FILE), { recursive: true })
  fs.writeFileSync(constants.MAINTENANCE_FILE, 'maintenance', 'utf8')
  const rejectResult = submitAgentWorkerTask({
    channel: 'qq',
    channelKey: 'directive-reject-group',
    userId: 'directive-user-reject',
    payload: { entry: 'directive-reject' },
  })
  clearMaintenance()

  const date = '2026-06-10'
  const maintenanceChannel = 'directive-plan-maintenance'
  for (let i = 0; i < 24; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey: maintenanceChannel,
      messageId: 'maintenance-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 3),
      text: 'maintenance record ' + i,
    })
  }

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  fs.mkdirSync(path.dirname(constants.MAINTENANCE_FILE), { recursive: true })
  fs.writeFileSync(constants.MAINTENANCE_FILE, 'maintenance', 'utf8')
  const maintenancePlanned = planner.planDailySlotTasks(date, maintenanceChannel, { slotSize: 20, maxSlots: 4 })
  clearMaintenance()

  const summary = {
    passResult,
    queueResult,
    deferResult,
    rejectResult,
    maintenancePlannedCount: Array.isArray(maintenancePlanned) ? maintenancePlanned.length : -1,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('A.1 directive bridge compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('A.1 agent submit keeps pass success semantics',
    summary.passResult && summary.passResult.accepted === true && summary.passResult.status === 202 && /Agent 已提交后台执行/.test(summary.passResult.message || '') && !!summary.passResult.taskId,
    JSON.stringify(summary.passResult))
  check('A.1 agent submit keeps queue success semantics',
    summary.queueResult && summary.queueResult.accepted === true && summary.queueResult.status === 202 && /Agent 已加入资源队列/.test(summary.queueResult.message || '') && !!summary.queueResult.taskId,
    JSON.stringify(summary.queueResult))
  check('A.1 agent submit keeps defer blocked semantics',
    summary.deferResult && summary.deferResult.accepted === false && summary.deferResult.status === 202 && /当前资源紧张/.test(summary.deferResult.message || '') && !!summary.deferResult.taskId,
    JSON.stringify(summary.deferResult))
  check('A.1 agent submit keeps reject blocked semantics',
    summary.rejectResult && summary.rejectResult.accepted === false && summary.rejectResult.status === 503 && /当前资源不足，Agent 暂时不能执行/.test(summary.rejectResult.message || ''),
    JSON.stringify(summary.rejectResult))
  check('A.1 planner still skips under maintenance', summary.maintenancePlannedCount === 0, JSON.stringify(summary))
}

// === Scenario 6: 阶段 B.0 浏览器重任务互斥首落地 ===
function testBrowserActivityLeaseCompatibility() {
  const dataDir = createTempDataDir('resource-regress-browser-lease-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')
const constants = require('koishi-plugin-dongxuelian-ai/lib/core/constants')
const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')

const fakeBrowserPath = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'fake-blocked-chromium.exe')
fs.writeFileSync(fakeBrowserPath, '')
process.env.DONGXUELIAN_BROWSER_PATH = fakeBrowserPath
process.env.DONGXUELIAN_BROWSER_MIN_MEM_MB = '1'
const modeFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-control', 'config.json')
fs.mkdirSync(path.dirname(modeFile), { recursive: true })
fs.writeFileSync(modeFile, JSON.stringify({ serverMode: 'small', updatedAt: '2026-06-14T00:00:00.000Z' }, null, 2))

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  if (normalized === 'puppeteer-core') {
    return {
      launch: async () => {
        throw new Error('unexpected launch while render_active is blocked')
      },
    }
  }
  return originalLoad.apply(this, arguments)
}

const browserDir = path.join(constants.DATA_DIR, 'agent-browser')
const before = fs.existsSync(browserDir) ? fs.readdirSync(browserDir).length : 0
const releaseRender = activityLease.acquireResourceActivityLease('render_active', {
  owner: 'resource-regression-test',
  taskId: 'render-active-regression',
  ttlMs: 5000,
})

async function run() {
  try {
    const browserAction = require('koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
    let blocked = ''
    try {
      blocked = await browserAction.execute({
        action: 'start',
      }, {
        channel: 'dashboard',
        channelKey: 'dashboard-regression',
        userId: 'dashboard-user',
        resourceTaskId: 'browser-tool-regression',
        taskId: 'browser-tool-regression',
      })
    } catch (error) {
      blocked = error instanceof Error ? error.message : String(error || '')
    }
    const afterBlocked = fs.existsSync(browserDir) ? fs.readdirSync(browserDir).length : 0
    const renderLease = activityLease.readResourceActivityLease('render_active')
    const toolLease = activityLease.readResourceActivityLease('tool_active')
    const summary = {
      blocked,
      before,
      afterBlocked,
      renderLeaseExists: !!renderLease,
      toolLeaseExists: !!toolLease,
    }
    console.log(JSON.stringify(summary, null, 2))
    process.exitCode = 0
  } finally {
    releaseRender('resource-regression-finally')
    Module._load = originalLoad
  }
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('B.0 browser activity lease compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('B.0 browser_action is blocked while render_active lease exists',
    /render_active|资源保护|浏览器重任务/.test(String(summary.blocked || '')),
    JSON.stringify(summary))
  check('B.0 blocked browser_action does not create tool_active lease',
    summary.toolLeaseExists === false,
    JSON.stringify(summary))
  check('B.0 blocked browser_action leaves render_active lease intact',
    summary.renderLeaseExists === true,
    JSON.stringify(summary))
  check('B.0 blocked browser_action does not create browser artifact side effects',
    summary.before === summary.afterBlocked,
    JSON.stringify(summary))
}

function testBrowserActivityLeaseAllowsLargeMode() {
  const dataDir = createTempDataDir('resource-regress-browser-large-mode-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function makePage(browserState, id) {
  let closed = false
  return {
    __id: id,
    isClosed: () => closed,
    close: async () => {
      if (closed) return
      closed = true
      browserState.pages = browserState.pages.filter(page => page.__id !== id)
    },
    on: () => {},
    setRequestInterception: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => null,
    setUserAgent: async () => {},
    setViewport: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    url: () => 'about:blank',
    title: async () => 'fake-browser-title',
    target: () => ({ createCDPSession: async () => ({ send: async () => {} }) }),
    cookies: async () => [],
    context: () => ({ clearCookies: async () => {} }),
  }
}

function createBrowser(browserState) {
  let nextPageId = 0
  return {
    newPage: async () => {
      const page = makePage(browserState, ++nextPageId)
      browserState.pages.push(page)
      return page
    },
    pages: async () => browserState.pages.filter(page => !page.isClosed()),
    close: async () => {
      browserState.closed = true
      const pages = browserState.pages.slice()
      for (const page of pages) await page.close()
    },
    process: () => null,
  }
}

async function run() {
  const fakeBrowserPath = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'fake-chromium.exe')
  fs.writeFileSync(fakeBrowserPath, '')
  process.env.DONGXUELIAN_BROWSER_PATH = fakeBrowserPath
  process.env.DONGXUELIAN_BROWSER_MIN_MEM_MB = '1'

  const constants = require('koishi-plugin-dongxuelian-ai/lib/core/constants')
  const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
  const modeFile = path.join(constants.DATA_DIR, 'resource-control', 'config.json')
  fs.mkdirSync(path.dirname(modeFile), { recursive: true })
  fs.writeFileSync(modeFile, JSON.stringify({ serverMode: 'large', updatedAt: '2026-06-14T00:00:00.000Z' }, null, 2))

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\\\/g, '/')
    if (normalized === 'puppeteer-core') {
      return {
        launch: async () => createBrowser({ pages: [], cookies: [], closed: false }),
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const releaseRender = activityLease.acquireResourceActivityLease('render_active', {
    owner: 'resource-regression-test',
    taskId: 'render-active-large-mode',
    ttlMs: 5000,
  })

  try {
    const browserAction = require('koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
    const started = await browserAction.execute({
      action: 'start',
    }, {
      channel: 'dashboard',
      channelKey: 'dashboard-large-mode',
      userId: 'dashboard-user',
      resourceTaskId: 'browser-tool-large-mode',
      taskId: 'browser-tool-large-mode',
    })
    const toolLease = activityLease.readResourceActivityLease('tool_active')
    await browserAction.execute({ action: 'close' }, {
      channel: 'dashboard',
      channelKey: 'dashboard-large-mode',
      userId: 'dashboard-user',
      resourceTaskId: 'browser-tool-large-mode',
      taskId: 'browser-tool-large-mode',
    })
    console.log(JSON.stringify({
      started,
      toolLeaseExists: !!toolLease,
      toolLeaseOwner: toolLease && toolLease.owner || '',
    }, null, 2))
    process.exitCode = 0
  } finally {
    releaseRender('resource-regression-finally')
    Module._load = originalLoad
  }
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('B.0 browser activity lease large mode compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('B.0 large mode allows browser_action even while render_active exists',
    String(summary.started || '').includes('浏览器已启动'),
    JSON.stringify(summary))
  check('B.0 large mode still creates tool_active lease for active browser session',
    summary.toolLeaseExists === true && String(summary.toolLeaseOwner || '').includes('dashboard-user:dashboard-large-mode'),
    JSON.stringify(summary))
}

// === Scenario 7: 阶段 B browser_action 长会话 lease 续期止血 ===
function testBrowserActionLeaseRefreshKeepsActiveToolVisible() {
  const dataDir = createTempDataDir('resource-regress-browser-lease-refresh-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function makePage(browserState, id) {
  let closed = false
  return {
    __id: id,
    isClosed: () => closed,
    close: async () => {
      if (closed) return
      closed = true
      browserState.pages = browserState.pages.filter(page => page.__id !== id)
    },
    on: () => {},
    setRequestInterception: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => null,
    setUserAgent: async () => {},
    setViewport: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    url: () => 'about:blank',
    title: async () => 'fake-browser-title',
  }
}

function createBrowser(browserState) {
  let nextPageId = 0
  return {
    newPage: async () => {
      const page = makePage(browserState, ++nextPageId)
      browserState.pages.push(page)
      return page
    },
    pages: async () => browserState.pages.filter(page => !page.isClosed()),
    close: async () => {
      browserState.closed = true
      const pages = browserState.pages.slice()
      for (const page of pages) await page.close()
    },
    process: () => null,
  }
}

async function main() {
  const fakeBrowserPath = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'fake-chromium.exe')
  fs.writeFileSync(fakeBrowserPath, '')
  process.env.DONGXUELIAN_BROWSER_PATH = fakeBrowserPath
  process.env.DONGXUELIAN_BROWSER_MIN_MEM_MB = '1'

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\\\/g, '/')
    if (normalized === 'puppeteer-core') {
      return {
        launch: async () => createBrowser({ pages: [], cookies: [], closed: false }),
      }
    }
    if (normalized.endsWith('/resource-scheduler/admission') || normalized.includes('resource-scheduler/admission')) {
      return {
        admitTask: () => ({
          decision: 'run_now',
          reason: 'test-allow',
          resourceState: 'green',
          botMode: 'normal',
          memAvailableMb: 1600,
        }),
      }
    }
    return originalLoad.apply(this, arguments)
  }

  try {
    const browserAction = require('koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
    const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
    const session = {
      channel: 'dashboard',
      channelKey: 'dashboard-lease-refresh',
      userId: 'dashboard-user',
      taskId: 'browser-lease-refresh-task',
      resourceTaskId: 'browser-lease-refresh-task',
    }

    await browserAction.execute({ action: 'start' }, session)
    const initialLease = activityLease.readResourceActivityLease('tool_active')
    if (!initialLease) throw new Error('expected tool_active lease after browser start')

    const leaseFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-activity', 'tool_active.json')
    const staleLease = {
      ...initialLease,
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    fs.writeFileSync(leaseFile, JSON.stringify(staleLease, null, 2))

    const leaseAfterExpiryRead = activityLease.readResourceActivityLease('tool_active')
    await browserAction.execute({ action: 'title' }, session)
    const leaseAfterReuse = activityLease.readResourceActivityLease('tool_active')
    await browserAction.execute({ action: 'close' }, session)

    const summary = {
      initialLeaseExists: !!initialLease,
      expiredLeaseWasCleaned: leaseAfterExpiryRead === null,
      leaseRestoredAfterReuse: !!leaseAfterReuse,
      reusedLeaseTaskId: leaseAfterReuse && leaseAfterReuse.taskId || '',
      reusedLeaseOwner: leaseAfterReuse && leaseAfterReuse.owner || '',
    }
    console.log(JSON.stringify(summary, null, 2))
    process.exitCode = 0
  } finally {
    Module._load = originalLoad
  }
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('B browser_action lease refresh keeps active tool visible', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('B browser_action fixture really expires and cleans stale tool_active lease while browser stays alive',
    summary.initialLeaseExists === true && summary.expiredLeaseWasCleaned === true,
    JSON.stringify(summary))
  check('B browser_action should restore tool_active lease when reusing a still-open browser session',
    summary.leaseRestoredAfterReuse === true
      && summary.reusedLeaseTaskId === 'browser-lease-refresh-task'
      && summary.reusedLeaseOwner === 'dashboard-user:dashboard-lease-refresh',
    JSON.stringify(summary))
}

// === Scenario 8: 阶段 C.0 后台循环统一 directive 首落地 ===
function testBackgroundDirectiveCompatibility() {
  const dataDir = createTempDataDir('resource-regress-background-directive-')
  const script = String.raw`
const startupSchedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const mediaWorker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')

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

async function run() {
  const loggerStore = createCtx()
  mediaQueue.ensureMediaDirs()
  mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'group-background-directive',
    messageId: 'media-background-1',
    url: 'http://example.invalid/background-1.png',
  })

  const planning = await startupSchedulers.runDailyPrecomputePlanningTick(loggerStore.ctx)
  const mediaWorked = await mediaWorker.drainOneMediaTask({ workerName: 'media-worker', gateWaitMs: 1000 })
  const status = mediaQueue.getMediaBackpressureStatus()
  const parkedSleep = workerMain.resolveWorkerIdleSleepMs({
    type: 'media',
    workerName: 'media-worker',
    pollMs: 2000,
  }, false)
  const workedSleep = workerMain.resolveWorkerIdleSleepMs({
    type: 'media',
    workerName: 'media-worker',
    pollMs: 2000,
  }, true)
  const dailySleep = workerMain.resolveWorkerIdleSleepMs({
    type: 'daily',
    workerName: 'daily-worker',
    pollMs: 2000,
  }, false)

  const summary = {
    planning,
    mediaWorked,
    imagePending: status.imagePending,
    running: Array.isArray(status.running) ? status.running.length : -1,
    parkedSleep,
    workedSleep,
    dailySleep,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('C.0 background directive compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('C.0 daily precompute planning tick parks under red memory',
    summary.planning && summary.planning.parked === true && summary.planning.planned === 0,
    JSON.stringify(summary))
  check('C.0 media worker parks before claim under red memory',
    summary.mediaWorked === false && summary.imagePending === 1 && summary.running === 0,
    JSON.stringify(summary))
  check('C.0 background idle sleep adopts directive backoff while worked path stays fast',
    summary.parkedSleep >= 15000 && summary.workedSleep === 200 && summary.dailySleep >= 15000,
    JSON.stringify(summary))
}

// === Scenario 9: 阶段 C.2 事件型后台 LLM 提交前门收口 ===
function testBackgroundLlmSubmissionDirectiveCompatibility() {
  const dataDir = createTempDataDir('resource-regress-background-llm-submit-')
  const script = String.raw`
const background = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/background-llm-submission')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function listKindTasks(kind) {
  return ['pending', 'claiming', 'running', 'deferred', 'failed', 'done']
    .flatMap(status => taskStore.listResourceTasks({ statuses: [status], limit: 50 }))
    .filter(task => String(task.kind || '') === kind)
}

function run() {
  taskStore.ensureTaskDirs()

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '50'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
  const parkedSummary = background.submitConversationSummaryTask({
    key: 'group-c2::user-c2',
    source: 'conversation-summary-trigger',
  })
  const parkedSensitive = background.submitSensitiveCacheAnalysisTask({
    channelKey: 'group-sensitive-c2',
    source: 'sensitive-cache-trigger',
  })
  const afterParkedSummary = listKindTasks('conversation_summary')
  const afterParkedSensitive = listKindTasks('sensitive_cache_analysis')

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  const submittedSummary = background.submitConversationSummaryTask({
    key: 'group-c2-green::user-c2',
    source: 'conversation-summary-trigger',
  })
  const submittedSensitive = background.submitSensitiveCacheAnalysisTask({
    channelKey: 'group-sensitive-c2-green',
    source: 'sensitive-cache-trigger',
  })
  const afterGreenSummary = listKindTasks('conversation_summary')
  const afterGreenSensitive = listKindTasks('sensitive_cache_analysis')
  const summaryTask = afterGreenSummary.find(task => String(task.payload && task.payload.key || '') === 'group-c2-green::user-c2') || {}
  const sensitiveTask = afterGreenSensitive.find(task => String(task.channelKey || task.payload && task.payload.channelKey || '') === 'group-sensitive-c2-green') || {}

  console.log(JSON.stringify({
    parkedSummary,
    parkedSensitive,
    parkedSummaryCount: afterParkedSummary.length,
    parkedSensitiveCount: afterParkedSensitive.length,
    submittedSummary,
    submittedSensitive,
    greenSummaryCount: afterGreenSummary.length,
    greenSensitiveCount: afterGreenSensitive.length,
    summarySource: String(summaryTask.source || ''),
    summaryKey: String(summaryTask.payload && summaryTask.payload.key || ''),
    sensitiveSource: String(sensitiveTask.source || ''),
    sensitiveChannelKey: String(sensitiveTask.channelKey || sensitiveTask.payload && sensitiveTask.payload.channelKey || ''),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('C.2 background llm submission directive compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('C.2 conversation_summary parks before submission under red memory',
    summary.parkedSummary && summary.parkedSummary.accepted === false && summary.parkedSummaryCount === 0,
    JSON.stringify(summary))
  check('C.2 sensitive_cache_analysis parks before submission under red memory',
    summary.parkedSensitive && summary.parkedSensitive.accepted === false && summary.parkedSensitiveCount === 0,
    JSON.stringify(summary))
  check('C.2 conversation_summary still submits under green memory',
    summary.submittedSummary && summary.submittedSummary.accepted === true && summary.greenSummaryCount === 1,
    JSON.stringify(summary))
  check('C.2 sensitive_cache_analysis still submits under green memory',
    summary.submittedSensitive && summary.submittedSensitive.accepted === true && summary.greenSensitiveCount === 1,
    JSON.stringify(summary))
  check('C.2 background llm submissions preserve source and payload identity on submit',
    summary.summarySource === 'conversation-summary-trigger'
      && summary.summaryKey === 'group-c2-green::user-c2'
      && summary.sensitiveSource === 'sensitive-cache-trigger'
      && summary.sensitiveChannelKey === 'group-sensitive-c2-green',
    JSON.stringify(summary))
}

// === Scenario 10: 搜索优先 / tool_active 时后台前门应让路 ===
function testToolActiveBackgroundParkCompatibility() {
  const dataDir = createTempDataDir('resource-regress-tool-active-background-')
  const script = String.raw`
const startupSchedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
const background = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/background-llm-submission')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
const backgroundDirective = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/background-directive')

function createCtx() {
  return {
    bots: [{ selfId: 'tool-active-bot-1' }],
    logger() {
      return {
        info() {},
        warn() {},
      }
    },
  }
}

function listKindTasks(kind) {
  return ['pending', 'claiming', 'running', 'deferred', 'failed', 'done']
    .flatMap(status => taskStore.listResourceTasks({ statuses: [status], limit: 50 }))
    .filter(task => String(task.kind || '') === kind)
}

async function run() {
  taskStore.ensureTaskDirs()
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'

  const releaseTool = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'resource-regression-test',
    taskId: 'tool-active-regression',
    ttlMs: 5000,
  })

  try {
    const planning = await startupSchedulers.runDailyPrecomputePlanningTick(createCtx())
    const parkedSummary = background.submitConversationSummaryTask({
      key: 'group-tool-active::user-tool-active',
      source: 'conversation-summary-trigger',
    })
    const parkedSensitive = background.submitSensitiveCacheAnalysisTask({
      channelKey: 'group-sensitive-tool-active',
      source: 'sensitive-cache-trigger',
    })
    const afterSummary = listKindTasks('conversation_summary').length
    const afterSensitive = listKindTasks('sensitive_cache_analysis').length
    const mediaDirective = backgroundDirective.decideBackgroundDirective({
      kind: 'media_image_analysis',
      source: 'media-worker',
      channelKey: 'media',
      userId: '',
      priority: 60,
      exclusive: false,
      timeoutMs: 120000,
      queueTimeoutMs: 120000,
      runTimeoutMs: 120000,
    })
    const agentDirective = backgroundDirective.decideBackgroundDirective({
      kind: 'agent_task',
      source: 'agent-worker',
      channelKey: 'global',
      userId: '',
      priority: 40,
      exclusive: true,
      timeoutMs: 120000,
      queueTimeoutMs: 120000,
      runTimeoutMs: 120000,
    })
    console.log(JSON.stringify({
      planning,
      parkedSummary,
      parkedSensitive,
      afterSummary,
      afterSensitive,
      mediaDirectiveAction: mediaDirective.directive.action,
      agentDirectiveAction: agentDirective.directive.action,
    }, null, 2))
    process.exitCode = 0
  } finally {
    releaseTool('resource-regression-finally')
  }
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('搜索优先 tool_active 背景静默兼容', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('tool_active should park daily precompute planning while background work yields to foreground tool',
    summary.planning && summary.planning.parked === true && summary.planning.planned === 0,
    JSON.stringify(summary))
  check('tool_active should park background llm submissions before they materialize new tasks',
    summary.parkedSummary && summary.parkedSummary.accepted === false
      && summary.parkedSummary.status === 'parked'
      && summary.parkedSensitive && summary.parkedSensitive.accepted === false
      && summary.parkedSensitive.status === 'parked'
      && summary.afterSummary === 0
      && summary.afterSensitive === 0,
    JSON.stringify(summary))
  check('tool_active should park media background directive but keep agent task worker directive runnable',
    summary.mediaDirectiveAction === 'park'
      && summary.agentDirectiveAction === 'run',
    JSON.stringify(summary))
}

// === Scenario 11: tool_active 下已入队后台任务不应挡住前台任务 ===
function testToolActiveQueuedBackgroundTasksDoNotClaimOrStarveForegroundWork() {
  const dataDir = createTempDataDir('resource-regress-tool-active-queued-background-')
  const script = String.raw`
const fs = require('fs')
const Module = require('module')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function countTaskSignals(events, taskId, eventName) {
  return events.filter(event => event.event === eventName && String(event.taskId || '') === String(taskId || '')).length
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  if (normalized.endsWith('koishi-plugin-dongxuelian-ai/lib/behavior/emotion-renderer') || normalized.endsWith('koishi-plugin-dongxuelian-ai/src/behavior/emotion-renderer') || normalized.endsWith('../behavior/emotion-renderer')) {
    return {
      renderEmotionImageDirect: async () => Buffer.from('queued-foreground-emotion'),
    }
  }
  if (normalized.endsWith('/agent/engine') || normalized.endsWith('../agent/engine')) {
    return {
      run: async input => ({
        ok: true,
        reply: 'foreground agent worker kept running',
        message: '',
        toolCalls: Array.isArray(input && input.forceTools) ? input.forceTools.length : 0,
        toolResults: [],
      }),
      resumePending: async () => ({ ok: true, reply: 'resumed', toolCalls: 0, toolResults: [] }),
    }
  }
  return originalLoad.apply(this, arguments)
}

const taskClient = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-client')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
const { createAgentRunWorkerPayload } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/agent-payload')

async function run() {
  taskStore.ensureTaskDirs()
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'

  const eventFile = taskPaths.getWorkerEventFile()

  const summaryOnlyKey = 'tool-active-summary-only::user'
  const summaryOnly = taskClient.submitWorkerTaskWithAdmission({
    kind: 'conversation_summary',
    source: 'tool-active-summary-only',
    channelKey: 'tool-active-summary-only-group',
    userId: 'summary-only-user',
    priority: 10,
    timeoutMs: 120000,
    payload: { key: summaryOnlyKey },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: true })
  const summaryOnlyTaskId = summaryOnly.task && String(summaryOnly.task.id || '')
  const summaryOnlyEventsStart = readJsonl(eventFile).length
  const releaseSummaryOnly = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-summary-only',
    taskId: 'tool-active-summary-only',
    ttlMs: 5000,
  })
  try {
    await workerMain.runWorkerTick({ type: 'agent', workerName: 'tool-active-summary-only-agent', gateWaitMs: 1000 })
  } finally {
    releaseSummaryOnly('resource-regression-finally')
  }
  const summaryOnlyEvents = readJsonl(eventFile).slice(summaryOnlyEventsStart)
  const summaryOnlyState = summaryOnly.task ? taskStore.getResourceTaskById(summaryOnlyTaskId) : null

  const mixedSummaryKey = 'tool-active-mixed-summary::user'
  const queuedSummary = taskClient.submitWorkerTaskWithAdmission({
    kind: 'conversation_summary',
    source: 'tool-active-queued-summary',
    channelKey: 'tool-active-queued-group',
    userId: 'summary-user',
    priority: 10,
    timeoutMs: 120000,
    payload: { key: mixedSummaryKey },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: true })
  const summaryTaskId = queuedSummary.task && String(queuedSummary.task.id || '')
  const foregroundAgent = taskClient.submitWorkerTaskWithAdmission({
    kind: 'agent_task',
    source: 'tool-active-foreground-agent',
    channelKey: 'tool-active-queued-group',
    userId: 'foreground-user',
    priority: 40,
    timeoutMs: 120000,
    payload: {
      entry: 'tool-active-foreground-agent',
      agentWorker: createAgentRunWorkerPayload('tool-active-foreground-agent', {
        userMessage: 'tool_active foreground search',
        userId: 'foreground-user',
        channelKey: 'tool-active-queued-group',
        channel: 'qq',
        forceTools: ['web_search'],
        preExecuteTools: [],
        agentMode: true,
      }),
    },
    notify: { target: 'qq-group', status: 'pending', channelKey: 'tool-active-queued-group' },
  }, { checkAdmission: false, exclusive: true })
  const agentTaskId = foregroundAgent.task && String(foregroundAgent.task.id || '')
  const mixedAgentEventsStart = readJsonl(eventFile).length
  const releaseMixedAgent = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-queued-agent-mixed',
    taskId: 'tool-active-queued-agent-mixed',
    ttlMs: 5000,
  })
  try {
    await workerMain.runWorkerTick({ type: 'agent', workerName: 'tool-active-queued-agent', gateWaitMs: 1000 })
  } finally {
    releaseMixedAgent('resource-regression-finally')
  }
  const mixedAgentEvents = readJsonl(eventFile).slice(mixedAgentEventsStart)
  const summaryState = queuedSummary.task ? taskStore.getResourceTaskById(summaryTaskId) : null
  const agentState = foregroundAgent.task ? taskStore.getResourceTaskById(agentTaskId) : null

  const dailyOnly = taskClient.submitWorkerTaskWithAdmission({
    kind: 'daily_summary',
    source: 'tool-active-daily-only',
    channelKey: 'tool-active-daily-only-group',
    userId: '',
    priority: 10,
    timeoutMs: 120000,
    payload: {
      date: '2026-06-13',
      channelKey: 'tool-active-daily-only-group',
      slotId: 'slot-only',
      start: 0,
      end: 1,
      messageIds: ['msg-only'],
    },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: false })
  const dailyOnlyTaskId = dailyOnly.task && String(dailyOnly.task.id || '')
  const dailyOnlyEventsStart = readJsonl(eventFile).length
  const releaseDailyOnly = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-daily-only',
    taskId: 'tool-active-daily-only',
    ttlMs: 5000,
  })
  try {
    await workerMain.runWorkerTick({ type: 'daily', workerName: 'tool-active-daily-only-worker', gateWaitMs: 1000 })
  } finally {
    releaseDailyOnly('resource-regression-finally')
  }
  const dailyOnlyEvents = readJsonl(eventFile).slice(dailyOnlyEventsStart)
  const dailyOnlyState = dailyOnly.task ? taskStore.getResourceTaskById(dailyOnlyTaskId) : null

  const queuedDaily = taskClient.submitWorkerTaskWithAdmission({
    kind: 'daily_summary',
    source: 'tool-active-queued-daily',
    channelKey: 'tool-active-queued-group',
    userId: '',
    priority: 10,
    timeoutMs: 120000,
    payload: {
      date: '2026-06-13',
      channelKey: 'tool-active-queued-group',
      slotId: 'slot-1',
      start: 0,
      end: 1,
      messageIds: ['msg-1'],
    },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: false })
  const dailyTaskId = queuedDaily.task && String(queuedDaily.task.id || '')
  const foregroundEmotion = taskClient.submitWorkerTaskWithAdmission({
    kind: 'emotion_render',
    source: 'tool-active-foreground-emotion',
    channelKey: 'tool-active-queued-group',
    userId: 'emotion-user',
    priority: 55,
    timeoutMs: 120000,
    payload: {
      text: 'foreground emotion render',
      analysis: { score: 76, confidence: 84, mood: '偏乐观', summary: '气氛偏积极。', reasons: ['讨论持续'], keywords: ['worker'] },
      stats: { total: 3, positive: 2, negative: 0, neutral: 1 },
      history: [],
    },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: true })
  const emotionTaskId = foregroundEmotion.task && String(foregroundEmotion.task.id || '')
  const mixedDailyEventsStart = readJsonl(eventFile).length
  const releaseMixedDaily = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-queued-daily-mixed',
    taskId: 'tool-active-queued-daily-mixed',
    ttlMs: 5000,
  })
  try {
    await workerMain.runWorkerTick({ type: 'daily', workerName: 'tool-active-queued-daily', gateWaitMs: 1000 })
  } finally {
    releaseMixedDaily('resource-regression-finally')
  }
  const mixedDailyEvents = readJsonl(eventFile).slice(mixedDailyEventsStart)
  const dailyState = queuedDaily.task ? taskStore.getResourceTaskById(dailyTaskId) : null
  const emotionState = foregroundEmotion.task ? taskStore.getResourceTaskById(emotionTaskId) : null

  console.log(JSON.stringify({
    summaryOnlyStatus: summaryOnlyState && summaryOnlyState.status,
    summaryOnlyClaimed: countTaskSignals(summaryOnlyEvents, summaryOnlyTaskId, 'task_claimed'),
    summaryOnlyRequeued: countTaskSignals(summaryOnlyEvents, summaryOnlyTaskId, 'task_requeued'),
    summaryStatus: summaryState && summaryState.status,
    agentStatus: agentState && agentState.status,
    mixedSummaryClaimed: countTaskSignals(mixedAgentEvents, summaryTaskId, 'task_claimed'),
    mixedSummaryRequeued: countTaskSignals(mixedAgentEvents, summaryTaskId, 'task_requeued'),
    dailyOnlyStatus: dailyOnlyState && dailyOnlyState.status,
    dailyOnlyClaimed: countTaskSignals(dailyOnlyEvents, dailyOnlyTaskId, 'task_claimed'),
    dailyOnlyRequeued: countTaskSignals(dailyOnlyEvents, dailyOnlyTaskId, 'task_requeued'),
    dailyStatus: dailyState && dailyState.status,
    emotionStatus: emotionState && emotionState.status,
    mixedDailyClaimed: countTaskSignals(mixedDailyEvents, dailyTaskId, 'task_claimed'),
    mixedDailyRequeued: countTaskSignals(mixedDailyEvents, dailyTaskId, 'task_requeued'),
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('tool_active queued background claim compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('tool_active queued agent worker should leave background summary pending when no foreground task is available',
    summary.summaryOnlyStatus === 'pending'
      && summary.summaryOnlyClaimed === 0
      && summary.summaryOnlyRequeued === 0,
    JSON.stringify(summary))
  check('tool_active queued agent worker should skip background summary task but still execute foreground agent task',
    summary.summaryStatus === 'pending'
      && summary.agentStatus === 'done'
      && summary.mixedSummaryClaimed === 0
      && summary.mixedSummaryRequeued === 0,
    JSON.stringify(summary))
  check('tool_active queued daily worker should leave background daily_summary pending when no foreground task is available',
    summary.dailyOnlyStatus === 'pending'
      && summary.dailyOnlyClaimed === 0
      && summary.dailyOnlyRequeued === 0,
    JSON.stringify(summary))
  check('tool_active queued daily worker should skip background daily_summary but still execute foreground emotion render',
    summary.dailyStatus === 'pending'
      && summary.emotionStatus === 'done'
      && summary.mixedDailyClaimed === 0
      && summary.mixedDailyRequeued === 0,
    JSON.stringify(summary))
}

// === Scenario 11.1: tool_active 下过滤后的后台 backlog 不应挡住前台任务 ===
function testToolActiveQueuedBackgroundWindowDoesNotStarveForegroundWork() {
  const dataDir = createTempDataDir('resource-regress-tool-active-queued-window-')
  const script = String.raw`
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  if (normalized.endsWith('/agent/engine') || normalized.endsWith('../agent/engine')) {
    return {
      run: async () => ({
        ok: true,
        reply: 'foreground agent worker survived backlog window',
        message: '',
        toolCalls: 0,
        toolResults: [],
      }),
      resumePending: async () => ({ ok: true, reply: 'resumed', toolCalls: 0, toolResults: [] }),
    }
  }
  if (normalized.endsWith('koishi-plugin-dongxuelian-ai/lib/behavior/emotion-renderer') || normalized.endsWith('koishi-plugin-dongxuelian-ai/src/behavior/emotion-renderer') || normalized.endsWith('../behavior/emotion-renderer')) {
    return {
      renderEmotionImageDirect: async () => Buffer.from('foreground-emotion-window'),
    }
  }
  return originalLoad.apply(this, arguments)
}

const taskClient = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-client')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
const { createAgentRunWorkerPayload } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/agent-payload')

function submitQueuedConversationSummary(id, key) {
  return taskClient.submitWorkerTaskWithAdmission({
    id,
    kind: 'conversation_summary',
    source: 'tool-active-window-summary',
    channelKey: 'tool-active-window-group',
    userId: 'window-user',
    priority: 10,
    timeoutMs: 120000,
    payload: { key },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: true })
}

function submitQueuedDailySummary(id) {
  return taskClient.submitWorkerTaskWithAdmission({
    id,
    kind: 'daily_summary',
    source: 'tool-active-window-daily',
    channelKey: 'tool-active-window-daily-group',
    userId: '',
    priority: 10,
    timeoutMs: 120000,
    payload: {
      date: '2026-06-13',
      channelKey: 'tool-active-window-daily-group',
      slotId: id,
      start: 0,
      end: 1,
      messageIds: [id + '-msg'],
    },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: false })
}

async function run() {
  taskStore.ensureTaskDirs()
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'

  for (let i = 0; i < 1000; i += 1) {
    const key = 'tool-active-window-summary-' + i + '::user'
    submitQueuedConversationSummary('tool-active-window-summary-' + String(i).padStart(4, '0'), key)
  }
  const foregroundAgent = taskClient.submitWorkerTaskWithAdmission({
    id: 'tool-active-window-foreground-agent',
    kind: 'agent_task',
    source: 'tool-active-window-foreground-agent',
    channelKey: 'tool-active-window-group',
    userId: 'foreground-window-user',
    priority: 40,
    timeoutMs: 120000,
    payload: {
      entry: 'tool-active-window-foreground-agent',
      agentWorker: createAgentRunWorkerPayload('tool-active-window-foreground-agent', {
        userMessage: 'tool_active foreground survives backlog window',
        userId: 'foreground-window-user',
        channelKey: 'tool-active-window-group',
        channel: 'qq',
        forceTools: ['web_search'],
        preExecuteTools: [],
        agentMode: true,
      }),
    },
    notify: { target: 'qq-group', status: 'pending', channelKey: 'tool-active-window-group' },
  }, { checkAdmission: false, exclusive: true })

  const releaseAgentLease = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-window-agent',
    taskId: 'tool-active-window-agent',
    ttlMs: 5000,
  })
  let agentWorked = false
  try {
    agentWorked = await workerMain.runWorkerTick({ type: 'agent', workerName: 'tool-active-window-agent-worker', gateWaitMs: 1000 })
  } finally {
    releaseAgentLease('resource-regression-finally')
  }
  const foregroundAgentState = taskStore.getResourceTaskById('tool-active-window-foreground-agent')

  for (let i = 0; i < 1000; i += 1) {
    submitQueuedDailySummary('tool-active-window-daily-' + String(i).padStart(4, '0'))
  }
  const foregroundEmotion = taskClient.submitWorkerTaskWithAdmission({
    id: 'tool-active-window-foreground-emotion',
    kind: 'emotion_render',
    source: 'tool-active-window-foreground-emotion',
    channelKey: 'tool-active-window-daily-group',
    userId: 'foreground-emotion-user',
    priority: 55,
    timeoutMs: 120000,
    payload: {
      text: 'foreground emotion render survives backlog window',
      analysis: { score: 80, confidence: 88, mood: '稳定', summary: '窗口饥饿测试。', reasons: ['高优先级前台'], keywords: ['worker'] },
      stats: { total: 3, positive: 2, negative: 0, neutral: 1 },
      history: [],
    },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: true })

  const releaseDailyLease = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'tool-active-window-daily',
    taskId: 'tool-active-window-daily',
    ttlMs: 5000,
  })
  let dailyWorked = false
  try {
    dailyWorked = await workerMain.runWorkerTick({ type: 'daily', workerName: 'tool-active-window-daily-worker', gateWaitMs: 1000 })
  } finally {
    releaseDailyLease('resource-regression-finally')
  }
  const foregroundEmotionState = taskStore.getResourceTaskById('tool-active-window-foreground-emotion')

  console.log(JSON.stringify({
    agentWorked,
    foregroundAgentStatus: foregroundAgentState && foregroundAgentState.status,
    dailyWorked,
    foregroundEmotionStatus: foregroundEmotionState && foregroundEmotionState.status,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  Module._load = originalLoad
})
`
  const summary = runScenario('tool_active queued background window compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('tool_active queued agent worker should still reach foreground agent task when filtered background backlog is large',
    summary.agentWorked === true
      && summary.foregroundAgentStatus === 'done',
    JSON.stringify(summary))
  check('tool_active queued daily worker should still reach foreground emotion task when filtered daily backlog is large',
    summary.dailyWorked === true
      && summary.foregroundEmotionStatus === 'done',
    JSON.stringify(summary))
}

// === Scenario 12: 阶段 D.1 S6 媒体任务冷却止血 ===
function testMediaQueueDeferredCooldownCompatibility() {
  const dataDir = createTempDataDir('resource-regress-media-cooldown-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')

function findPendingTaskFile(task) {
  return path.join(mediaQueue.MEDIA_QUEUE_ROOT, 'image', task.id + '.json')
}

function run() {
  mediaQueue.ensureMediaDirs()
  const created = mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'group-media-cooldown',
    messageId: 'media-cooldown-1',
    url: 'http://example.invalid/media-cooldown-1.png',
  })
  const claimed = mediaQueue.claimNextMediaTask('media-worker')
  const requeued = mediaQueue.requeueMediaTask(claimed, 'resource_defer')
  const pendingFile = findPendingTaskFile(requeued)
  const pendingTask = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : null
  const immediateClaim = mediaQueue.claimNextMediaTask('media-worker')

  const originalNow = Date.now
  try {
    const deferredUntilMs = Date.parse(String((pendingTask && (pendingTask.deferredUntil || pendingTask.notBefore)) || ''))
    if (Number.isFinite(deferredUntilMs) && deferredUntilMs > 0) {
      Date.now = () => deferredUntilMs + 1000
    } else {
      Date.now = () => originalNow() + 60 * 1000
    }
    const afterCooldownClaim = mediaQueue.claimNextMediaTask('media-worker')
    console.log(JSON.stringify({
      createdId: created && created.id,
      deferredUntil: pendingTask && (pendingTask.deferredUntil || pendingTask.notBefore) || '',
      immediateClaimId: immediateClaim && immediateClaim.id || '',
      afterCooldownClaimId: afterCooldownClaim && afterCooldownClaim.id || '',
    }, null, 2))
    process.exitCode = 0
  } finally {
    Date.now = originalNow
  }
}

run()
`
  const summary = runScenario('D.1 media queue deferred cooldown compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('D.1 media requeue writes explicit deferred cooldown field',
    !!summary.deferredUntil,
    JSON.stringify(summary))
  check('D.1 media task is not immediately reclaimable during cooldown',
    !summary.immediateClaimId,
    JSON.stringify(summary))
  check('D.1 media task becomes reclaimable after cooldown passes',
    !!summary.afterCooldownClaimId && summary.afterCooldownClaimId === summary.createdId,
    JSON.stringify(summary))
}

// === Scenario 11: 阶段 D.2 S3 failed slot retryAfter 冷却止血 ===
function testPlannerRetryAfterForFailedSlotCompatibility() {
  const dataDir = createTempDataDir('resource-regress-slot-retry-')
  const script = String.raw`
const fs = require('fs')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function run() {
  const date = '2026-06-10'
  const channelKey = 'group-slot-retry'
  for (let i = 0; i < 40; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: 'retry-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'retry record ' + i,
    })
  }

  const firstPlanned = planner.planDailySlotTasks(date, channelKey, { slotSize: 50, maxSlots: 1 })
  const firstSubmit = Array.isArray(firstPlanned) ? firstPlanned[0] : null
  const firstTask = firstSubmit && firstSubmit.task
  if (!firstTask || !firstTask.id) throw new Error('expected first planned daily_summary task')

  taskStore.failTask(firstTask, new Error('daily slot regression failure'))
  const failedTask = taskStore.getResourceTaskById(firstTask.id)
  const immediatePlanned = planner.planDailySlotTasks(date, channelKey, { slotSize: 50, maxSlots: 1 })

  const originalNow = Date.now
  let afterRetryPlanned = []
  try {
    const retryAfterMs = Date.parse(String((failedTask && failedTask.retryAfter) || ''))
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      Date.now = () => retryAfterMs + 1000
    } else {
      Date.now = () => originalNow() + 60 * 60 * 1000
    }
    afterRetryPlanned = planner.planDailySlotTasks(date, channelKey, { slotSize: 50, maxSlots: 1 })
  } finally {
    Date.now = originalNow
  }

  const failedFile = taskPaths.getTaskFile('failed', firstTask.kind, firstTask.id)
  const pendingFile = taskPaths.getTaskFile('pending', firstTask.kind, firstTask.id)
  const afterRetryTask = Array.isArray(afterRetryPlanned) && afterRetryPlanned[0] ? afterRetryPlanned[0].task : null

  console.log(JSON.stringify({
    firstTaskId: firstTask.id,
    failedRetryAfter: failedTask && failedTask.retryAfter || '',
    immediatePlannedCount: Array.isArray(immediatePlanned) ? immediatePlanned.length : -1,
    afterRetryPlannedCount: Array.isArray(afterRetryPlanned) ? afterRetryPlanned.length : -1,
    afterRetryTaskId: afterRetryTask && afterRetryTask.id || '',
    failedFileExists: fs.existsSync(failedFile),
    pendingFileExists: fs.existsSync(pendingFile),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.2 planner retryAfter for failed slot compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.2 failed daily slot writes explicit retryAfter field',
    !!summary.failedRetryAfter,
    JSON.stringify(summary))
  check('D.2 planner does not immediately resubmit failed slot before retryAfter',
    summary.immediatePlannedCount === 0,
    JSON.stringify(summary))
  check('D.2 planner resubmits failed slot after retryAfter passes',
    summary.afterRetryPlannedCount === 1 && summary.afterRetryTaskId === summary.firstTaskId,
    JSON.stringify(summary))
  check('D.2 retry recovery does not leave failed and pending dual copies',
    summary.failedFileExists === false && summary.pendingFileExists === true,
    JSON.stringify(summary))
}

// === Scenario 12: 阶段 D.3 S3 coverage 足够即停止补小尾巴 ===
function testPlannerStopsTailFillWhenCoverageIsEnough() {
  const dataDir = createTempDataDir('resource-regress-slot-tail-stop-')
  const script = String.raw`
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const slotWorker = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-worker')
const summaryMerge = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-summary-merge')
const coverage = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-coverage')

function seedChannel(date, channelKey, total) {
  for (let i = 0; i < total; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: channelKey + '-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      userName: 'user-' + (i % 4),
      text: 'tail stop record ' + i,
    })
  }
}

function run() {
  const date = '2026-06-10'
  const highCoverageChannel = 'group-slot-tail-stop-high'
  const lowCoverageChannel = 'group-slot-tail-stop-low'
  seedChannel(date, highCoverageChannel, 100)
  seedChannel(date, lowCoverageChannel, 100)

  slotWorker.runDailySlotTask({
    id: 'tail-stop-high-slot',
    channelKey: highCoverageChannel,
    payload: {
      date,
      channelKey: highCoverageChannel,
      slotId: 'tail-stop-high-slot',
      messageIds: Array.from({ length: 95 }, (_, index) => highCoverageChannel + '-msg-' + index),
    },
  })

  slotWorker.runDailySlotTask({
    id: 'tail-stop-low-slot',
    channelKey: lowCoverageChannel,
    payload: {
      date,
      channelKey: lowCoverageChannel,
      slotId: 'tail-stop-low-slot',
      messageIds: Array.from({ length: 80 }, (_, index) => lowCoverageChannel + '-msg-' + index),
    },
  })

  const highPlanned = planner.planDailySlotTasks(date, highCoverageChannel, { slotSize: 20, maxSlots: 4 })
  const lowPlanned = planner.planDailySlotTasks(date, lowCoverageChannel, { slotSize: 20, maxSlots: 4 })
  const highFinalInput = summaryMerge.mergeDailyFinalInput(date, highCoverageChannel)
  const highCoverage = coverage.readDailyCoverage(date, highCoverageChannel)

  console.log(JSON.stringify({
    highPlannedCount: Array.isArray(highPlanned) ? highPlanned.length : -1,
    lowPlannedCount: Array.isArray(lowPlanned) ? lowPlanned.length : -1,
    highUncoveredTailCount: Array.isArray(highFinalInput && highFinalInput.uncoveredTail) ? highFinalInput.uncoveredTail.length : -1,
    highCoverageRate: Number(highCoverage && highCoverage.coverageRate || 0),
    highCoveredMessages: Number(highCoverage && highCoverage.coveredMessages || 0),
    highTotalMessages: Number(highCoverage && highCoverage.totalMessages || 0),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.3 planner stops tail fill when coverage is enough', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.3 planner stops scheduling when only a tiny tail remains at high coverage',
    summary.highPlannedCount === 0,
    JSON.stringify(summary))
  check('D.3 final-input still keeps the real uncovered tail instead of hiding it',
    summary.highUncoveredTailCount === 5,
    JSON.stringify(summary))
  check('D.3 coverage accounting stays honest after stopping tail fill',
    summary.highCoverageRate === 0.95 && summary.highCoveredMessages === 95 && summary.highTotalMessages === 100,
    JSON.stringify(summary))
  check('D.3 planner still schedules when coverage is not yet high enough',
    summary.lowPlannedCount > 0,
    JSON.stringify(summary))
}

// === Scenario 13: 阶段 D.6 中间洞不应被误判成小尾巴 ===
function testPlannerDoesNotMistakeMiddleGapForTail() {
  const dataDir = createTempDataDir('resource-regress-slot-middle-gap-')
  const script = String.raw`
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const slotWorker = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-worker')

function run() {
  const date = '2026-06-10'
  const channelKey = 'group-slot-middle-gap'
  for (let i = 0; i < 100; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: 'middle-gap-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'middle gap record ' + i,
    })
  }

  const coveredMessageIds = []
  for (let i = 0; i < 100; i++) {
    if (i >= 40 && i <= 44) continue
    coveredMessageIds.push('middle-gap-msg-' + i)
  }

  slotWorker.runDailySlotTask({
    id: 'middle-gap-coverage-95',
    channelKey,
    payload: {
      date,
      channelKey,
      slotId: 'middle-gap-coverage-95',
      messageIds: coveredMessageIds,
    },
  })

  const planned = planner.planDailySlotTasks(date, channelKey, { slotSize: 20, maxSlots: 4 })
  const firstTask = Array.isArray(planned) ? planned[0] && planned[0].task : null
  const firstPayload = firstTask && firstTask.payload || {}

  console.log(JSON.stringify({
    plannedCount: Array.isArray(planned) ? planned.length : -1,
    firstTaskStart: Number(firstPayload.start),
    firstTaskEnd: Number(firstPayload.end),
    firstTaskMessageIds: Array.isArray(firstPayload.messageIds) ? firstPayload.messageIds : [],
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.6 planner keeps scheduling when uncovered gap is in the middle', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.6 planner continues scheduling when 95% coverage still leaves a middle gap',
    summary.plannedCount > 0,
    JSON.stringify(summary))
  check('D.6 first planned deterministic slot targets the uncovered middle gap range',
    summary.firstTaskStart === 40 && summary.firstTaskEnd === 60
      && Array.isArray(summary.firstTaskMessageIds)
      && summary.firstTaskMessageIds.includes('middle-gap-msg-40')
      && summary.firstTaskMessageIds.includes('middle-gap-msg-44'),
    JSON.stringify(summary))
}

// === Scenario 14: 阶段 D.4 S3 队列积压时停止继续 planning ===
function testPlannerStopsWhenDailySummaryBacklogExists() {
  const blockedDataDir = createTempDataDir('resource-regress-slot-backlog-stop-')
  const blockedScript = String.raw`
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function countActiveDailySummaryTasks() {
  return taskStore.listResourceTasks({ statuses: ['pending', 'claiming', 'running', 'deferred'], limit: 50 })
    .filter(task => String(task.kind || '') === 'daily_summary')
    .length
}

function seedChannel(date, channelKey, total) {
  for (let i = 0; i < total; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: channelKey + '-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'backlog stop record ' + i,
    })
  }
}

function run() {
  const date = '2026-06-10'
  const channelKey = 'group-slot-backlog-stop-blocked'
  seedChannel(date, channelKey, 120)
  taskStore.submitResourceTask({
    id: 'existing-daily-backlog-1',
    kind: 'daily_summary',
    source: 'resource-regression-backlog',
    channelKey: 'group-existing-backlog',
    priority: 70,
    timeoutMs: 120000,
    payload: { date, channelKey: 'group-existing-backlog', slotId: 'existing-slot-1' },
    notify: { target: 'none', status: 'pending' },
  })
  const activeBefore = countActiveDailySummaryTasks()
  const planned = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
  console.log(JSON.stringify({
    plannedCount: Array.isArray(planned) ? planned.length : -1,
    activeBefore,
    activeAfter: countActiveDailySummaryTasks(),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const blockedSummary = runScenario('D.4 planner stops when daily_summary backlog exists', blockedScript, {
    DONGXUELIAN_AI_DATA_DIR: blockedDataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    DAILY_SLOT_BACKLOG_STOP_MAX_PENDING: '1',
  }, 30000)
  if (!blockedSummary) return
  check('D.4 planner stops scheduling when daily_summary backlog already reached threshold',
    blockedSummary.plannedCount === 0,
    JSON.stringify(blockedSummary))
  check('D.4 planner does not create extra daily_summary active tasks while backlog is blocking',
    blockedSummary.activeBefore === 1 && blockedSummary.activeAfter === 1,
    JSON.stringify(blockedSummary))

  const controlDataDir = createTempDataDir('resource-regress-slot-backlog-control-')
  const controlScript = String.raw`
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function seedChannel(date, channelKey, total) {
  for (let i = 0; i < total; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: channelKey + '-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'backlog control record ' + i,
    })
  }
}

function run() {
  const date = '2026-06-10'
  const channelKey = 'group-slot-backlog-stop-control'
  seedChannel(date, channelKey, 120)
  taskStore.submitResourceTask({
    id: 'foreign-backlog-agent-1',
    kind: 'agent_task',
    source: 'resource-regression-backlog',
    channelKey: 'group-foreign-backlog',
    priority: 50,
    timeoutMs: 120000,
    payload: { entry: 'foreign-backlog' },
    notify: { target: 'none', status: 'pending' },
  })
  const planned = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
  console.log(JSON.stringify({
    plannedCount: Array.isArray(planned) ? planned.length : -1,
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const controlSummary = runScenario('D.4 planner ignores non-daily backlog', controlScript, {
    DONGXUELIAN_AI_DATA_DIR: controlDataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    DAILY_SLOT_BACKLOG_STOP_MAX_PENDING: '1',
  }, 30000)
  if (!controlSummary) return
  check('D.4 planner still schedules when only non-daily backlog exists',
    controlSummary.plannedCount > 0,
    JSON.stringify(controlSummary))
}

// === Scenario 15: 阶段 D.5 retryAfter 恢复不应被 tail-stop 吞掉 ===
function testPlannerRetryRestoreSurvivesTailStop() {
  const dataDir = createTempDataDir('resource-regress-slot-retry-tail-stop-')
  const script = String.raw`
const fs = require('fs')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const slotWorker = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-worker')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function run() {
  const date = '2026-06-10'
  const channelKey = 'group-slot-retry-tail-stop'
  for (let i = 0; i < 100; i++) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: 'retry-tail-msg-' + i,
      timestamp: 1717977600000 + i * 1000,
      userId: 'u' + (i % 4),
      text: 'retry tail stop record ' + i,
    })
  }

  const initialPlanned = planner.planDailySlotTasks(date, channelKey, { slotSize: 20, maxSlots: 5 })
  const failedSubmit = Array.isArray(initialPlanned) ? initialPlanned[4] : null
  const failedTask = failedSubmit && failedSubmit.task
  if (!failedTask || !failedTask.id) throw new Error('expected deterministic failed slot task')

  slotWorker.runDailySlotTask({
    id: 'retry-tail-stop-coverage-95',
    channelKey,
    payload: {
      date,
      channelKey,
      slotId: 'retry-tail-stop-coverage-95',
      messageIds: Array.from({ length: 95 }, (_, index) => 'retry-tail-msg-' + index),
    },
  })

  taskStore.failTask(failedTask, new Error('forced retry restore after tail stop'))
  const failedSnapshot = taskStore.getResourceTaskById(failedTask.id)

  const originalNow = Date.now
  let afterRetryPlanned = []
  try {
    const retryAfterMs = Date.parse(String((failedSnapshot && failedSnapshot.retryAfter) || ''))
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      Date.now = () => retryAfterMs + 1000
    } else {
      Date.now = () => originalNow() + 60 * 60 * 1000
    }
    afterRetryPlanned = planner.planDailySlotTasks(date, channelKey, { slotSize: 20, maxSlots: 5 })
  } finally {
    Date.now = originalNow
  }

  const restored = Array.isArray(afterRetryPlanned) ? afterRetryPlanned[0] : null
  const failedFile = taskPaths.getTaskFile('failed', failedTask.kind, failedTask.id)
  const pendingFile = taskPaths.getTaskFile('pending', failedTask.kind, failedTask.id)

  console.log(JSON.stringify({
    failedTaskId: failedTask.id,
    failedRetryAfter: failedSnapshot && failedSnapshot.retryAfter || '',
    afterRetryPlannedCount: Array.isArray(afterRetryPlanned) ? afterRetryPlanned.length : -1,
    restoredFlag: !!(restored && restored.restored),
    restoredTaskId: restored && restored.task && restored.task.id || '',
    failedFileExists: fs.existsSync(failedFile),
    pendingFileExists: fs.existsSync(pendingFile),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.5 retryAfter restore survives tail-stop', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    DAILY_SLOT_BACKLOG_STOP_MAX_PENDING: '99',
  }, 30000)
  if (!summary) return
  check('D.5 retryAfter-expired failed slot is still restored under high-coverage tiny-tail state',
    summary.afterRetryPlannedCount === 1 && summary.restoredFlag === true && summary.restoredTaskId === summary.failedTaskId,
    JSON.stringify(summary))
  check('D.5 retry restore still removes failed copy and recreates pending copy under tail-stop pressure',
    summary.failedFileExists === false && summary.pendingFileExists === true,
    JSON.stringify(summary))
}

// 运行资源调度、directive、活动租约和基础 notifier 场景。
function runSchedulingAndDirectiveScenarios() {
  testNotifierNoDuplicateWriteback()
  testCleanupFinishedTasksRemovesAgedAndOrphans()
  testDoneWatcherTriggersNotifierEventDriven()
  testPlannerSkipsUnderPressure()
  testMediaWorkerNoBusyLoop()
  testResourceWriteDeduping()
  testDirectiveBridgeCompatibility()
  testBrowserActivityLeaseCompatibility()
  testBrowserActivityLeaseAllowsLargeMode()
  testBrowserActionLeaseRefreshKeepsActiveToolVisible()
  testBackgroundDirectiveCompatibility()
  testBackgroundLlmSubmissionDirectiveCompatibility()
  testToolActiveBackgroundParkCompatibility()
  testToolActiveQueuedBackgroundTasksDoNotClaimOrStarveForegroundWork()
  testToolActiveQueuedBackgroundWindowDoesNotStarveForegroundWork()
  testMediaQueueDeferredCooldownCompatibility()
  testPlannerRetryAfterForFailedSlotCompatibility()
  testPlannerStopsTailFillWhenCoverageIsEnough()
  testPlannerDoesNotMistakeMiddleGapForTail()
  testPlannerStopsWhenDailySummaryBacklogExists()
  testPlannerRetryRestoreSurvivesTailStop()
}

module.exports = { runSchedulingAndDirectiveScenarios }
