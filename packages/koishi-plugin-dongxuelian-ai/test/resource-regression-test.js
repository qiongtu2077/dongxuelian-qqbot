/**
 * S0-S8 资源架构重整 — 阶段 0 止血回归测试。
 * 覆盖本次事故链的三处具体 bug（见 待完成与待审核任务/2026-06-10-S0-S8资源架构重整计划.md 9.13.2 阶段 0）：
 *   1. S2 result-notifier：同 taskId done/failed 双副本不再每轮 tick 重复写回 notify 状态。
 *   2. S3 daily-slot-planner：black/maintenance 下不 planning（planned=0），并由其他场景补 red 语义。
 *   3. S6 media-worker：资源不足时 requeue 后不返回“有工作”，避免 200ms claim/requeue 忙等。
 * 用临时 DATA_DIR + 子进程，不写生产数据。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`OK   ${label}`)
  } else {
    failed++
    console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

function createTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function parseScenarioOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) throw new Error('child produced no stdout')
  const start = text.lastIndexOf('\n{')
  const jsonText = start >= 0 ? text.slice(start + 1) : text
  return JSON.parse(jsonText)
}

function runScenario(label, script, env, timeoutMs = 30000) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  check(`${label} exits 0`, result.status === 0, `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`)
  if (result.status !== 0) return null
  try {
    return parseScenarioOutput(result.stdout)
  } catch (error) {
    check(`${label} output is JSON`, false, error instanceof Error ? error.message : String(error))
    return null
  }
}

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

// === Scenario 2: S3 black 内存下不 planning（green 对照） ===
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
  // black 内存注入：availableMb 远低于 RED 阈值（300）。
  const summary = runScenario('S3 planner under black memory', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('S3 planner plans 0 slots under black memory', summary.plannedCount === 0, JSON.stringify(summary))
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

// black 内存下，admission 应拒绝；drainOneMediaTask 必须返回 false（退避），不返回 true（忙等）。
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
  const summary = runScenario('S6 media-worker under black memory', script, {
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
    memoryBlackEvents: protection.memoryAlerts.filter(item => item.event === 'memory_black' && item.thresholdMb).length,
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
  check('S8 memory_black duplicate alert writes only one event', summary.memoryBlackEvents === 1, JSON.stringify(summary))
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
  check('C.0 daily precompute planning tick parks under black memory',
    summary.planning && summary.planning.parked === true && summary.planning.planned === 0,
    JSON.stringify(summary))
  check('C.0 media worker parks before claim under black memory',
    summary.mediaWorked === false && summary.imagePending === 1 && summary.running === 0,
    JSON.stringify(summary))
  check('C.0 background idle sleep adopts directive backoff while worked path stays fast',
    summary.parkedSleep >= 15000 && summary.workedSleep === 200 && summary.dailySleep >= 15000,
    JSON.stringify(summary))
}

// === Scenario 8: 阶段 C.1 expression harvest 调度前门收口 ===
function testExpressionHarvestDirectiveCompatibility() {
  const dataDir = createTempDataDir('resource-regress-expression-harvest-')
  const script = String.raw`
const startupSchedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function createCtx() {
  return {
    bots: [{ selfId: 'harvest-bot-1' }],
    logger() {
      return {
        info() {},
        warn() {},
      }
    },
  }
}

async function run() {
  taskStore.ensureTaskDirs()

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '50'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
  const parked = await startupSchedulers.runExpressionHarvestTick(createCtx())
  const afterParked = taskStore.listResourceTasks({ statuses: ['pending', 'claiming', 'running', 'deferred'], limit: 50 })
    .filter(task => String(task.kind || '') === 'expression_harvest')

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  const submitted = await startupSchedulers.runExpressionHarvestTick(createCtx())
  const afterSubmitted = taskStore.listResourceTasks({ statuses: ['pending', 'claiming', 'running', 'deferred'], limit: 50 })
    .filter(task => String(task.kind || '') === 'expression_harvest')

  const firstTask = afterSubmitted[0] || {}
  const summary = {
    parked,
    parkedCount: afterParked.length,
    submitted,
    submittedCount: afterSubmitted.length,
    taskSource: String(firstTask.source || ''),
    taskSelfUserId: String(firstTask.payload && firstTask.payload.selfUserId || ''),
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('C.1 expression harvest directive compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('C.1 expression harvest parks before submission under black memory',
    summary.parked && summary.parked.parked === true && summary.parkedCount === 0,
    JSON.stringify(summary))
  check('C.1 expression harvest still submits under green memory',
    summary.submitted && summary.submitted.parked === false && summary.submittedCount === 1,
    JSON.stringify(summary))
  check('C.1 expression harvest preserves source and selfUserId on submit',
    summary.taskSource === 'expression-harvest-scheduler' && summary.taskSelfUserId === 'harvest-bot-1',
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
  check('C.2 conversation_summary parks before submission under black memory',
    summary.parkedSummary && summary.parkedSummary.accepted === false && summary.parkedSummaryCount === 0,
    JSON.stringify(summary))
  check('C.2 sensitive_cache_analysis parks before submission under black memory',
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
    const expression = await startupSchedulers.runExpressionHarvestTick(createCtx())
    const parkedSummary = background.submitConversationSummaryTask({
      key: 'group-tool-active::user-tool-active',
      source: 'conversation-summary-trigger',
    })
    const parkedSensitive = background.submitSensitiveCacheAnalysisTask({
      channelKey: 'group-sensitive-tool-active',
      source: 'sensitive-cache-trigger',
    })
    const afterExpression = listKindTasks('expression_harvest').length
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
      expression,
      parkedSummary,
      parkedSensitive,
      afterExpression,
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
  check('tool_active should park expression harvest before it materializes new tasks',
    summary.expression && summary.expression.parked === true
      && summary.expression.status === 'parked'
      && summary.afterExpression === 0,
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

// === Scenario 16: 阶段 E.10 no sender 死路径收窄后不再写 waiting_sender 事件 ===
function testNotifierWithoutSenderLeavesTaskUntouched() {
  const dataDir = createTempDataDir('resource-regress-notify-waiting-sender-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function run() {
  taskStore.ensureTaskDirs()
  const taskId = 'agent-task-waiting-sender-1'
  const pendingTask = taskStore.submitResourceTask({
    id: taskId,
    kind: 'agent_task',
    source: 'resource-regression-waiting-sender',
    channelKey: 'group-waiting-sender',
    priority: 60,
    timeoutMs: 120000,
    payload: { entry: 'regression-waiting-sender' },
    notify: { target: 'group-waiting-sender', channelKey: 'group-waiting-sender', status: 'pending' },
  })

  const doneTask = taskStore.completeTask(pendingTask, {
    reply: 'background result ready',
  })
  if (!doneTask) throw new Error('expected task to complete')

  const r1 = await notifier.notifyCompletedTasks({ limit: 100 })
  const eventsAfter1 = readEvents().filter(e => e.event === 'task_notify_waiting_sender' && e.taskId === taskId).length

  await notifier.notifyCompletedTasks({ limit: 100 })
  await notifier.notifyCompletedTasks({ limit: 100 })
  const eventsAfter3 = readEvents().filter(e => e.event === 'task_notify_waiting_sender' && e.taskId === taskId).length

  const finalTask = taskStore.getResourceTaskById(taskId)
  console.log(JSON.stringify({
    scanned1: r1.scanned,
    eventsAfter1,
    eventsAfter3,
    finalStatus: finalTask && finalTask.status || '',
    finalNotifyStatus: finalTask && finalTask.notify && finalTask.notify.status || '',
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.8 notifier dedupes waiting_sender event without sender', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('E.10 no-sender scan no longer writes waiting_sender event in dead production path',
    summary.scanned1 >= 1 && summary.eventsAfter1 === 0 && summary.eventsAfter3 === 0,
    JSON.stringify(summary))
  check('E.10 no-sender path still does not mutate task or notify terminal state',
    summary.finalStatus === 'done' && summary.finalNotifyStatus === 'pending',
    JSON.stringify(summary))
}

// === Scenario 17: 阶段 D.9 failed 通知不应每轮无冷却重试 ===
function testNotifierFailedRetryHasCooldown() {
  const dataDir = createTempDataDir('resource-regress-notify-failed-cooldown-')
  const script = String.raw`
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  taskStore.ensureTaskDirs()
  const taskId = 'agent-task-notify-failed-cooldown-1'
  const pendingTask = taskStore.submitResourceTask({
    id: taskId,
    kind: 'agent_task',
    source: 'resource-regression-notify-failed-cooldown',
    channelKey: 'group-notify-failed-cooldown',
    priority: 60,
    timeoutMs: 120000,
    payload: { entry: 'regression-notify-failed-cooldown' },
    notify: { target: 'group-notify-failed-cooldown', channelKey: 'group-notify-failed-cooldown', status: 'pending' },
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
  const callsAfterFirst = senderCalls

  await notifier.notifyCompletedTasks({ limit: 100, sender })
  await notifier.notifyCompletedTasks({ limit: 100, sender })
  const callsAfterThree = senderCalls
  const taskAfterThree = taskStore.getResourceTaskById(taskId)

  const originalNow = Date.now
  try {
    const failedUpdatedAtMs = Date.parse(String(taskAfterThree && taskAfterThree.notify && taskAfterThree.notify.updatedAt || ''))
    if (Number.isFinite(failedUpdatedAtMs) && failedUpdatedAtMs > 0) {
      Date.now = () => failedUpdatedAtMs + 61 * 1000
    } else {
      Date.now = () => originalNow() + 61 * 1000
    }
    await notifier.notifyCompletedTasks({ limit: 100, sender })
  } finally {
    Date.now = originalNow
  }

  const callsAfterCooldown = senderCalls
  const taskAfterCooldown = taskStore.getResourceTaskById(taskId)
  console.log(JSON.stringify({
    firstScanned: first.scanned,
    firstFailed: first.failed,
    callsAfterFirst,
    callsAfterThree,
    callsAfterCooldown,
    notifyStatusAfterFirst: taskAfterFirst && taskAfterFirst.notify && taskAfterFirst.notify.status || '',
    notifyStatusAfterThree: taskAfterThree && taskAfterThree.notify && taskAfterThree.notify.status || '',
    notifyStatusAfterCooldown: taskAfterCooldown && taskAfterCooldown.notify && taskAfterCooldown.notify.status || '',
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.9 notifier failed retry honors cooldown window', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.9 first failed notify attempt still runs once and marks notify failed',
    summary.firstScanned >= 1 && summary.firstFailed === 1 && summary.callsAfterFirst === 1 && summary.notifyStatusAfterFirst === 'failed',
    JSON.stringify(summary))
  check('D.9 repeated failed notify scans inside cooldown do not call sender every tick',
    summary.callsAfterThree === 1 && summary.notifyStatusAfterThree === 'failed',
    JSON.stringify(summary))
  check('D.9 failed notify becomes retryable again after cooldown elapses',
    summary.callsAfterCooldown === 2 && summary.notifyStatusAfterCooldown === 'failed',
    JSON.stringify(summary))
}

// === Scenario 17.1: 私聊结果通知不能误走群发 API ===
function testNotifierPrivateTargetUsesPrivateSend() {
  const dataDir = createTempDataDir('resource-regress-notify-private-target-')
  const script = String.raw`
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  const groupCalls = []
  const privateCalls = []
  const bot = {
    internal: {
      async sendGroupMsg(target, message) {
        groupCalls.push({ target: String(target || ''), message })
      },
      async sendPrivateMsg(target, message) {
        privateCalls.push({ target: String(target || ''), message })
      },
    },
  }

  const sender = notifier.createAgentTaskSender({ bot })

  const privateTask = {
    id: 'private-agent-notify-1',
    kind: 'agent_task',
    status: 'done',
    channelKey: 'private:3514272382',
    notify: {
      target: 'qq-group',
      channelKey: 'private:3514272382',
      status: 'pending',
    },
    payload: { entry: 'qq-auto-route' },
  }
  const groupTask = {
    id: 'group-agent-notify-1',
    kind: 'agent_task',
    status: 'done',
    channelKey: '587702552',
    notify: {
      target: 'qq-group',
      channelKey: '587702552',
      status: 'pending',
    },
    payload: { entry: 'qq-auto-route' },
  }

  await sender(privateTask, { reply: 'private notify text' })
  await sender(groupTask, { reply: 'group notify text' })

  console.log(JSON.stringify({
    privateCalls,
    groupCalls,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('notifier private target should prefer private send api', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('notifier private target uses private send instead of group send',
    Array.isArray(summary.privateCalls)
      && summary.privateCalls.length === 1
      && String(summary.privateCalls[0] && summary.privateCalls[0].target || '') === '3514272382'
      && Array.isArray(summary.groupCalls)
      && summary.groupCalls.length === 1
      && String(summary.groupCalls[0] && summary.groupCalls[0].target || '') === '587702552',
      JSON.stringify(summary))
}

// === Scenario 17.2: 成功搜索结果不能被单条 short body 误判成失败兜底 ===
function testNotifierDoesNotOverrideUsableSearchSuccess() {
  const dataDir = createTempDataDir('resource-regress-notify-usable-success-')
  const script = String.raw`
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  const privateCalls = []
  const bot = {
    internal: {
      async sendPrivateMsg(target, message) {
        privateCalls.push({ target: String(target || ''), message })
      },
    },
  }

  const sender = notifier.createAgentTaskSender({ bot })
  const task = {
    id: 'private-agent-usable-success-1',
    kind: 'agent_task',
    status: 'done',
    channelKey: 'private:3514272382',
    notify: {
      target: 'qq-group',
      channelKey: 'private:3514272382',
      status: 'pending',
    },
    payload: { entry: 'qq-auto-route' },
  }
  const result = {
    reply: '根据已经读到的可靠网页正文，鸣潮最新角色目前是官方刚公布的新角色。',
    toolResults: [
      {
        name: 'web_search',
        result: [
          '已搜索：鸣潮 最新角色',
          '搜索状态：usable_hit',
          '【来源 1】标题：官方公告',
          '正文质量：usable',
          '正文：官方公告已明确写出最新角色信息。',
        ].join('\n'),
      },
      {
        name: 'web_fetch',
        result: '正文质量：short（正文过短，不能作为事实依据）\n正文：活动页',
      },
    ],
  }

  const builtText = notifier.buildAgentTaskTextMessage(result, task)
  await sender(task, result)

  console.log(JSON.stringify({
    builtText,
    privateCalls,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('notifier usable search success should survive short body noise', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('notifier keeps success reply text when usable_hit already exists',
    String(summary.builtText || '').includes('可靠网页正文')
      && !String(summary.builtText || '').includes('这次搜索没有拿到可靠结果'),
    JSON.stringify(summary))
  check('notifier sends usable success reply to private target instead of failure fallback',
    Array.isArray(summary.privateCalls)
      && summary.privateCalls.length === 1
      && JSON.stringify(summary.privateCalls[0] && summary.privateCalls[0].message || []).includes('可靠网页正文')
      && !JSON.stringify(summary.privateCalls[0] && summary.privateCalls[0].message || []).includes('这次搜索没有拿到可靠结果'),
    JSON.stringify(summary))
}

// === Scenario 17.3: 空 Agent 回复不能再被当作可发送正文通知用户 ===
function testNotifierSkipsPlaceholderEmptyAgentReply() {
  const dataDir = createTempDataDir('resource-regress-notify-empty-agent-reply-')
  const script = String.raw`
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')

async function run() {
  const privateCalls = []
  const bot = {
    internal: {
      async sendPrivateMsg(target, message) {
        privateCalls.push({ target: String(target || ''), message })
      },
    },
  }

  const sender = notifier.createAgentTaskSender({ bot })
  const task = {
    id: 'private-agent-empty-reply-1',
    kind: 'agent_task',
    status: 'done',
    channelKey: 'private:3514272382',
    notify: {
      target: 'qq-group',
      channelKey: 'private:3514272382',
      status: 'pending',
    },
    payload: { entry: 'qq-auto-route' },
  }
  const result = {
    reply: '(Agent 未获取到有效回复)',
    toolResults: [
      {
        name: 'web_search',
        result: '已搜索：鸣潮 最新角色\n搜索状态：usable_hit\n正文质量：usable\n正文：官方正文已经读到了。',
      },
    ],
  }

  const builtText = notifier.buildAgentTaskTextMessage(result, task)
  await sender(task, result)

  console.log(JSON.stringify({
    builtText,
    sendable: notifier.hasAgentSendableText(result),
    privateCalls,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('notifier should skip placeholder empty agent reply', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('notifier treats placeholder empty agent reply as not sendable',
    summary.sendable === false && Array.isArray(summary.privateCalls) && summary.privateCalls.length === 0,
    JSON.stringify(summary))
  check('notifier does not keep placeholder empty agent reply text',
    !String(summary.builtText || '').includes('Agent 未获取到有效回复'),
    JSON.stringify(summary))
}

// === Scenario 18: 阶段 D.10 task-store 迁移失败不得继续制造双副本 ===
function testTaskStoreDoesNotCreateTargetCopyWhenRenameFails() {
  const dataDir = createTempDataDir('resource-regress-task-store-rename-fail-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.endsWith('../resource-common/files')) {
    return {
      ...loaded,
      renameFileAtomic(src, dst) {
        if (/task-store-rename-fail/.test(String(src || '')) || /task-store-rename-fail/.test(String(dst || ''))) {
          return false
        }
        return loaded.renameFileAtomic(src, dst)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function run() {
  taskStore.ensureTaskDirs()

  const pendingTask = taskStore.submitResourceTask({
    id: 'task-store-rename-fail-complete',
    kind: 'agent_task',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store',
    priority: 50,
    timeoutMs: 120000,
    payload: { entry: 'rename-fail-complete' },
    notify: { target: 'none', status: 'pending' },
  })
  taskStore.completeTask(pendingTask, { reply: 'should not materialize done copy on rename fail' })

  const failedTask = taskStore.submitResourceTask({
    id: 'task-store-rename-fail-requeue',
    kind: 'daily_summary',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store',
    priority: 50,
    timeoutMs: 120000,
    payload: { slotId: 'rename-fail-requeue' },
    notify: { target: 'none', status: 'pending' },
  })
  const failedPendingFile = taskPaths.getTaskFile('pending', failedTask.kind, failedTask.id)
  const failedFile = taskPaths.getTaskFile('failed', failedTask.kind, failedTask.id)
  fs.unlinkSync(failedPendingFile)
  fs.writeFileSync(failedFile, JSON.stringify({
    ...failedTask,
    status: 'failed',
    step: 'failed',
    error: 'forced fail before requeue',
  }))
  const failedSnapshot = taskStore.getResourceTaskById(failedTask.id)
  taskStore.requeueTask(failedSnapshot, 'forced rename fail requeue')

  const pendingCompleteFile = taskPaths.getTaskFile('pending', pendingTask.kind, pendingTask.id)
  const doneCompleteFile = taskPaths.getTaskFile('done', pendingTask.kind, pendingTask.id)
  const failedRequeueFile = taskPaths.getTaskFile('failed', failedTask.kind, failedTask.id)
  const pendingRequeueFile = taskPaths.getTaskFile('pending', failedTask.kind, failedTask.id)

  console.log(JSON.stringify({
    completePendingExists: fs.existsSync(pendingCompleteFile),
    completeDoneExists: fs.existsSync(doneCompleteFile),
    requeueFailedExists: fs.existsSync(failedRequeueFile),
    requeuePendingExists: fs.existsSync(pendingRequeueFile),
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.10 task-store rename failure does not materialize second status copy', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.10 completeTask keeps source copy and does not create done copy when rename fails',
    summary.completePendingExists === true && summary.completeDoneExists === false,
    JSON.stringify(summary))
  check('D.10 requeueTask keeps failed copy and does not create pending copy when rename fails',
    summary.requeueFailedExists === true && summary.requeuePendingExists === false,
    JSON.stringify(summary))
}

// === Scenario 19: 阶段 D.11 markTaskRunning 迁移失败不得继续制造双副本 ===
function testMarkTaskRunningDoesNotCreateRunningCopyWhenRenameFails() {
  const dataDir = createTempDataDir('resource-regress-task-running-rename-fail-')
  const script = String.raw`
const fs = require('fs')
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.endsWith('../resource-common/files')) {
    return {
      ...loaded,
      renameFileAtomic(src, dst) {
        const srcText = String(src || '')
        const dstText = String(dst || '')
        if (/task-store-running-rename-fail/.test(srcText) && /[\\\\/]running[\\\\/]/.test(dstText)) {
          return false
        }
        return loaded.renameFileAtomic(src, dst)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function run() {
  taskStore.ensureTaskDirs()
  const pendingTask = taskStore.submitResourceTask({
    id: 'task-store-running-rename-fail-1',
    kind: 'agent_task',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store-running',
    priority: 50,
    timeoutMs: 120000,
    payload: { entry: 'rename-fail-running' },
    notify: { target: 'none', status: 'pending' },
  })

  const claimingTask = taskStore.claimTaskById(pendingTask.id, 'worker-running-rename-fail')
  if (!claimingTask) throw new Error('expected task to enter claiming before markTaskRunning regression')

  const markResult = taskStore.markTaskRunning(claimingTask, 'worker-running-rename-fail', 'starting')
  const claimingFile = taskPaths.getTaskFile('claiming', claimingTask.kind, claimingTask.id)
  const runningFile = taskPaths.getTaskFile('running', claimingTask.kind, claimingTask.id)

  console.log(JSON.stringify({
    claimingExists: fs.existsSync(claimingFile),
    runningExists: fs.existsSync(runningFile),
    returnedStatus: markResult && markResult.status || '',
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.11 markTaskRunning rename failure does not materialize running copy', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.11 markTaskRunning keeps claiming copy and does not create running copy when rename fails',
    summary.claimingExists === true && summary.runningExists === false && summary.returnedStatus === 'claiming',
    JSON.stringify(summary))
}

// === Scenario 20: 阶段 D.12 cancelTask 迁移失败不得继续制造双副本 ===
function testCancelTaskDoesNotCreateCancelledCopyWhenRenameFails() {
  const dataDir = createTempDataDir('resource-regress-task-cancel-rename-fail-')
  const script = String.raw`
const fs = require('fs')
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.endsWith('../resource-common/files')) {
    return {
      ...loaded,
      renameFileAtomic(src, dst) {
        const srcText = String(src || '')
        const dstText = String(dst || '')
        if (/task-store-cancel-rename-fail/.test(srcText) && /[\\\\/]cancelled[\\\\/]/.test(dstText)) {
          return false
        }
        return loaded.renameFileAtomic(src, dst)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function run() {
  taskStore.ensureTaskDirs()

  const pendingTask = taskStore.submitResourceTask({
    id: 'task-store-cancel-rename-fail-pending',
    kind: 'agent_task',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store-cancel',
    priority: 50,
    timeoutMs: 120000,
    payload: { entry: 'rename-fail-cancel-pending' },
    notify: { target: 'none', status: 'pending' },
  })
  const pendingCancelResult = taskStore.cancelTask(pendingTask.id, 'worker-cancel-rename-fail', 'forced pending cancel rename fail')

  const deferredSeed = taskStore.submitResourceTask({
    id: 'task-store-cancel-rename-fail-deferred',
    kind: 'daily_summary',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store-cancel',
    priority: 50,
    timeoutMs: 120000,
    payload: { slotId: 'rename-fail-cancel-deferred' },
    notify: { target: 'none', status: 'pending' },
  })
  const deferredTask = taskStore.deferTask(deferredSeed, 'prepare deferred cancel regression')
  const deferredCancelResult = taskStore.cancelTask(deferredTask.id, 'worker-cancel-rename-fail', 'forced deferred cancel rename fail')

  const pendingFile = taskPaths.getTaskFile('pending', pendingTask.kind, pendingTask.id)
  const pendingCancelledFile = taskPaths.getTaskFile('cancelled', pendingTask.kind, pendingTask.id)
  const deferredFile = taskPaths.getTaskFile('deferred', deferredTask.kind, deferredTask.id)
  const deferredCancelledFile = taskPaths.getTaskFile('cancelled', deferredTask.kind, deferredTask.id)
  const events = readEvents().filter(event => event.event === 'task_cancelled')

  console.log(JSON.stringify({
    pendingCancelResult,
    pendingExists: fs.existsSync(pendingFile),
    pendingCancelledExists: fs.existsSync(pendingCancelledFile),
    deferredCancelResult,
    deferredExists: fs.existsSync(deferredFile),
    deferredCancelledExists: fs.existsSync(deferredCancelledFile),
    cancelledEventCount: events.filter(event => /task-store-cancel-rename-fail/.test(String(event.taskId || ''))).length,
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.12 cancelTask rename failure does not materialize cancelled copy', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.12 cancelTask keeps pending copy and returns false when pending -> cancelled rename fails',
    summary.pendingCancelResult === false && summary.pendingExists === true && summary.pendingCancelledExists === false,
    JSON.stringify(summary))
  check('D.12 cancelTask keeps deferred copy and returns false when deferred -> cancelled rename fails',
    summary.deferredCancelResult === false && summary.deferredExists === true && summary.deferredCancelledExists === false,
    JSON.stringify(summary))
  check('D.12 cancelTask does not emit task_cancelled event on rename failure',
    summary.cancelledEventCount === 0,
    JSON.stringify(summary))
}

// === Scenario 21: 阶段 D.13 claim 入口不得重新领走 stale pending 副本 ===
function testClaimDoesNotReclaimStalePendingWhenHigherRankCopyExists() {
  const dataDir = createTempDataDir('resource-regress-task-claim-stale-pending-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function writeTask(status, task) {
  const file = taskPaths.getTaskFile(status, task.kind, task.id)
  fs.mkdirSync(require('path').dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...task, status }), 'utf8')
}

function run() {
  taskStore.ensureTaskDirs()
  const base = {
    id: 'task-store-claim-stale-pending-1',
    kind: 'daily_summary',
    source: 'resource-regression-task-store',
    channelKey: 'group-task-store-claim',
    userId: 'tester',
    priority: 50,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    expiresAt: '',
    timeoutMs: 120000,
    payload: { slotId: 'claim-stale-pending' },
    notify: { target: 'none', status: 'pending' },
  }

  writeTask('pending', base)
  writeTask('failed', {
    ...base,
    updatedAt: '2026-06-11T00:01:00.000Z',
    error: 'canonical failed copy',
    retryAfter: '2099-01-01T00:00:00.000Z',
  })

  const claimNextResult = taskStore.claimNextTask(base.kind, 'worker-claim-stale-pending')
  const claimByIdResult = taskStore.claimTaskById(base.id, 'worker-claim-stale-pending-inline')
  const pendingFile = taskPaths.getTaskFile('pending', base.kind, base.id)
  const claimingFile = taskPaths.getTaskFile('claiming', base.kind, base.id)
  const failedFile = taskPaths.getTaskFile('failed', base.kind, base.id)
  const claimEvents = readEvents().filter(event => event.event === 'task_claimed' && event.taskId === base.id)

  console.log(JSON.stringify({
    claimNextResultId: claimNextResult && claimNextResult.id || '',
    claimByIdResultId: claimByIdResult && claimByIdResult.id || '',
    pendingExists: fs.existsSync(pendingFile),
    claimingExists: fs.existsSync(claimingFile),
    failedExists: fs.existsSync(failedFile),
    claimEventCount: claimEvents.length,
  }, null, 2))
  process.exitCode = 0
}

run()
`
  const summary = runScenario('D.13 claim path does not reclaim stale pending when higher-rank copy exists', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.13 claimNextTask does not claim stale pending when failed copy already exists',
    summary.claimNextResultId === '' && summary.claimingExists === false,
    JSON.stringify(summary))
  check('D.13 claimTaskById does not claim stale pending when failed copy already exists',
    summary.claimByIdResultId === '' && summary.claimingExists === false,
    JSON.stringify(summary))
  check('D.13 stale pending remains unclaimed and canonical failed copy stays intact',
    summary.pendingExists === true && summary.failedExists === true && summary.claimEventCount === 0,
    JSON.stringify(summary))
}

// === Scenario 22: 阶段 D.14 未进入 running 时不得继续真实执行 ===
function testExecutionDoesNotContinueWhenTaskNeverEntersRunning() {
  const dataDir = createTempDataDir('resource-regress-task-running-guard-')
  const script = String.raw`
const Module = require('module')

const originalLoad = Module._load
const runCounts = { daily: 0, agent: 0, inline: 0 }
const gateOwners = []

Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)

  if (normalized === './task-store' || normalized.endsWith('/resource-workers/task-store') || normalized.endsWith('../resource-workers/task-store')) {
    return {
      ...loaded,
      markTaskRunning(task, workerName, step) {
        const taskId = String(task && task.id || '')
        const source = String(task && task.source || '')
        if (
          taskId === 'task-running-guard-daily-1'
          || taskId === 'task-running-guard-agent-1'
          || source === 'resource-regression-inline-running-guard'
        ) return task
        return loaded.markTaskRunning(task, workerName, step)
      },
    }
  }

  if (normalized.endsWith('/daily-precompute/daily-slot-worker') || normalized.endsWith('../daily-precompute/daily-slot-worker')) {
    return {
      ...loaded,
      async runDailySlotTask(task) {
        runCounts.daily += 1
        return { mode: 'daily-slot-worker', taskId: task && task.id }
      },
    }
  }

  if (normalized.endsWith('/resource-workers/agent-worker') || normalized.endsWith('./agent-worker')) {
    return {
      ...loaded,
      async runAgentWorkerTask(task) {
        runCounts.agent += 1
        return { mode: 'agent-worker', taskId: task && task.id }
      },
    }
  }

  if (normalized.endsWith('/resource-gate/gate') || normalized.endsWith('../resource-gate/gate')) {
    return {
      ...loaded,
      async acquireResourceGate(options) {
        gateOwners.push(String(options && options.owner || ''))
        return {
          updateStep() {},
          release() {},
        }
      },
    }
  }

  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const resourceExecution = require('koishi-plugin-dongxuelian-ai/lib/agent/resource-execution')

async function run() {
  taskStore.ensureTaskDirs()

  taskStore.submitResourceTask({
    id: 'task-running-guard-daily-1',
    kind: 'daily_summary',
    source: 'resource-regression-worker-running-guard',
    channelKey: 'group-running-guard',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: { slotId: 'running-guard-daily' },
    notify: { target: 'none', status: 'pending' },
  })
  const dailyWorked = await workerMain.runOneQueuedTask({ type: 'daily', workerName: 'running-guard-daily-worker' })
  const dailyTask = taskStore.getResourceTaskById('task-running-guard-daily-1')

  taskStore.submitResourceTask({
    id: 'task-running-guard-agent-1',
    kind: 'agent_task',
    source: 'resource-regression-worker-running-guard',
    channelKey: 'group-running-guard',
    userId: 'tester',
    priority: 40,
    timeoutMs: 120000,
    payload: { entry: 'running-guard-agent' },
    notify: { target: 'none', status: 'pending' },
  })
  const agentWorked = await workerMain.runOneQueuedTask({ type: 'agent', workerName: 'running-guard-agent-worker', gateWaitMs: 1000 })
  const agentTask = taskStore.getResourceTaskById('task-running-guard-agent-1')

  let inlineError = ''
  try {
    await resourceExecution.runAgentWithResourceGate({
      channel: 'qq',
      channelKey: 'inline-running-guard-group',
      userId: 'tester-inline',
      source: 'resource-regression-inline-running-guard',
      taskKind: 'agent_task',
      run: async () => {
        runCounts.inline += 1
        return 'inline-ok'
      },
    })
  } catch (error) {
    inlineError = error instanceof Error ? error.message : String(error || '')
  }
  const inlineTasks = taskStore.listResourceTasks({
    statuses: ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred'],
    limit: 50,
  }).filter(task => String(task && task.source || '') === 'resource-regression-inline-running-guard')

  console.log(JSON.stringify({
    dailyWorked,
    dailyRunCount: runCounts.daily,
    dailyStatus: dailyTask && dailyTask.status || '',
    agentWorked,
    agentRunCount: runCounts.agent,
    agentStatus: agentTask && agentTask.status || '',
    inlineRunCount: runCounts.inline,
    inlineError,
    inlineTaskStatuses: inlineTasks.map(task => String(task && task.status || '')).sort(),
    gateOwners,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.14 execution chain stops when markTaskRunning never reaches running', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.14 non-exclusive worker path does not execute real task when still not running',
    summary.dailyRunCount === 0,
    JSON.stringify(summary))
  check('D.14 exclusive worker path does not acquire gate or execute real task when still not running',
    summary.agentRunCount === 0 && !summary.gateOwners.includes('running-guard-agent-worker'),
    JSON.stringify(summary))
  check('D.14 inline path does not acquire gate or execute options.run when still not running',
    summary.inlineRunCount === 0 && !summary.gateOwners.includes('agent-inline-worker') && summary.inlineError,
    JSON.stringify(summary))
  check('D.15 non-exclusive worker path does not leave isolated claiming residue after failed running transition',
    summary.dailyStatus === 'failed',
    JSON.stringify(summary))
  check('D.15 exclusive worker path does not leave isolated claiming residue after failed running transition',
    summary.agentStatus === 'failed',
    JSON.stringify(summary))
  check('D.15 inline path does not leave isolated claiming residue after failed running transition',
    summary.inlineRunCount === 0
      && JSON.stringify(summary.inlineTaskStatuses) === JSON.stringify(['failed']),
    JSON.stringify(summary))
}

function buildSupervisorZombieScenarioScript(config) {
  return String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')
const config = ${JSON.stringify(config)}
const originalLoad = Module._load
const terminateCalls = []
const spawnCalls = []

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'child_process') {
    const loaded = originalLoad.apply(this, arguments)
    return {
      ...loaded,
      spawn(command, args, options = {}) {
        spawnCalls.push({
          command: String(command || ''),
          args: Array.isArray(args) ? args.map(item => String(item || '')) : [],
          cwd: String(options.cwd || ''),
        })
        return {
          pid: 54321,
          unref() {},
        }
      },
    }
  }

  const loaded = originalLoad.apply(this, arguments)
  const normalized = String(request || '').replace(/\\\\/g, '/')
  if (normalized === '../resource-system/system-protection' || normalized.endsWith('/resource-system/system-protection')) {
    return {
      ...loaded,
      terminateProcessTree(pid, options = {}) {
        const numericPid = Number(pid)
        terminateCalls.push({
          pid: numericPid,
          reason: String(options.reason || ''),
          source: String(options.source || ''),
          owner: String(options.owner || ''),
        })
        loaded.writeProcessCleanupEvent({
          event: 'worker_process_zombie_recovered',
          workerName: String(options.owner || config.workerName || ''),
          pid: numericPid,
          source: String(options.source || ''),
          reason: String(options.reason || ''),
        })
        return {
          event: 'process_tree_terminated',
          rootPid: numericPid,
          killedPids: [numericPid],
          failedPids: [],
        }
      },
    }
  }
  return loaded
}

try {
  const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
  const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

  taskStore.ensureTaskDirs()

  if (config.backlogKind) {
    taskStore.submitResourceTask({
      id: String(config.backlogTaskId || (config.workerName + '-backlog-1')),
      kind: String(config.backlogKind),
      source: 'resource-regression-zombie-backlog',
      channelKey: 'group-zombie-backlog',
      userId: 'tester',
      priority: 40,
      timeoutMs: 120000,
      payload: { entry: 'zombie-backlog' },
      notify: { target: 'none', status: 'pending' },
    })
  }

  if (config.currentTaskId) {
    const runningSeed = taskStore.submitResourceTask({
      id: String(config.currentTaskId),
      kind: String(config.currentTaskKind || config.backlogKind || 'daily_report'),
      source: 'resource-regression-zombie-running',
      channelKey: 'group-zombie-running',
      userId: 'tester',
      priority: 35,
      timeoutMs: Number(config.currentTaskTimeoutMs || 480000),
      payload: { entry: 'zombie-running' },
      notify: { target: 'none', status: 'pending' },
    })
    const claiming = taskStore.claimTaskById(runningSeed.id, String(config.workerName || 'resource-worker'))
    if (!claiming) throw new Error('expected running task claim before zombie fixture')
    const running = taskStore.markTaskRunning(claiming, String(config.workerName || 'resource-worker'), 'running')
    if (!running || running.status !== 'running') throw new Error('expected running task before zombie fixture')
    const runningFile = taskPaths.getTaskFile('running', running.kind, running.id)
    const runningOnDisk = JSON.parse(fs.readFileSync(runningFile, 'utf8'))
    if (config.currentTaskStartedAt) runningOnDisk.startedAt = String(config.currentTaskStartedAt)
    fs.writeFileSync(runningFile, JSON.stringify(runningOnDisk, null, 2), 'utf8')
  }

  const workerStateFile = taskPaths.getWorkerStateFile(String(config.workerName || 'resource-worker'))
  fs.mkdirSync(path.dirname(workerStateFile), { recursive: true })
  const workerState = {
    name: String(config.workerName || 'resource-worker'),
    pid: config.useCurrentPid ? process.pid : Number(config.pid || 0),
    startedAt: String(config.startedAt || '2026-06-01T00:00:00.000Z'),
    heartbeatAt: String(config.heartbeatAt || new Date().toISOString()),
    alive: true,
    step: String(config.step || 'tick'),
    loopIterations: Number(config.loopIterations || 7),
    lastClaimAttemptAt: String(config.lastClaimAttemptAt || ''),
    lastTaskFinishedAt: String(config.lastTaskFinishedAt || ''),
    currentTaskId: String(config.currentTaskId || ''),
    currentTaskStartedAt: String(config.currentTaskStartedAt || ''),
    parked: !!config.parked,
    parkSleepMs: Number(config.parkSleepMs || 0),
  }
  fs.writeFileSync(workerStateFile, JSON.stringify({
    ...workerState,
  }, null, 2), 'utf8')

  if (config.previousSupervisorState) {
    const supervisorStateFile = path.join(taskPaths.SUPERVISOR_DIR, 'state.json')
    fs.mkdirSync(path.dirname(supervisorStateFile), { recursive: true })
    fs.writeFileSync(supervisorStateFile, JSON.stringify({
      updatedAt: String(config.previousSupervisorState.updatedAt || new Date().toISOString()),
      pid: process.pid,
      workers: [{
        ...workerState,
        ...(config.previousSupervisorState.worker || {}),
      }],
    }, null, 2), 'utf8')
  }

  const started = config.useRunSupervisorOnce
    ? [supervisor.runSupervisorOnce({ start: true, once: true })]
    : supervisor.ensureWorkerProcesses([String(config.type || 'agent')])
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const cleanupEvents = Array.isArray(systemProtection.getSystemProtectionStatus().cleanupEvents)
    ? systemProtection.getSystemProtectionStatus().cleanupEvents
    : []

  console.log(JSON.stringify({
    startedCount: Array.isArray(started) ? started.length : 0,
    terminateCallCount: terminateCalls.length,
    terminatedPid: terminateCalls.length ? terminateCalls[0].pid : 0,
    spawnCallCount: spawnCalls.length,
    zombieRecoveryWorkerEventCount: workerEvents.filter(event => event.event === 'worker_process_zombie_recovered' && event.workerName === config.workerName).length,
    zombieRecoveryCleanupEventCount: cleanupEvents.filter(event => event.event === 'worker_process_zombie_recovered' && event.workerName === config.workerName).length,
    suspectedBlockedEventCount: workerEvents.filter(event => event.event === 'worker_process_suspected_blocked' && event.workerName === config.workerName).length,
    pendingCount: taskStore.countResourceTasks({ kind: String(config.backlogKind || ''), statuses: ['pending'], limit: 20000 }),
  }, null, 2))
  process.exitCode = 0
} finally {
  Module._load = originalLoad
}
`
}

function testSupervisorReplacesLivePidZombieWithStagnantLoop() {
  const dataDir = createTempDataDir('resource-regress-zombie-live-pid-')
  const summary = runScenario('zombie worker live pid should be recovered when loop progress stalls', buildSupervisorZombieScenarioScript({
    type: 'agent',
    workerName: 'agent-worker',
    backlogKind: 'agent_task',
    useCurrentPid: true,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    lastClaimAttemptAt: '2026-06-01T00:00:00.000Z',
    loopIterations: 7,
    parked: false,
  }), {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_ZOMBIE_STAGNATION_MS: '60000',
  }, 30000)
  if (!summary) return
  check('zombie worker live pid should be terminated when heartbeat is fresh but claim progress is stale',
    summary.terminateCallCount >= 1
      && summary.terminatedPid > 0
      && (summary.zombieRecoveryWorkerEventCount + summary.zombieRecoveryCleanupEventCount) >= 1,
    JSON.stringify(summary))
}

function testSupervisorReplacesLivePidZombieWhenOnlyLoopStallsAcrossFreshSupervisorWrites() {
  const dataDir = createTempDataDir('resource-regress-zombie-loop-only-')
  const summary = runScenario('zombie worker should be recovered when only loop sample is stale', buildSupervisorZombieScenarioScript({
    type: 'agent',
    workerName: 'agent-worker',
    backlogKind: 'agent_task',
    useCurrentPid: true,
    useRunSupervisorOnce: true,
    heartbeatAt: new Date().toISOString(),
    lastClaimAttemptAt: new Date().toISOString(),
    loopIterations: 7,
    parked: false,
    previousSupervisorState: {
      updatedAt: new Date().toISOString(),
      worker: {
        loopIterations: 7,
        loopChangedAt: '2026-06-01T00:00:00.000Z',
      },
    },
  }), {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_ZOMBIE_STAGNATION_MS: '60000',
  }, 30000)
  if (!summary) return
  check('zombie worker live pid should be terminated when heartbeat and claim are fresh but loop progress sample is stale',
    summary.terminateCallCount >= 1
      && summary.terminatedPid > 0
      && (summary.zombieRecoveryWorkerEventCount + summary.zombieRecoveryCleanupEventCount) >= 1,
    JSON.stringify(summary))
}

function testSupervisorDoesNotKillParkedWorker() {
  const dataDir = createTempDataDir('resource-regress-zombie-parked-')
  const summary = runScenario('parked worker should not be treated as zombie', buildSupervisorZombieScenarioScript({
    type: 'agent',
    workerName: 'agent-worker',
    backlogKind: 'agent_task',
    useCurrentPid: true,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    lastClaimAttemptAt: '2026-06-01T00:00:00.000Z',
    loopIterations: 7,
    parked: true,
    parkSleepMs: 15000,
    step: 'parked',
  }), {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_ZOMBIE_STAGNATION_MS: '60000',
  }, 30000)
  if (!summary) return
  check('parked worker should not be terminated even when backlog exists and claim attempt timestamp is old',
    summary.terminateCallCount === 0
      && summary.zombieRecoveryWorkerEventCount === 0
      && summary.zombieRecoveryCleanupEventCount === 0,
    JSON.stringify(summary))
}

function testSupervisorDoesNotKillWorkerRunningLongTask() {
  const dataDir = createTempDataDir('resource-regress-zombie-long-task-')
  const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const summary = runScenario('worker with in-flight long task should not be treated as zombie', buildSupervisorZombieScenarioScript({
    type: 'daily',
    workerName: 'daily-worker',
    backlogKind: 'daily_report',
    useCurrentPid: true,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    lastClaimAttemptAt: '2026-06-01T00:00:00.000Z',
    loopIterations: 11,
    parked: false,
    currentTaskId: 'task-zombie-long-running-1',
    currentTaskKind: 'daily_report',
    currentTaskTimeoutMs: 480000,
    currentTaskStartedAt: startedAt,
    step: 'running',
  }), {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_ZOMBIE_STAGNATION_MS: '60000',
  }, 30000)
  if (!summary) return
  check('worker with active long task should not be terminated just because claim progress timestamp is old',
    summary.terminateCallCount === 0
      && summary.zombieRecoveryWorkerEventCount === 0
      && summary.zombieRecoveryCleanupEventCount === 0,
    JSON.stringify(summary))
}

function testSupervisorDoesNotKillIdleWorkerWithoutBacklog() {
  const dataDir = createTempDataDir('resource-regress-zombie-no-backlog-')
  const summary = runScenario('idle worker without backlog should not be treated as zombie', buildSupervisorZombieScenarioScript({
    type: 'agent',
    workerName: 'agent-worker',
    backlogKind: '',
    useCurrentPid: true,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    lastClaimAttemptAt: '2026-06-01T00:00:00.000Z',
    loopIterations: 9,
    parked: false,
  }), {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_ZOMBIE_STAGNATION_MS: '60000',
  }, 30000)
  if (!summary) return
  check('idle worker without pending backlog should not be terminated as zombie',
    summary.pendingCount === 0
      && summary.terminateCallCount === 0
      && summary.zombieRecoveryWorkerEventCount === 0
      && summary.zombieRecoveryCleanupEventCount === 0,
    JSON.stringify(summary))
}

function testWorkerSelfExitsOnConsecutiveClaimFailures() {
  const dataDir = createTempDataDir('resource-regress-zombie-claim-failures-')
  const script = String.raw`
const fs = require('fs')
const taskStorePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const workerMainPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const originalTaskStore = require(taskStorePath)
const originalTaskStoreCache = require.cache[taskStorePath]

require.cache[taskStorePath] = {
  id: taskStorePath,
  filename: taskStorePath,
  loaded: true,
  exports: {
    ...originalTaskStore,
    claimNextTask() {
      throw new Error('resource regression forced claim failure')
    },
  },
}
delete require.cache[workerMainPath]

async function run() {
  const workerMain = require(workerMainPath)
  let loopResolved = false
  let loopError = ''
  try {
    await workerMain.runWorkerLoop({
      type: 'agent',
      workerName: 'claim-failure-zombie-worker',
      pollMs: 1,
      gateWaitMs: 1000,
    })
    loopResolved = true
  } catch (error) {
    loopError = error instanceof Error ? error.message : String(error || '')
  }
  console.log(JSON.stringify({
    loopResolved,
    loopError,
    exitCode: Number(process.exitCode || 0),
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  if (originalTaskStoreCache) require.cache[taskStorePath] = originalTaskStoreCache
  else delete require.cache[taskStorePath]
  delete require.cache[workerMainPath]
})
`
  const summary = runScenario('worker loop should self-exit after consecutive claim failures', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_MAX_CONSECUTIVE_FAILURES: '2',
  }, 30000)
  if (!summary) return
  check('worker loop should stop with exitCode 77 instead of rejecting on first claim failure',
    summary.loopResolved === true
      && summary.loopError === ''
      && summary.exitCode === 77,
    JSON.stringify(summary))
}

function testWorkerSelfExitThresholdFallsBackWhenConfiguredInvalid() {
  const dataDir = createTempDataDir('resource-regress-zombie-invalid-failure-threshold-')
  const script = String.raw`
const fs = require('fs')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const taskStorePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const workerMainPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const originalTaskStore = require(taskStorePath)
const originalTaskStoreCache = require.cache[taskStorePath]

require.cache[taskStorePath] = {
  id: taskStorePath,
  filename: taskStorePath,
  loaded: true,
  exports: {
    ...originalTaskStore,
    claimNextTask() {
      throw new Error('resource regression forced invalid threshold claim failure')
    },
  },
}
delete require.cache[workerMainPath]

async function run() {
  const workerMain = require(workerMainPath)
  const watchdog = setTimeout(() => {
    const workerEventsFile = taskPaths.getWorkerEventFile()
    const failedTickEvents = fs.existsSync(workerEventsFile)
      ? fs.readFileSync(workerEventsFile, 'utf8').split(/\r?\n/).filter(line => line.includes('worker_tick_failed')).length
      : 0
    console.log(JSON.stringify({
      loopResolved: false,
      loopError: 'watchdog_timeout',
      exitCode: Number(process.exitCode || 0),
      failedTickEvents,
    }, null, 2))
    process.exit(0)
  }, 6000)
  let loopResolved = false
  let loopError = ''
  try {
    await workerMain.runWorkerLoop({
      type: 'agent',
      workerName: 'invalid-threshold-zombie-worker',
      pollMs: 1,
      gateWaitMs: 1000,
    })
    loopResolved = true
  } catch (error) {
    loopError = error instanceof Error ? error.message : String(error || '')
  } finally {
    clearTimeout(watchdog)
  }
  const workerEventsFile = taskPaths.getWorkerEventFile()
  const failedTickEvents = fs.existsSync(workerEventsFile)
    ? fs.readFileSync(workerEventsFile, 'utf8').split(/\r?\n/).filter(line => line.includes('worker_tick_failed')).length
    : 0
  console.log(JSON.stringify({
    loopResolved,
    loopError,
    exitCode: Number(process.exitCode || 0),
    failedTickEvents,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  if (originalTaskStoreCache) require.cache[taskStorePath] = originalTaskStoreCache
  else delete require.cache[taskStorePath]
  delete require.cache[workerMainPath]
})
`
  const summary = runScenario('worker loop should use default self-exit threshold when env threshold is invalid', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_MAX_CONSECUTIVE_FAILURES: 'not-a-number',
  }, 30000)
  if (!summary) return
  check('worker loop invalid self-exit threshold should fall back to default and stop with exitCode 77',
    summary.loopResolved === true
      && summary.loopError === ''
      && summary.exitCode === 77,
    JSON.stringify(summary))
}

// === Scenario 23: 阶段 D.16 supervisor 应回收 stale claiming 残留 ===
function testSupervisorDoesNotLeaveStaleClaimingResidue() {
  const dataDir = createTempDataDir('resource-regress-supervisor-claiming-stale-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

taskStore.ensureTaskDirs()
const pendingTask = taskStore.submitResourceTask({
  id: 'task-claiming-stale-supervisor-1',
  kind: 'agent_task',
  source: 'resource-regression-supervisor-claiming',
  channelKey: 'group-supervisor-claiming',
  userId: 'tester',
  priority: 40,
  timeoutMs: 120000,
  payload: { entry: 'supervisor-claiming-stale' },
  notify: { target: 'none', status: 'pending' },
})
const claimingTask = taskStore.claimTaskById(pendingTask.id, 'stale-claiming-worker')
if (!claimingTask) throw new Error('expected task to enter claiming before supervisor stale-claiming regression')

const workerStateFile = taskPaths.getWorkerStateFile('stale-claiming-worker')
fs.mkdirSync(require('path').dirname(workerStateFile), { recursive: true })
fs.writeFileSync(workerStateFile, JSON.stringify({
  name: 'stale-claiming-worker',
  pid: 0,
  startedAt: '2026-06-01T00:00:00.000Z',
  heartbeatAt: '2026-06-01T00:00:00.000Z',
  alive: false,
  step: 'claiming',
}, null, 2), 'utf8')

const claimingFile = taskPaths.getTaskFile('claiming', claimingTask.kind, claimingTask.id)
const staleClaiming = JSON.parse(fs.readFileSync(claimingFile, 'utf8'))
staleClaiming.updatedAt = '2026-06-01T00:00:00.000Z'
staleClaiming.claimedAt = '2026-06-01T00:00:00.000Z'
fs.writeFileSync(claimingFile, JSON.stringify(staleClaiming, null, 2), 'utf8')

const beforeTask = taskStore.getResourceTaskById(claimingTask.id)
const status = supervisor.runSupervisorOnce({ start: false, once: true })
const afterTask = taskStore.getResourceTaskById(claimingTask.id)
const cleanupEvents = Array.isArray(systemProtection.getSystemProtectionStatus().cleanupEvents)
  ? systemProtection.getSystemProtectionStatus().cleanupEvents
  : []
const staleClaimingEvents = cleanupEvents.filter(event => event.event === 'claiming_stale_recovered' && event.taskId === claimingTask.id)

console.log(JSON.stringify({
  beforeStatus: beforeTask && beforeTask.status || '',
  afterStatus: afterTask && afterTask.status || '',
  claimingExistsAfter: fs.existsSync(claimingFile),
  failedExistsAfter: fs.existsSync(taskPaths.getTaskFile('failed', claimingTask.kind, claimingTask.id)),
  pendingExistsAfter: fs.existsSync(taskPaths.getTaskFile('pending', claimingTask.kind, claimingTask.id)),
  runningExistsAfter: fs.existsSync(taskPaths.getTaskFile('running', claimingTask.kind, claimingTask.id)),
  staleRecoveredCount: Number(status && status.staleClaimingRecovered || 0),
  staleClaimingEventCount: staleClaimingEvents.length,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.16 supervisor stale claiming recovery compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.16 fixture really starts from claiming before supervisor audit',
    summary.beforeStatus === 'claiming',
    JSON.stringify(summary))
  check('D.16 supervisor recovers isolated stale claiming into failed instead of leaving it stuck',
    summary.afterStatus === 'failed' && summary.claimingExistsAfter === false && summary.failedExistsAfter === true,
    JSON.stringify(summary))
  check('D.16 supervisor does not recreate pending/running while recovering stale claiming',
    summary.pendingExistsAfter === false && summary.runningExistsAfter === false,
    JSON.stringify(summary))
  check('D.16 supervisor records stale claiming recovery once',
    summary.staleRecoveredCount >= 1 && summary.staleClaimingEventCount >= 1,
    JSON.stringify(summary))
}

// === Scenario 24: 阶段 D.17 canonical 读取与 cancel 选源一致性 ===
function testCanonicalTaskReadAndCancelSelection() {
  const dataDir = createTempDataDir('resource-regress-canonical-read-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

taskStore.ensureTaskDirs()

function writeCopies(taskId, kind, statuses) {
  const created = taskStore.submitResourceTask({
    id: taskId,
    kind,
    source: 'resource-regression-canonical',
    channelKey: 'group-canonical-read',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  })
  for (const status of statuses.filter(item => item !== 'pending')) {
    const file = taskPaths.getTaskFile(status, kind, taskId)
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      status,
      step: status,
      error: status === 'failed' || status === 'deferred' ? status + '-reason' : '',
      finishedAt: status === 'done' || status === 'failed' || status === 'cancelled' ? '2026-06-11T00:05:00.000Z' : undefined,
    }, null, 2), 'utf8')
  }
}

writeCopies('task-canonical-pending-failed-1', 'daily_summary', ['pending', 'failed'])
writeCopies('task-canonical-pending-done-1', 'daily_summary', ['pending', 'done'])
writeCopies('task-canonical-pending-deferred-1', 'daily_summary', ['pending', 'deferred'])
writeCopies('task-canonical-cancel-pending-deferred-1', 'daily_summary', ['pending', 'deferred'])

const pendingFailed = taskStore.getResourceTaskById('task-canonical-pending-failed-1')
const pendingDone = taskStore.getResourceTaskById('task-canonical-pending-done-1')
const pendingDeferred = taskStore.getResourceTaskById('task-canonical-pending-deferred-1')

const cancelTaskId = 'task-canonical-cancel-pending-deferred-1'
const cancelResult = taskStore.cancelTask(cancelTaskId, 'canonical-regression', 'cancel deferred canonical copy')
const cancelCancelledFile = taskPaths.getTaskFile('cancelled', 'daily_summary', cancelTaskId)
const cancelCancelled = fs.existsSync(cancelCancelledFile)
  ? JSON.parse(fs.readFileSync(cancelCancelledFile, 'utf8'))
  : null

console.log(JSON.stringify({
  pendingFailedStatus: pendingFailed && pendingFailed.status || '',
  pendingDoneStatus: pendingDone && pendingDone.status || '',
  pendingDeferredStatus: pendingDeferred && pendingDeferred.status || '',
  cancelResult,
  cancelPendingExistsAfter: fs.existsSync(taskPaths.getTaskFile('pending', 'daily_summary', cancelTaskId)),
  cancelDeferredExistsAfter: fs.existsSync(taskPaths.getTaskFile('deferred', 'daily_summary', cancelTaskId)),
  cancelCancelledExistsAfter: !!cancelCancelled,
  cancelCancelledStatus: cancelCancelled && cancelCancelled.status || '',
  cancelCancelledError: cancelCancelled && cancelCancelled.error || '',
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.17 canonical read and cancel selection compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.17 getResourceTaskById prefers failed over stale pending when both exist',
    summary.pendingFailedStatus === 'failed',
    JSON.stringify(summary))
  check('D.17 getResourceTaskById prefers done over stale pending when both exist',
    summary.pendingDoneStatus === 'done',
    JSON.stringify(summary))
  check('D.17 getResourceTaskById prefers deferred over stale pending when both exist',
    summary.pendingDeferredStatus === 'deferred',
    JSON.stringify(summary))
  check('D.17 cancelTask cancels canonical deferred copy instead of stale pending copy',
    summary.cancelResult === true
      && summary.cancelPendingExistsAfter === true
      && summary.cancelDeferredExistsAfter === false
      && summary.cancelCancelledExistsAfter === true
      && summary.cancelCancelledStatus === 'cancelled'
      && summary.cancelCancelledError === 'cancel deferred canonical copy',
    JSON.stringify(summary))
}

// === Scenario 25: 阶段 D.18 迁移链不得再从 stale / 跨状态副本猜源 ===
function testTransitionChainDoesNotMigrateFromStaleOrGuessedSource() {
  const dataDir = createTempDataDir('resource-regress-transition-source-')
  const script = String.raw`
const fs = require('fs')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')

function readEvents() {
  const file = taskPaths.getWorkerEventFile()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

taskStore.ensureTaskDirs()

// Case A: stale pending must not complete when canonical failed already exists.
const stalePendingComplete = taskStore.submitResourceTask({
  id: 'task-transition-stale-pending-complete',
  kind: 'daily_summary',
  source: 'resource-regression-transition',
  channelKey: 'group-transition',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { slotId: 'stale-pending-complete' },
  notify: { target: 'none', status: 'pending' },
})
fs.writeFileSync(taskPaths.getTaskFile('failed', stalePendingComplete.kind, stalePendingComplete.id), JSON.stringify({
  ...stalePendingComplete,
  status: 'failed',
  step: 'failed',
  error: 'canonical failed copy',
  finishedAt: '2026-06-11T00:05:00.000Z',
}, null, 2), 'utf8')
const completeResult = taskStore.completeTask(stalePendingComplete, { reply: 'should not complete stale pending' })

// Case B: stale pending must not enter running when canonical claiming already exists.
const stalePendingRunning = taskStore.submitResourceTask({
  id: 'task-transition-stale-pending-running',
  kind: 'agent_task',
  source: 'resource-regression-transition',
  channelKey: 'group-transition',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { entry: 'stale-pending-running' },
  notify: { target: 'none', status: 'pending' },
})
fs.writeFileSync(taskPaths.getTaskFile('claiming', stalePendingRunning.kind, stalePendingRunning.id), JSON.stringify({
  ...stalePendingRunning,
  status: 'claiming',
  step: 'claiming',
  claimedBy: 'canonical-claiming-worker',
  claimedAt: '2026-06-11T00:01:00.000Z',
}, null, 2), 'utf8')
const runningResult = taskStore.markTaskRunning(stalePendingRunning, 'stale-pending-worker', 'starting')

// Case C: if known source file is gone, transition must not guess another status as source.
const staleFailedSeed = taskStore.submitResourceTask({
  id: 'task-transition-missing-source-requeue',
  kind: 'daily_summary',
  source: 'resource-regression-transition',
  channelKey: 'group-transition',
  userId: 'tester',
  priority: 50,
  timeoutMs: 120000,
  payload: { slotId: 'missing-source-requeue' },
  notify: { target: 'none', status: 'pending' },
})
const staleFailedPendingFile = taskPaths.getTaskFile('pending', staleFailedSeed.kind, staleFailedSeed.id)
const staleFailedFile = taskPaths.getTaskFile('failed', staleFailedSeed.kind, staleFailedSeed.id)
const staleDoneFile = taskPaths.getTaskFile('done', staleFailedSeed.kind, staleFailedSeed.id)
fs.unlinkSync(staleFailedPendingFile)
fs.writeFileSync(staleFailedFile, JSON.stringify({
  ...staleFailedSeed,
  status: 'failed',
  step: 'failed',
  error: 'stale failed before source disappears',
  finishedAt: '2026-06-11T00:06:00.000Z',
}, null, 2), 'utf8')
const staleFailedSnapshot = taskStore.getResourceTaskById(staleFailedSeed.id)
fs.unlinkSync(staleFailedFile)
fs.writeFileSync(staleDoneFile, JSON.stringify({
  ...staleFailedSeed,
  status: 'done',
  step: 'done',
  finishedAt: '2026-06-11T00:07:00.000Z',
}, null, 2), 'utf8')
const requeueResult = taskStore.requeueTask(staleFailedSnapshot, 'should not guess done as requeue source')

const allEvents = readEvents()
const doneEvents = allEvents.filter(event => event.event === 'task_done' && event.taskId === stalePendingComplete.id).length
const runningEvents = allEvents.filter(event => event.event === 'task_running' && event.taskId === stalePendingRunning.id).length
const requeueEvents = allEvents.filter(event => event.event === 'task_requeued' && event.taskId === staleFailedSeed.id).length

console.log(JSON.stringify({
  completeReturnedStatus: completeResult && completeResult.status || '',
  completePendingExistsAfter: fs.existsSync(taskPaths.getTaskFile('pending', stalePendingComplete.kind, stalePendingComplete.id)),
  completeFailedExistsAfter: fs.existsSync(taskPaths.getTaskFile('failed', stalePendingComplete.kind, stalePendingComplete.id)),
  completeDoneExistsAfter: fs.existsSync(taskPaths.getTaskFile('done', stalePendingComplete.kind, stalePendingComplete.id)),
  completeResultExistsAfter: fs.existsSync(require('path').join(taskPaths.getTaskResultDir(stalePendingComplete.id), 'result.json')),
  completeCanonicalStatusAfter: taskStore.getResourceTaskById(stalePendingComplete.id) && taskStore.getResourceTaskById(stalePendingComplete.id).status || '',
  completeDoneEventCount: doneEvents,
  runningReturnedStatus: runningResult && runningResult.status || '',
  runningPendingExistsAfter: fs.existsSync(taskPaths.getTaskFile('pending', stalePendingRunning.kind, stalePendingRunning.id)),
  runningClaimingExistsAfter: fs.existsSync(taskPaths.getTaskFile('claiming', stalePendingRunning.kind, stalePendingRunning.id)),
  runningRunningExistsAfter: fs.existsSync(taskPaths.getTaskFile('running', stalePendingRunning.kind, stalePendingRunning.id)),
  runningCanonicalStatusAfter: taskStore.getResourceTaskById(stalePendingRunning.id) && taskStore.getResourceTaskById(stalePendingRunning.id).status || '',
  runningEventCount: runningEvents,
  requeueReturnedStatus: requeueResult && requeueResult.status || '',
  requeuePendingExistsAfter: fs.existsSync(taskPaths.getTaskFile('pending', staleFailedSeed.kind, staleFailedSeed.id)),
  requeueDoneExistsAfter: fs.existsSync(staleDoneFile),
  requeueFailedExistsAfter: fs.existsSync(staleFailedFile),
  requeueCanonicalStatusAfter: taskStore.getResourceTaskById(staleFailedSeed.id) && taskStore.getResourceTaskById(staleFailedSeed.id).status || '',
  requeueEventCount: requeueEvents,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.18 transition chain does not migrate from stale or guessed source', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.18 completeTask does not migrate stale pending into done when canonical failed already exists',
    summary.completeReturnedStatus === 'pending'
      && summary.completePendingExistsAfter === true
      && summary.completeFailedExistsAfter === true
      && summary.completeDoneExistsAfter === false
      && summary.completeResultExistsAfter === false
      && summary.completeCanonicalStatusAfter === 'failed'
      && summary.completeDoneEventCount === 0,
    JSON.stringify(summary))
  check('D.18 markTaskRunning does not migrate stale pending into running when canonical claiming already exists',
    summary.runningReturnedStatus === 'pending'
      && summary.runningPendingExistsAfter === true
      && summary.runningClaimingExistsAfter === true
      && summary.runningRunningExistsAfter === false
      && summary.runningCanonicalStatusAfter === 'claiming'
      && summary.runningEventCount === 0,
    JSON.stringify(summary))
  check('D.18 requeueTask does not guess done as source when failed source file has already disappeared',
    summary.requeueReturnedStatus === 'failed'
      && summary.requeuePendingExistsAfter === false
      && summary.requeueDoneExistsAfter === true
      && summary.requeueFailedExistsAfter === false
      && summary.requeueCanonicalStatusAfter === 'done'
      && summary.requeueEventCount === 0,
    JSON.stringify(summary))
}

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
const blackAfterGreen = planner.planDailySlotTasks(date, channelKey, { slotSize: 40, maxSlots: 3 })
const skippedAfterRecovery = countStopEvents()

console.log(JSON.stringify({
  firstCount: Array.isArray(first) ? first.length : -1,
  secondCount: Array.isArray(second) ? second.length : -1,
  thirdCount: Array.isArray(third) ? third.length : -1,
  skippedAfterBlackTicks,
  greenCount: Array.isArray(green) ? green.length : -1,
  blackAfterGreenCount: Array.isArray(blackAfterGreen) ? blackAfterGreen.length : -1,
  skippedAfterRecovery,
}, null, 2))
process.exitCode = 0
`
  const summary = runScenario('D.26 planner stop event dedupe compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 30000)
  if (!summary) return
  check('D.26 repeated black ticks do not keep appending identical stop events',
    summary.firstCount === 0
      && summary.secondCount === 0
      && summary.thirdCount === 0
      && summary.skippedAfterBlackTicks === 1,
    JSON.stringify(summary))
  check('D.26 planner recovery re-arms a future stop event after green planning resumes',
    summary.greenCount > 0
      && summary.blackAfterGreenCount === 0
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
  check('D.28 daily worker parks before claim and leaves task pending under black memory',
    summary.dailyWorked === false
      && JSON.stringify(summary.dailyStatuses) === JSON.stringify(['pending']),
    JSON.stringify(summary))
  check('D.28 agent worker parks before claim and leaves task pending under black memory',
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

// === Scenario 43: 阶段 D.33 media 入队前门不应顺手扫描其它 kind 队列 ===
function testMediaQueueEnqueueDoesNotScanOtherKindQueues() {
  const dataDir = createTempDataDir('resource-regress-media-enqueue-kind-scope-')
  const script = String.raw`
const Module = require('module')

let fileQueueReads = 0
let voiceQueueReads = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      readJsonFile(target, fallback, maxBytes) {
        const targetText = String(target || '').replace(/\\/g, '/').toLowerCase()
        if (targetText.includes('media-backpressure/queue/file/')) fileQueueReads += 1
        if (targetText.includes('media-backpressure/queue/voice/')) voiceQueueReads += 1
        return loaded.readJsonFile(target, fallback, maxBytes)
      },
    }
  }
  return loaded
}

const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
Module._load = originalLoad

function run() {
  mediaQueue.ensureMediaDirs()
  mediaQueue.enqueueMediaTask({
    kind: 'media_file_analysis',
    channelKey: 'group-kind-scope',
    messageId: 'kind-scope-file-1',
    url: 'https://example.test/kind-scope-file-1.txt',
  })
  mediaQueue.enqueueMediaTask({
    kind: 'media_voice_transcription',
    channelKey: 'group-kind-scope',
    messageId: 'kind-scope-voice-1',
    url: 'https://example.test/kind-scope-voice-1.amr',
  })

  fileQueueReads = 0
  voiceQueueReads = 0

  const created = mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'group-kind-scope',
    messageId: 'kind-scope-image-1',
    url: 'https://example.test/kind-scope-image-1.png',
  })

  console.log(JSON.stringify({
    createdStatus: created && created.status || '',
    fileQueueReads,
    voiceQueueReads,
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
  const summary = runScenario('D.33 media enqueue kind scope compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.33 image enqueue should not read file or voice queue task payloads',
    summary.createdStatus === 'pending'
      && summary.fileQueueReads === 0
      && summary.voiceQueueReads === 0,
    JSON.stringify(summary))
}

// === Scenario 44: 阶段 D.34 已知 kind 的 claim 不应因其它 kind 占满扫描窗口而假空队列 ===
function testClaimNextTaskDoesNotMissTargetKindWhenOtherKindsFillPendingWindow() {
  const dataDir = createTempDataDir('resource-regress-claim-kind-window-')
  const script = String.raw`
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function submit(id, kind, priority, createdAt) {
  return taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-claim-kind-window',
    channelKey: 'group-claim-kind-window',
    userId: 'tester',
    priority,
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
    expiresAt: '',
  })
}

function run() {
  taskStore.ensureTaskDirs()

  for (let i = 0; i < 1000; i += 1) {
    submit(
      'agent-window-' + String(i).padStart(4, '0'),
      'agent_task',
      10,
      '2026-06-11T00:00:' + String(i % 60).padStart(2, '0') + '.000Z',
    )
  }

  const target = submit(
    'daily-window-target-1',
    'daily_summary',
    50,
    '2026-06-11T00:59:59.000Z',
  )

  const claimed = taskStore.claimNextTask(['daily_summary'], 'daily-kind-window-worker')

  console.log(JSON.stringify({
    targetId: target && target.id || '',
    claimedId: claimed && claimed.id || '',
    claimedKind: claimed && claimed.kind || '',
    claimedStatus: claimed && claimed.status || '',
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
  const summary = runScenario('D.34 claim kind window compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.34 daily worker should still claim its own kind even when other kinds fill the first pending scan window',
    summary.claimedId === summary.targetId
      && summary.claimedKind === 'daily_summary'
      && summary.claimedStatus === 'claiming',
    JSON.stringify(summary))
}

// === Scenario 45: 阶段 D.35 getTaskQueueSummary 不应为了计数读取任务 JSON ===
function testGetTaskQueueSummaryCountsWithoutReadingTaskJson() {
  const dataDir = createTempDataDir('resource-regress-queue-summary-count-only-')
  const script = String.raw`
const Module = require('module')

let readJsonCount = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      readJsonFile(file, fallback, maxBytes) {
        const text = String(file || '').replace(/\\/g, '/').toLowerCase()
        if (text.includes('/resource-workers/tasks/')) readJsonCount += 1
        return loaded.readJsonFile(file, fallback, maxBytes)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
Module._load = originalLoad

function submit(id, kind, status) {
  const task = taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-queue-summary',
    channelKey: 'group-queue-summary',
    userId: 'tester',
    priority: 50,
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  })
  if (status === 'pending') return task
  if (status === 'claiming') return taskStore.claimTaskById(task.id, 'queue-summary-worker')
  if (status === 'running') {
    const claiming = taskStore.claimTaskById(task.id, 'queue-summary-worker')
    return taskStore.markTaskRunning(claiming, 'queue-summary-worker', 'running')
  }
  if (status === 'done') {
    const claiming = taskStore.claimTaskById(task.id, 'queue-summary-worker')
    const running = taskStore.markTaskRunning(claiming, 'queue-summary-worker', 'running')
    return taskStore.completeTask(running, { ok: true })
  }
  if (status === 'failed') {
    const claiming = taskStore.claimTaskById(task.id, 'queue-summary-worker')
    return taskStore.failTask(claiming, new Error('queue summary failed'), { reason: 'queue summary failed' })
  }
  if (status === 'cancelled') {
    taskStore.cancelTask(task.id, 'resource-regression', 'queue summary cancelled')
    return task
  }
  if (status === 'deferred') {
    const claiming = taskStore.claimTaskById(task.id, 'queue-summary-worker')
    return taskStore.deferTask(claiming, 'queue summary deferred')
  }
  throw new Error('unsupported status: ' + status)
}

function run() {
  taskStore.ensureTaskDirs()
  submit('queue-summary-pending-1', 'daily_summary', 'pending')
  submit('queue-summary-pending-2', 'agent_task', 'pending')
  submit('queue-summary-claiming-1', 'daily_summary', 'claiming')
  submit('queue-summary-running-1', 'daily_summary', 'running')
  submit('queue-summary-done-1', 'daily_summary', 'done')
  submit('queue-summary-failed-1', 'daily_summary', 'failed')
  submit('queue-summary-cancelled-1', 'daily_summary', 'cancelled')
  submit('queue-summary-deferred-1', 'daily_summary', 'deferred')

  readJsonCount = 0
  const summary = taskStore.getTaskQueueSummary()

  console.log(JSON.stringify({
    pending: Number(summary.pending || 0),
    claiming: Number(summary.claiming || 0),
    running: Number(summary.running || 0),
    done: Number(summary.done || 0),
    failed: Number(summary.failed || 0),
    cancelled: Number(summary.cancelled || 0),
    deferred: Number(summary.deferred || 0),
    readJsonCount,
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
  const summary = runScenario('D.35 queue summary count-only compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.35 queue summary should keep per-status counts correct',
    summary.pending === 2
      && summary.claiming === 1
      && summary.running === 1
      && summary.done === 1
      && summary.failed === 1
      && summary.cancelled === 1
      && summary.deferred === 1,
    JSON.stringify(summary))
  check('D.35 queue summary should not read task JSON files when only counting status totals',
    summary.readJsonCount === 0,
    JSON.stringify(summary))
}

// === Scenario 47: 阶段 D.41 countResourceTasks(kind) 不应为了计数读取无关任务 JSON ===
function testCountResourceTasksByKindDoesNotReadUnrelatedTaskJson() {
  const dataDir = createTempDataDir('resource-regress-count-kind-count-only-')
  const script = String.raw`
const Module = require('module')

let readJsonCount = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      readJsonFile(file, fallback, maxBytes) {
        const text = String(file || '').replace(/\\/g, '/').toLowerCase()
        if (text.includes('/resource-workers/tasks/')) readJsonCount += 1
        return loaded.readJsonFile(file, fallback, maxBytes)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
Module._load = originalLoad

function submit(id, kind) {
  return taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-count-kind',
    channelKey: kind === 'daily_summary' ? 'daily-channel' : 'noise-channel',
    userId: kind === 'daily_summary' ? 'daily-user' : 'noise-user',
    priority: 50,
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  })
}

function run() {
  taskStore.ensureTaskDirs()
  submit('count-kind-daily-target', 'daily_summary')
  for (let i = 0; i < 200; i += 1) {
    submit('count-kind-noise-' + String(i).padStart(4, '0'), 'agent_task')
  }

  readJsonCount = 0
  const total = taskStore.countResourceTasks({
    kind: 'daily_summary',
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 20000,
  })

  console.log(JSON.stringify({
    total,
    readJsonCount,
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
  const summary = runScenario('D.41 countResourceTasks kind count-only compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.41 countResourceTasks kind count should keep result correct under unrelated backlog',
    summary.total === 1,
    JSON.stringify(summary))
  check('D.41 countResourceTasks kind count should not read unrelated task JSON files',
    summary.readJsonCount <= 1,
    JSON.stringify(summary))
}

// === Scenario 46: 阶段 D.36 前门活跃任务去重不应被 1000 条无关任务挤出窗口 ===
function testActiveTaskDedupeDoesNotMissTargetsWhenBacklogWindowIsFull() {
  const dataDir = createTempDataDir('resource-regress-active-dedupe-window-')
  const script = String.raw`
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const agentSubmission = require('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
const background = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/background-llm-submission')
const memory = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/memory-worker')

function submit(kind, id, extra = {}) {
  return taskStore.submitResourceTask({
    id,
    kind,
    source: 'resource-regression-active-dedupe',
    channelKey: extra.channelKey || '',
    userId: extra.userId || '',
    priority: extra.priority || 50,
    timeoutMs: 120000,
    payload: extra.payload || {},
    notify: { target: 'none', status: 'pending' },
  })
}

function countMatches(kind, matcher) {
  return taskStore.countResourceTasksByKind({
    kind,
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 20000,
  }, matcher)
}

function run() {
  taskStore.ensureTaskDirs()

  const agentChannelKey = 'zzz-active-dedupe-agent-channel'
  const summaryKey = 'zzz-active-dedupe-summary-channel::summary-user'
  const sensitiveChannelKey = 'zzz-active-dedupe-sensitive-channel'
  const memoryUserId = 'memory-user'

  submit('agent_task', 'zzz-active-dedupe-agent-target', {
    channelKey: agentChannelKey,
    userId: 'agent-user',
  })
  submit('conversation_summary', 'zzz-active-dedupe-summary-target', {
    channelKey: 'zzz-active-dedupe-summary-channel',
    userId: 'summary-user',
    payload: { key: summaryKey },
  })
  submit('sensitive_cache_analysis', 'zzz-active-dedupe-sensitive-target', {
    channelKey: sensitiveChannelKey,
    userId: '',
    payload: { channelKey: sensitiveChannelKey },
  })
  submit('agent_memory', 'zzz-active-dedupe-memory-target-1', {
    channelKey: 'dashboard',
    userId: memoryUserId,
    payload: { userId: memoryUserId },
  })
  submit('agent_memory', 'zzz-active-dedupe-memory-target-2', {
    channelKey: 'dashboard',
    userId: memoryUserId,
    payload: { userId: memoryUserId },
  })
  submit('agent_memory_compaction', 'zzz-active-dedupe-compaction-target', {
    channelKey: 'dashboard',
    userId: memoryUserId,
    payload: { userId: memoryUserId },
  })

  for (let i = 0; i < 1000; i += 1) {
    submit('agent_memory', 'noise-' + String(i).padStart(4, '0'), {
      channelKey: 'noise-channel',
      userId: 'noise-user',
      priority: 10,
      payload: { noise: i },
    })
  }

  const agentResult = agentSubmission.submitAgentWorkerTask({
    channel: 'group',
    channelKey: agentChannelKey,
    userId: 'agent-user',
    source: 'resource-regression-active-dedupe',
    payload: { probe: 'agent' },
    notifyTarget: 'none',
    acceptedMessageMode: 'quiet',
  })
  const summaryResult = background.submitConversationSummaryTask({
    key: summaryKey,
    source: 'resource-regression-active-dedupe',
  })
  const sensitiveResult = background.submitSensitiveCacheAnalysisTask({
    channelKey: sensitiveChannelKey,
    source: 'resource-regression-active-dedupe',
  })
  const memoryResult = memory.submitAgentMemoryTask({
    userId: memoryUserId,
    recentMessages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ],
    source: 'resource-regression-active-dedupe',
  })
  const compactionResult = memory.submitAgentMemoryCompactionTask(memoryUserId, 'resource-regression-active-dedupe')

  const summary = {
    agentResult,
    summaryResult,
    sensitiveResult,
    memoryResult,
    compactionResult,
    agentMatches: countMatches('agent_task', task => String(task.channelKey || '') === agentChannelKey && String(task.userId || '') === 'agent-user'),
    summaryMatches: countMatches('conversation_summary', task => String(task.payload?.key || '') === summaryKey),
    sensitiveMatches: countMatches('sensitive_cache_analysis', task => String(task.channelKey || '') === sensitiveChannelKey),
    memoryMatches: countMatches('agent_memory', task => String(task.userId || '') === memoryUserId),
    compactionMatches: countMatches('agent_memory_compaction', task => String(task.userId || '') === memoryUserId),
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = 0
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
}
`
  const summary = runScenario('D.36 active-task dedupe backlog window compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.36 agent worker submission should be blocked by existing active task even under large backlog window',
    summary.agentResult && summary.agentResult.accepted === false && summary.agentResult.status === 429,
    JSON.stringify(summary))
  check('D.36 conversation summary submission should be skipped by existing active task even under large backlog window',
    summary.summaryResult && summary.summaryResult.accepted === false && summary.summaryResult.status === 'skipped',
    JSON.stringify(summary))
  check('D.36 sensitive cache analysis submission should be skipped by existing active task even under large backlog window',
    summary.sensitiveResult && summary.sensitiveResult.accepted === false && summary.sensitiveResult.status === 'skipped',
    JSON.stringify(summary))
  check('D.36 agent memory submission should be skipped by existing active tasks even under large backlog window',
    summary.memoryResult && summary.memoryResult.accepted === false && summary.memoryResult.status === 'skipped',
    JSON.stringify(summary))
  check('D.36 agent memory compaction submission should be skipped by existing active task even under large backlog window',
    summary.compactionResult && summary.compactionResult.accepted === false && summary.compactionResult.status === 'skipped',
    JSON.stringify(summary))
  check('D.36 active task counts should remain unchanged when backlog window is full',
    summary.agentMatches === 1
      && summary.summaryMatches === 1
      && summary.sensitiveMatches === 1
      && summary.memoryMatches === 2
      && summary.compactionMatches === 1,
    JSON.stringify(summary))
}

// === Scenario 47: 架构块 agent deferred/backlog 前门全局堆积止血 ===
function testAgentDeferredBacklogCapStopsMultiUserDeferredPileup() {
  const dataDir = createTempDataDir('resource-regress-agent-deferred-backlog-cap-')
  const script = String.raw`
const agentSubmission = require('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function submitFor(userId) {
  return agentSubmission.submitAgentWorkerTask({
    channel: 'group',
    channelKey: 'group-agent-deferred-backlog-cap',
    userId,
    source: 'resource-regression-agent-deferred-backlog-cap',
    payload: { probe: 'deferred-backlog-' + userId },
    notifyTarget: 'none',
    acceptedMessageMode: 'quiet',
  })
}

function run() {
  const first = submitFor('agent-backlog-user-1')
  const second = submitFor('agent-backlog-user-2')
  const third = submitFor('agent-backlog-user-3')

  const matchingTasks = taskStore.listResourceTasks({
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 50,
  }).filter(task => String(task.kind || '') === 'agent_task')

  console.log(JSON.stringify({
    firstAccepted: !!first.accepted,
    firstStatus: Number(first.status || 0),
    secondAccepted: !!second.accepted,
    secondStatus: Number(second.status || 0),
    thirdAccepted: !!third.accepted,
    thirdStatus: Number(third.status || 0),
    matchingStatuses: matchingTasks.map(task => String(task.status || '')).sort(),
    matchingUsers: matchingTasks.map(task => String(task.userId || '')).sort(),
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
  const summary = runScenario('agent deferred/backlog global cap compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_AGENT_ACTIVE_BACKLOG_MAX: '2',
  }, 30000)
  if (!summary) return
  check('agent deferred/backlog should still allow the first two distinct users to materialize deferred placeholders under black memory',
    summary.firstAccepted === false
      && summary.firstStatus === 202
      && summary.secondAccepted === false
      && summary.secondStatus === 202,
    JSON.stringify(summary))
  check('agent deferred/backlog should block the third distinct user at the frontdoor instead of creating a third deferred placeholder',
    summary.thirdAccepted === false
      && summary.thirdStatus === 429
      && JSON.stringify(summary.matchingStatuses) === JSON.stringify(['deferred', 'deferred'])
      && JSON.stringify(summary.matchingUsers) === JSON.stringify(['agent-backlog-user-1', 'agent-backlog-user-2']),
    JSON.stringify(summary))
}

// === Scenario 47: 阶段 D.45 Agent deferred 前门去重补齐 ===
function testAgentDeferredTasksStillCountAsActiveAtSubmissionFrontdoor() {
  const dataDir = createTempDataDir('resource-regress-agent-deferred-frontdoor-')
  const script = String.raw`
const agentSubmission = require('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function run() {
  const channelKey = 'group-agent-deferred-frontdoor'
  const userId = 'agent-deferred-user'

  const first = agentSubmission.submitAgentWorkerTask({
    channel: 'group',
    channelKey,
    userId,
    source: 'resource-regression-agent-deferred-frontdoor',
    payload: { probe: 'first-deferred' },
    notifyTarget: 'none',
    acceptedMessageMode: 'quiet',
  })

  const second = agentSubmission.submitAgentWorkerTask({
    channel: 'group',
    channelKey,
    userId,
    source: 'resource-regression-agent-deferred-frontdoor',
    payload: { probe: 'second-should-block' },
    notifyTarget: 'none',
    acceptedMessageMode: 'quiet',
  })

  const matchingTasks = taskStore.listResourceTasks({
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 50,
  }).filter(task =>
    String(task.kind || '') === 'agent_task'
    && String(task.channelKey || '') === channelKey
    && String(task.userId || '') === userId
  )

  console.log(JSON.stringify({
    firstAccepted: !!first.accepted,
    firstStatus: Number(first.status || 0),
    firstTaskId: String(first.taskId || ''),
    secondAccepted: !!second.accepted,
    secondStatus: Number(second.status || 0),
    matchingStatuses: matchingTasks.map(task => String(task.status || '')).sort(),
    matchingTaskIds: matchingTasks.map(task => String(task.id || '')).sort(),
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
  const summary = runScenario('D.45 agent deferred frontdoor compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.45 first agent submission may still materialize one deferred task under black memory',
    summary.firstAccepted === false
      && summary.firstStatus === 202
      && !!summary.firstTaskId,
    JSON.stringify(summary))
  check('D.45 second agent submission should be blocked by the existing deferred task instead of creating another one',
    summary.secondAccepted === false
      && summary.secondStatus === 429
      && JSON.stringify(summary.matchingStatuses) === JSON.stringify(['deferred'])
      && JSON.stringify(summary.matchingTaskIds) === JSON.stringify([summary.firstTaskId]),
    JSON.stringify(summary))
}

// === Scenario 48: 阶段 D.46 agent deferred 长期占位到期释放 ===
function testAgentDeferredTaskExpiryReleasesFrontdoorBlock() {
  const dataDir = createTempDataDir('resource-regress-agent-deferred-expiry-')
  const script = String.raw`
const agentSubmission = require('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')

function listMatching(statuses) {
  return taskStore.listResourceTasks({ statuses, limit: 50 }).filter(task =>
    String(task.kind || '') === 'agent_task'
    && String(task.channelKey || '') === 'group-agent-deferred-expiry'
    && String(task.userId || '') === 'agent-deferred-expiry-user'
  )
}

function run() {
  const originalNow = Date.now
  try {
    const first = agentSubmission.submitAgentWorkerTask({
      channel: 'group',
      channelKey: 'group-agent-deferred-expiry',
      userId: 'agent-deferred-expiry-user',
      source: 'resource-regression-agent-deferred-expiry',
      timeoutMs: 60000,
      payload: { probe: 'first-deferred-expiry' },
      notifyTarget: 'none',
      acceptedMessageMode: 'quiet',
    })

    const secondWhileBlack = agentSubmission.submitAgentWorkerTask({
      channel: 'group',
      channelKey: 'group-agent-deferred-expiry',
      userId: 'agent-deferred-expiry-user',
      source: 'resource-regression-agent-deferred-expiry',
      timeoutMs: 60000,
      payload: { probe: 'second-should-block-before-expiry' },
      notifyTarget: 'none',
      acceptedMessageMode: 'quiet',
    })

    const deferredBefore = listMatching(['deferred'])
    const deferredTask = deferredBefore[0] || null
    const expiresAtMs = Date.parse(String(deferredTask && deferredTask.expiresAt || ''))

    Date.now = () => Number.isFinite(expiresAtMs) ? expiresAtMs + 1000 : originalNow()
    const audit = supervisor.auditDeferredTasks(50)

    const failedAfterAudit = listMatching(['failed'])

    process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
    const thirdAfterExpiry = agentSubmission.submitAgentWorkerTask({
      channel: 'group',
      channelKey: 'group-agent-deferred-expiry',
      userId: 'agent-deferred-expiry-user',
      source: 'resource-regression-agent-deferred-expiry',
      timeoutMs: 60000,
      payload: { probe: 'third-after-expiry' },
      notifyTarget: 'none',
      acceptedMessageMode: 'quiet',
    })

    console.log(JSON.stringify({
      firstAccepted: !!first.accepted,
      firstStatus: Number(first.status || 0),
      firstTaskId: String(first.taskId || ''),
      secondWhileBlackAccepted: !!secondWhileBlack.accepted,
      secondWhileBlackStatus: Number(secondWhileBlack.status || 0),
      deferredBeforeStatuses: deferredBefore.map(task => String(task.status || '')).sort(),
      deferredExpiresAt: deferredTask ? String(deferredTask.expiresAt || '') : '',
      deferredExpiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
      audit,
      failedAfterAuditIds: failedAfterAudit.map(task => String(task.id || '')).sort(),
      thirdAfterExpiryAccepted: !!thirdAfterExpiry.accepted,
      thirdAfterExpiryStatus: Number(thirdAfterExpiry.status || 0),
      thirdAfterExpiryTaskId: String(thirdAfterExpiry.taskId || ''),
    }, null, 2))
    process.exitCode = 0
  } finally {
    Date.now = originalNow
  }
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
}
`
  const summary = runScenario('D.46 agent deferred expiry compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.46 fixture should start from one deferred agent task that blocks a same-user resubmit under black memory',
    summary.firstAccepted === false
      && summary.firstStatus === 202
      && summary.secondWhileBlackAccepted === false
      && summary.secondWhileBlackStatus === 429
      && JSON.stringify(summary.deferredBeforeStatuses) === JSON.stringify(['deferred']),
    JSON.stringify(summary))
  check('D.46 deferred agent task should carry a bounded expiresAt so supervisor can fail it after timeout',
    typeof summary.deferredExpiresAt === 'string'
      && summary.deferredExpiresAt.length > 0
      && summary.deferredExpiresAtMs !== null,
    JSON.stringify(summary))
  check('D.46 deferred expiry audit should fail the expired placeholder instead of keeping the same-user block forever',
    summary.audit
      && summary.audit.failed === 1
      && JSON.stringify(summary.failedAfterAuditIds) === JSON.stringify([summary.firstTaskId]),
    JSON.stringify(summary))
  check('D.46 same user should be able to submit a fresh agent task after the expired deferred placeholder is cleaned up',
    summary.thirdAfterExpiryAccepted === true
      && summary.thirdAfterExpiryStatus === 202
      && !!summary.thirdAfterExpiryTaskId
      && summary.thirdAfterExpiryTaskId !== summary.firstTaskId,
    JSON.stringify(summary))
}

// === Scenario 49: 架构块 deferred audit/write amplification ===
function testDeferredAuditDoesNotRewriteAdmissionForKeptDeferredTasks() {
  const dataDir = createTempDataDir('resource-regress-deferred-audit-admission-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
const { SCHEDULER_ROOT } = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-snapshot')

function countDeferredAuditAdmissionEvents(taskId) {
  const stamp = new Date().toISOString().slice(0, 10)
  const file = path.join(SCHEDULER_ROOT, 'admissions-' + stamp + '.jsonl')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(event =>
      event
      && event.event === 'admission_decided'
      && String(event.source || '') === 'worker-supervisor-deferred-audit'
      && String(event.taskId || '') === taskId
    ).length
}

function listDeferredById(taskId) {
  return taskStore.listResourceTasks({ statuses: ['deferred'], limit: 50 }).filter(task => String(task.id || '') === taskId)
}

function run() {
  const seed = taskStore.submitResourceTask({
    id: 'deferred-audit-kept-agent-1',
    kind: 'agent_task',
    source: 'resource-regression-deferred-audit',
    channelKey: 'group-deferred-audit-kept',
    userId: 'deferred-audit-user-1',
    timeoutMs: 600000,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    payload: { probe: 'kept-deferred-admission' },
    notify: { target: 'none', status: 'pending' },
  })
  const deferred = taskStore.deferTask(seed, 'seed kept deferred for admission rewrite regression')
  const taskId = String(deferred.id || '')
  const before = countDeferredAuditAdmissionEvents(taskId)
  const originalNow = Date.now
  try {
    const first = supervisor.auditDeferredTasks(50)
    const afterFirst = countDeferredAuditAdmissionEvents(taskId)
    Date.now = () => originalNow() + 31 * 1000
    const second = supervisor.auditDeferredTasks(50)
    const afterSecond = countDeferredAuditAdmissionEvents(taskId)
    const deferredAfter = listDeferredById(taskId)

    console.log(JSON.stringify({
      before,
      first,
      afterFirst,
      second,
      afterSecond,
      deferredAfterStatuses: deferredAfter.map(task => String(task.status || '')).sort(),
    }, null, 2))
    process.exitCode = 0
  } finally {
    Date.now = originalNow
  }
}

try {
  run()
} catch (error) {
  console.error(error && error.stack || error)
  process.exitCode = 1
}
`
  const summary = runScenario('deferred audit/write amplification kept-defer admission compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_ADMISSION_EVENT_DEDUPE_MS: '10000',
  }, 30000)
  if (!summary) return
  check('deferred audit/write amplification fixture should keep the deferred agent task in place under black memory',
    summary.first
      && summary.second
      && JSON.stringify(summary.deferredAfterStatuses) === JSON.stringify(['deferred']),
    JSON.stringify(summary))
  check('deferred audit/write amplification should not append admission_decided events while deferred audit only keeps the same task deferred',
    summary.before === 0
      && summary.afterFirst === 0
      && summary.afterSecond === 0,
    JSON.stringify(summary))
}

// === Scenario 49: 阶段 D.37 file-history 读路径无变化时不应重写 JSON ===
function testRecentFilesReadDoesNotRewriteHistoryWithoutActualCleanup() {
  const dataDir = createTempDataDir('resource-regress-file-history-read-writeback-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const store = require('koishi-plugin-dongxuelian-ai/lib/media/file/file-store')

async function run() {
  const channelKey = 'group-file-history-read'

  await store.storeFile(channelKey, 'fresh-file-1', {
    fileName: 'fresh.txt',
    fileSize: 12,
    mimeType: 'text/plain',
    ext: 'txt',
    url: 'https://example.test/fresh.txt',
    fileId: 'fresh-file-token',
    conversationKey: channelKey,
    userId: 'user-1',
    skipped: false,
  })

  const historyFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'file-history', 'group-file-history-read.json')
  const beforeText = fs.readFileSync(historyFile, 'utf8')
  const beforeMtime = fs.statSync(historyFile).mtimeMs

  await new Promise(resolve => setTimeout(resolve, 1100))
  const recent = await store.getRecentFiles(channelKey, 10)

  const afterText = fs.readFileSync(historyFile, 'utf8')
  const afterMtime = fs.statSync(historyFile).mtimeMs

  const staleFile = 'stale-file-1'
  const staleData = JSON.parse(afterText)
  staleData.files[staleFile] = {
    fileName: 'stale.txt',
    fileSize: 5,
    mimeType: 'text/plain',
    ext: 'txt',
    url: 'https://example.test/stale.txt',
    fileId: 'stale-file-token',
    conversationKey: channelKey,
    userId: 'user-1',
    ts: Date.now() - (5 * 60 * 60 * 1000),
    skipped: false,
    skipReason: null,
    analyzed: false,
    analysis: null,
    localPath: null,
  }
  fs.writeFileSync(historyFile, JSON.stringify(staleData), 'utf8')

  await new Promise(resolve => setTimeout(resolve, 1100))
  const staleBeforeMtime = fs.statSync(historyFile).mtimeMs
  const recentAfterCleanup = await store.getRecentFiles(channelKey, 10)
  const cleanedText = fs.readFileSync(historyFile, 'utf8')
  const staleAfterMtime = fs.statSync(historyFile).mtimeMs
  const cleanedData = JSON.parse(cleanedText)

  console.log(JSON.stringify({
    recentCount: Array.isArray(recent) ? recent.length : -1,
    unchangedText: beforeText === afterText,
    unchangedMtime: afterMtime === beforeMtime,
    staleBeforeMtime,
    staleAfterMtime,
    staleRemoved: !cleanedData.files[staleFile],
    recentAfterCleanupCount: Array.isArray(recentAfterCleanup) ? recentAfterCleanup.length : -1,
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.37 file-history read writeback compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.37 getRecentFiles should stay read-only when no expired or oversized history needs cleanup',
    summary.recentCount === 1
      && summary.unchangedText === true
      && summary.unchangedMtime === true,
    JSON.stringify(summary))
  check('D.37 getRecentFiles should still persist cleanup when stale file-history entries are removed',
    summary.staleRemoved === true
      && summary.staleAfterMtime > summary.staleBeforeMtime
      && summary.recentAfterCleanupCount === 1,
    JSON.stringify(summary))
}

// === Scenario 50: 阶段 D.38 非文件追问不应在普通聊天主路径白读 file-history ===
function testFileFollowupGuardDoesNotReadHistoryForNonFileChat() {
  const dataDir = createTempDataDir('resource-regress-file-followup-read-gate-')
  const script = String.raw`
let recentReads = 0
const store = require('koishi-plugin-dongxuelian-ai/lib/media/file/file-store')
const statePath = require.resolve('koishi-plugin-dongxuelian-ai/lib/media/file/file-followup-state')
const originalGetRecentFiles = store.getRecentFiles
store.getRecentFiles = async function patchedGetRecentFiles(channelKey, limit) {
  recentReads += 1
  return originalGetRecentFiles.call(this, channelKey, limit)
}
delete require.cache[statePath]
const state = require(statePath)

async function run() {
  const channelKey = 'group-file-followup-read-gate'
  await store.storeFile(channelKey, 'followup-file-1', {
    fileName: 'followup.txt',
    fileSize: 18,
    mimeType: 'text/plain',
    ext: 'txt',
    url: 'https://example.test/followup.txt',
    fileId: 'followup-token',
    conversationKey: channelKey,
    userId: 'user-1',
    skipped: false,
  })

  recentReads = 0
  const idleState = await state.buildFileFollowupState(channelKey, '今天天气怎么样', { userId: 'user-1' })
  const idleRecentReads = recentReads

  recentReads = 0
  const followupState = await state.buildFileFollowupState(channelKey, '这个文件里讲了什么', { userId: 'user-1' })
  const followupRecentReads = recentReads

  console.log(JSON.stringify({
    idleRecentReads,
    idleShouldVerify: !!idleState.shouldVerify,
    idleTargetFile: idleState.targetFile ? String(idleState.targetFile.messageId || '') : '',
    followupRecentReads,
    followupShouldVerify: !!followupState.shouldVerify,
    followupTargetFile: followupState.targetFile ? String(followupState.targetFile.messageId || '') : '',
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  store.getRecentFiles = originalGetRecentFiles
})
`
  const summary = runScenario('D.38 file followup read gate compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.38 ordinary non-file chat should not read file-history just to decide no file follow-up',
    summary.idleRecentReads === 0
      && summary.idleShouldVerify === false
      && summary.idleTargetFile === '',
    JSON.stringify(summary))
  check('D.38 real file follow-up should still read file-history and resolve target file',
    summary.followupRecentReads >= 1
      && summary.followupShouldVerify === true
      && summary.followupTargetFile === 'followup-file-1',
    JSON.stringify(summary))
}

// === Scenario 51: 阶段 D.39 media under-limit 入队不应为 queue limit 重读同类 JSON ===
function testMediaQueueUnderLimitEnqueueDoesNotRereadKindJsonForQueueLimit() {
  const dataDir = createTempDataDir('resource-regress-media-under-limit-queue-limit-')
  const script = String.raw`
const Module = require('module')

let imageQueueReads = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      readJsonFile(target, fallback, maxBytes) {
        const targetText = String(target || '').replace(/\\/g, '/').toLowerCase()
        if (targetText.includes('media-backpressure/queue/image/')) imageQueueReads += 1
        return loaded.readJsonFile(target, fallback, maxBytes)
      },
    }
  }
  return loaded
}

const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
Module._load = originalLoad

function run() {
  mediaQueue.ensureMediaDirs()
  imageQueueReads = 0
  const created = mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'group-media-under-limit',
    messageId: 'media-under-limit-1',
    url: 'https://example.test/media-under-limit-1.png',
  })

  console.log(JSON.stringify({
    createdStatus: created && created.status || '',
    imageQueueReads,
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
  const summary = runScenario('D.39 media enqueue under-limit queue-limit compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.39 under-limit media enqueue should not reread same-kind queue JSON just to prove queue limit is safe',
    summary.createdStatus === 'pending'
      && summary.imageQueueReads === 0,
    JSON.stringify(summary))
}

// === Scenario 52: 阶段 D.40 resource snapshot 无变化读取不应重写 state.json ===
function testResourceSnapshotReadDoesNotRewriteSchedulerStateWithoutActualChange() {
  const dataDir = createTempDataDir('resource-regress-resource-snapshot-writeback-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const scheduler = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-snapshot')

function run() {
  const stateFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-scheduler', 'state.json')

  const first = scheduler.readResourceSnapshot()
  const beforeText = fs.readFileSync(stateFile, 'utf8')
  const beforeMtime = fs.statSync(stateFile).mtimeMs

  const second = scheduler.readResourceSnapshot()
  const afterText = fs.readFileSync(stateFile, 'utf8')
  const afterMtime = fs.statSync(stateFile).mtimeMs

  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '250'
  const third = scheduler.readResourceSnapshot()
  const changedText = fs.readFileSync(stateFile, 'utf8')
  const changedMtime = fs.statSync(stateFile).mtimeMs

  console.log(JSON.stringify({
    firstState: String(first && first.resourceState || ''),
    secondState: String(second && second.resourceState || ''),
    thirdState: String(third && third.resourceState || ''),
    unchangedText: beforeText === afterText,
    unchangedMtime: beforeMtime === afterMtime,
    changedMtimeGreater: changedMtime > afterMtime,
    changedTextDifferent: changedText !== afterText,
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
  const summary = runScenario('D.40 resource snapshot read writeback compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.40 readResourceSnapshot should stay read-only when snapshot inputs are unchanged',
    summary.firstState === 'green'
      && summary.secondState === 'green'
      && summary.unchangedText === true
      && summary.unchangedMtime === true,
    JSON.stringify(summary))
  check('D.40 readResourceSnapshot should still persist scheduler state when inputs actually change',
    summary.thirdState === 'black'
      && summary.changedTextDifferent === true
      && summary.changedMtimeGreater === true,
    JSON.stringify(summary))
}

// === Scenario 53: 阶段 D.44 S1 锁心跳抖动不应驱动 state.json 持续重写 ===
function testResourceSnapshotHeartbeatOnlyChangeDoesNotRewriteSchedulerState() {
  const dataDir = createTempDataDir('resource-regress-resource-snapshot-heartbeat-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const scheduler = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-snapshot')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  const stateFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-scheduler', 'state.json')
  const lockFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-gate', 'lock', 'meta.json')
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })

  const baseLock = {
    taskId: 'resource-snapshot-heartbeat-task',
    kind: 'daily_report',
    owner: 'resource-regression-test',
    pid: process.pid,
    channelKey: 'heartbeat-group',
    userId: 'heartbeat-user',
    startedAt: '2026-06-12T00:00:00.000Z',
    heartbeatAt: '2026-06-12T00:00:01.000Z',
    step: 'rendering',
    memAvailableMb: 1200,
    timeoutMs: 600000,
    ticketId: 'heartbeat-ticket-1',
  }

  fs.writeFileSync(lockFile, JSON.stringify(baseLock), 'utf8')
  const first = scheduler.readResourceSnapshot()
  const beforeText = fs.readFileSync(stateFile, 'utf8')
  const beforeMtime = fs.statSync(stateFile).mtimeMs

  await sleep(1100)
  fs.writeFileSync(lockFile, JSON.stringify({
    ...baseLock,
    heartbeatAt: '2026-06-12T00:00:03.000Z',
  }), 'utf8')
  const second = scheduler.readResourceSnapshot()
  const afterHeartbeatText = fs.readFileSync(stateFile, 'utf8')
  const afterHeartbeatMtime = fs.statSync(stateFile).mtimeMs

  await sleep(1100)
  fs.writeFileSync(lockFile, JSON.stringify({
    ...baseLock,
    heartbeatAt: '2026-06-12T00:00:05.000Z',
    step: 'writing_result',
  }), 'utf8')
  const third = scheduler.readResourceSnapshot()
  const afterStepText = fs.readFileSync(stateFile, 'utf8')
  const afterStepMtime = fs.statSync(stateFile).mtimeMs

  console.log(JSON.stringify({
    firstMode: String(first && first.botMode || ''),
    secondMode: String(second && second.botMode || ''),
    thirdMode: String(third && third.botMode || ''),
    heartbeatOnlyTextUnchanged: beforeText === afterHeartbeatText,
    heartbeatOnlyMtimeUnchanged: beforeMtime === afterHeartbeatMtime,
    stepChangeTextDifferent: afterStepText !== afterHeartbeatText,
    stepChangeMtimeGreater: afterStepMtime > afterHeartbeatMtime,
    secondStep: String(second && second.running && second.running.step || ''),
    thirdStep: String(third && third.running && third.running.step || ''),
  }, null, 2))
  process.exitCode = 0
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('D.44 resource snapshot heartbeat writeback compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('D.44 heartbeat-only lock updates should not rewrite scheduler state.json',
    summary.firstMode === 'report_silent'
      && summary.secondMode === 'report_silent'
      && summary.heartbeatOnlyTextUnchanged === true
      && summary.heartbeatOnlyMtimeUnchanged === true
      && summary.secondStep === 'rendering',
    JSON.stringify(summary))
  check('D.44 real running-state changes should still rewrite scheduler state.json',
    summary.thirdMode === 'report_silent'
      && summary.stepChangeTextDifferent === true
      && summary.stepChangeMtimeGreater === true
      && summary.thirdStep === 'writing_result',
    JSON.stringify(summary))
}

// === Scenario 54: 问题域 task-store known-kind taskId 查找不应全状态扫盘 ===
function testKnownKindTaskLookupDoesNotScanUnrelatedStatuses() {
  const dataDir = createTempDataDir('resource-regress-known-kind-task-lookup-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

let unrelatedStatusScans = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      listJsonFiles(root, options) {
        const rootText = String(root || '').replace(/\\/g, '/').toLowerCase()
        if (
          /\/resource-workers\/tasks\/done(?:\/|$)/.test(rootText)
          || /\/resource-workers\/tasks\/cancelled(?:\/|$)/.test(rootText)
        ) {
          unrelatedStatusScans += 1
        }
        return loaded.listJsonFiles(root, options)
      },
    }
  }
  return loaded
}

const taskClient = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-client')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const planner = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-planner')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')

function buildDeterministicTaskId(date, channelKey, slotId) {
  return ['daily_slot', date, channelKey, slotId]
    .join('-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function submitDailyTask(taskId, slotId) {
  return taskClient.submitWorkerTaskWithAdmission({
    id: taskId,
    kind: 'daily_summary',
    source: 'resource-regression-known-kind',
    channelKey: 'known-kind-group',
    userId: 'known-kind-user',
    priority: 70,
    timeoutMs: 120000,
    payload: { date: '2026-06-12', channelKey: 'known-kind-group', slotId, start: 0, end: 10, messageIds: ['m1'] },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: false })
}

function run() {
  taskStore.ensureTaskDirs()

  const explicit = submitDailyTask('known-kind-explicit-task-1', 'slot-explicit')
  unrelatedStatusScans = 0
  const explicitAgain = taskClient.submitWorkerTaskWithAdmission({
    id: 'known-kind-explicit-task-1',
    kind: 'daily_summary',
    source: 'resource-regression-known-kind',
    channelKey: 'known-kind-group',
    userId: 'known-kind-user',
    priority: 70,
    timeoutMs: 120000,
    payload: { date: '2026-06-12', channelKey: 'known-kind-group', slotId: 'slot-explicit', start: 0, end: 10, messageIds: ['m1'] },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: false, exclusive: false })
  const explicitScanCount = unrelatedStatusScans

  for (let i = 0; i < 30; i += 1) {
    precomputeIndex.appendPrecomputeIndex({
      date: '2026-06-12',
      channelKey: 'known-kind-group',
      messageId: 'known-kind-msg-' + i,
      timestamp: 1749686400000 + i * 1000,
      userId: 'u' + (i % 3),
      text: 'known kind message ' + i,
    })
  }

  const retrySlotId = '0-19-known-kind-msg-0-known-kind-msg-19'
  const retryTaskId = buildDeterministicTaskId('2026-06-12', 'known-kind-group', retrySlotId)
  const retrySeed = submitDailyTask(retryTaskId, retrySlotId)
  taskStore.failTask(retrySeed.task, new Error('force failed for retry restore'), { reason: 'force failed for retry restore' })
  const failedBefore = taskStore.getResourceTaskById(retryTaskId)
  if (!failedBefore || failedBefore.status !== 'failed') throw new Error('expected failed retry seed before planner restore')
  const failedFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-workers', 'tasks', 'failed', retryTaskId + '.json')
  const failedPayload = JSON.parse(fs.readFileSync(failedFile, 'utf8'))
  failedPayload.retryAfter = new Date(Date.now() - 60 * 1000).toISOString()
  fs.writeFileSync(failedFile, JSON.stringify(failedPayload, null, 2))

  unrelatedStatusScans = 0
  const planned = planner.planDailySlotTasks('2026-06-12', 'known-kind-group', {
    source: 'resource-regression-known-kind',
    slotSize: 20,
    maxSlots: 4,
  })
  const plannerScanCount = unrelatedStatusScans

  console.log(JSON.stringify({
    explicitTaskId: explicit.task && explicit.task.id || '',
    explicitAgainTaskId: explicitAgain.task && explicitAgain.task.id || '',
    explicitAgainStatus: explicitAgain.task && explicitAgain.task.status || '',
    explicitScanCount,
    plannerScanCount,
    plannedCount: Array.isArray(planned) ? planned.length : -1,
    restoredCount: Array.isArray(planned) ? planned.filter(item => item && item.restored === true).length : -1,
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
  const summary = runScenario('task-store known-kind task lookup compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('known-kind explicit taskId dedupe should not scan unrelated task status dirs',
    summary.explicitTaskId === 'known-kind-explicit-task-1'
      && summary.explicitAgainTaskId === 'known-kind-explicit-task-1'
      && summary.explicitAgainStatus === 'pending'
      && summary.explicitScanCount === 0,
    JSON.stringify(summary))
  check('known-kind daily slot retry restore should not scan unrelated task status dirs',
    summary.plannedCount >= 1
      && summary.restoredCount >= 1
      && summary.plannerScanCount === 0,
    JSON.stringify(summary))
}

// === Scenario 56: 问题域 daily-report 本群未完成任务查重前门收口 ===
function testDailyReportOpenTaskLookupDoesNotMissUnderBacklogWindow() {
  const dataDir = createTempDataDir('resource-regress-daily-report-open-task-')
  const script = String.raw`
const Module = require('module')

let unrelatedPendingKindScans = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      listJsonFiles(root, options) {
        const rootText = String(root || '').replace(/\\/g, '/').toLowerCase()
        if (/\/resource-workers\/tasks\/pending\/agent_task(?:\/|$)/.test(rootText)) {
          unrelatedPendingKindScans += 1
        }
        return loaded.listJsonFiles(root, options)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')

function run() {
  taskStore.ensureTaskDirs()
  for (let i = 0; i < 1000; i += 1) {
    taskStore.submitResourceTask({
      id: 'daily-open-unrelated-agent-' + i,
      kind: 'agent_task',
      source: 'resource-regression-daily-open',
      channelKey: 'other-' + i,
      userId: 'user-' + i,
      priority: 10,
      payload: {},
      notify: { target: 'none', status: 'pending' },
    })
  }
  const target = taskStore.submitResourceTask({
    id: 'daily-open-target-task',
    kind: 'daily_report',
    source: 'resource-regression-daily-open',
    channelKey: 'target-daily-channel',
    userId: 'daily-user',
    priority: 90,
    payload: { detail: true },
    notify: { target: 'qq-group', channelKey: 'target-daily-channel', status: 'pending' },
  })
  taskStore.deferTask(target, 'forced deferred target')

  unrelatedPendingKindScans = 0
  const found = typeof taskStore.findResourceTaskByKindAndChannel === 'function'
    ? taskStore.findResourceTaskByKindAndChannel('daily_report', 'target-daily-channel', ['pending', 'claiming', 'running', 'deferred'])
    : null

  console.log(JSON.stringify({
    foundId: found && found.id || '',
    foundStatus: found && found.status || '',
    unrelatedPendingKindScans,
    hasHelper: typeof taskStore.findResourceTaskByKindAndChannel === 'function',
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
  const summary = runScenario('daily-report open task lookup backlog-window compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('daily-report open task lookup should find target beyond unrelated backlog window',
    summary.hasHelper === true
      && summary.foundId === 'daily-open-target-task'
      && summary.foundStatus === 'deferred',
    JSON.stringify(summary))
  check('daily-report open task lookup should not scan unrelated pending kind directories',
    summary.unrelatedPendingKindScans === 0,
    JSON.stringify(summary))
}

// === Scenario 55: 问题域 incoming-message-flow 入站语音 admission 不允许时不应先写 S6 pending ===
function testIncomingVoiceAdmissionGatesQueueWrite() {
  const script = String.raw`
const admissionPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const incomingPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/message/incoming-message-flow')
const originalAdmissionModule = require(admissionPath)

require.cache[admissionPath] = {
  id: admissionPath,
  filename: admissionPath,
  loaded: true,
  exports: {
    ...originalAdmissionModule,
    admitTask() {
      return {
        decision: process.env.FORCED_ADMISSION_DECISION || 'defer',
        reason: 'resource regression forced admission decision',
      }
    },
  },
}
delete require.cache[incomingPath]

const incomingFlow = require(incomingPath)
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')

async function run() {
  mediaQueue.ensureMediaDirs()
  const decision = String(process.env.FORCED_ADMISSION_DECISION || 'defer')
  const messageId = 'incoming-voice-admission-' + decision
  const plain = await incomingFlow.handleIncomingMessageArtifacts({
    ctx: null,
    session: {
      isDirect: true,
      userId: 'voice-user-1',
      channelId: 'private-voice-admission',
      messageId,
      event: {
        message: [
          {
            type: 'record',
            data: {
              url: 'https://example.test/' + decision + '.amr',
              file: 'voice-file-' + decision,
            },
          },
        ],
      },
    },
    analyzed: { hasAudio: true },
    plain: '',
    content: '',
    channelKey: 'private:voice-admission',
    directAt: false,
    queueMedia: true,
  })

  const pendingTasks = mediaQueue.listPendingMediaTasks('media_voice_transcription', 20)
  const status = mediaQueue.getMediaBackpressureStatus()
  console.log(JSON.stringify({
    plain,
    voicePending: status.voicePending,
    queuedMessageIds: pendingTasks.map(task => task.messageId),
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
  delete require.cache[incomingPath]
})
`

  const blockedSummary = runScenario('incoming voice frontdoor admission should block queue write when decision=defer', script, {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-regress-incoming-voice-defer-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    FORCED_ADMISSION_DECISION: 'defer',
  }, 30000)
  if (blockedSummary) {
    check('incoming voice defer should not enqueue media_voice_transcription pending task',
      blockedSummary.plain === '[语音消息]'
        && blockedSummary.voicePending === 0
        && !blockedSummary.queuedMessageIds.includes('incoming-voice-admission-defer'),
      JSON.stringify(blockedSummary))
  }

  const queuedSummary = runScenario('incoming voice frontdoor should still enqueue when decision=queue', script, {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-regress-incoming-voice-queue-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    FORCED_ADMISSION_DECISION: 'queue',
  }, 30000)
  if (queuedSummary) {
    check('incoming voice queue should preserve normal pending enqueue semantics',
      queuedSummary.plain === '[语音消息]'
        && queuedSummary.voicePending === 1
        && queuedSummary.queuedMessageIds.includes('incoming-voice-admission-queue'),
      JSON.stringify(queuedSummary))
  }
}

// === 问题域：显式媒体分析前门 admission 不允许时不应先写 S6 pending ===
function testExplicitMediaFrontdoorAdmissionGatesQueueWrite() {
  const script = String.raw`
const admissionPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const originalAdmissionModule = require(admissionPath)

function installAdmission(decision, resourceState, botMode, reason) {
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: {
      ...originalAdmissionModule,
      admitTask(input) {
        return {
          decision,
          reason: reason || 'forced explicit media admission',
          resourceState,
          botMode,
          budget: input,
        }
      },
    },
  }
}

function restoreAdmission() {
  require.cache[admissionPath] = {
    id: admissionPath,
    filename: admissionPath,
    loaded: true,
    exports: originalAdmissionModule,
  }
}

function reload(modulePath) {
  const resolved = require.resolve(modulePath)
  delete require.cache[resolved]
  return require(resolved)
}

function pending(kind) {
  const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
  return mediaQueue.listPendingMediaTasks(kind, 100).map(task => task.messageId)
}

async function seedVoice(channelKey, messageId) {
  const voiceStore = require('koishi-plugin-dongxuelian-ai/lib/media/voice/voice-store')
  await voiceStore.storeVoice(channelKey, messageId, {
    url: 'https://example.test/' + messageId + '.amr',
    file: 'voice-file-' + messageId,
    userId: 'voice-user-1',
  })
}

async function seedImage(channelKey, messageId) {
  const imageStore = require('koishi-plugin-dongxuelian-ai/lib/media/image/image-store')
  await imageStore.storeImageUrl(channelKey, messageId, 'https://example.test/' + messageId + '.jpg', '', {
    conversationKey: channelKey,
    userId: 'image-user-1',
  })
}

async function runFile(label, decision, resourceState, botMode, reason) {
  installAdmission(decision, resourceState, botMode, reason)
  const requests = reload('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-requests')
  const messageId = 'explicit-file-' + label
  const result = requests.queueFileAnalysisRequest({
    channelKey: 'explicit-file-frontdoor',
    messageId,
    url: 'https://example.test/' + label + '/file.txt',
    fileId: 'file-token',
    fileName: 'file.txt',
    userId: 'file-user-1',
    source: 'resource-regression-file',
  })
  return {
    messageId,
    pendingIds: pending('media_file_analysis'),
  }
}

async function runVoice(label, decision, resourceState, botMode, reason) {
  installAdmission(decision, resourceState, botMode, reason)
  const voiceQuickRead = reload('koishi-plugin-dongxuelian-ai/lib/routing/voice-quick-read')
  const channelKey = 'explicit-voice-frontdoor'
  const messageId = 'explicit-voice-' + label
  await seedVoice(channelKey, messageId)
  await voiceQuickRead.resolveVoiceQuickReadReply(channelKey, messageId)
  return {
    messageId,
    pendingIds: pending('media_voice_transcription'),
  }
}

async function runChatImage(label, decision, resourceState, botMode, reason) {
  installAdmission(decision, resourceState, botMode, reason)
  const chatTools = reload('koishi-plugin-dongxuelian-ai/lib/chat/chat-tools')
  const channelKey = 'explicit-chat-image-frontdoor'
  const messageId = 'explicit-chat-image-' + label
  await seedImage(channelKey, messageId)
  const reply = await chatTools.executeChatTool({
    function: {
      name: 'analyze_historical_image',
      arguments: JSON.stringify({ messageId }),
    },
  }, {
    channelKey,
    userId: 'image-user-1',
    tools: { analyze_historical_image: true, read_image_history: true },
  })
  void reply
  return {
    messageId,
    pendingIds: pending('media_image_analysis'),
  }
}

async function runAgentImage(label, decision, resourceState, botMode, reason) {
  installAdmission(decision, resourceState, botMode, reason)
  const analyzeImage = reload('koishi-plugin-dongxuelian-ai/lib/agent/tools/analyze-image')
  const messageId = 'explicit-agent-image-' + label
  await analyzeImage.execute({ url: 'https://example.test/' + messageId + '.jpg' }, {
    channelKey: 'explicit-agent-image-frontdoor',
    userId: 'image-user-1',
  })
  return {
    messageId,
    pendingEntries: pending('media_image_analysis').map(messageId => String(messageId)),
  }
}

async function run() {
  try {
    const blocked = {
      file: await runFile('red', 'defer', 'red', 'critical', 'media task deferred in red state'),
      voice: await runVoice('red', 'defer', 'red', 'critical', 'media task deferred in red state'),
      chatImage: await runChatImage('red', 'defer', 'red', 'critical', 'media task deferred in red state'),
      agentImage: await runAgentImage('red', 'defer', 'red', 'critical', 'media task deferred in red state'),
    }
    const reportSilent = {
      file: await runFile('report-silent', 'defer', 'green', 'report_silent', 'media drain paused during daily report'),
      voice: await runVoice('report-silent', 'defer', 'green', 'report_silent', 'media drain paused during daily report'),
      chatImage: await runChatImage('report-silent', 'defer', 'green', 'report_silent', 'media drain paused during daily report'),
      agentImage: await runAgentImage('report-silent', 'defer', 'green', 'report_silent', 'media drain paused during daily report'),
    }
    const reportSilentCritical = {
      file: await runFile('report-silent-critical', 'defer', 'red', 'report_silent', 'media drain paused during daily report'),
      voice: await runVoice('report-silent-critical', 'defer', 'red', 'report_silent', 'media drain paused during daily report'),
      chatImage: await runChatImage('report-silent-critical', 'defer', 'red', 'report_silent', 'media drain paused during daily report'),
      agentImage: await runAgentImage('report-silent-critical', 'defer', 'red', 'report_silent', 'media drain paused during daily report'),
    }
    const yellow = {
      file: await runFile('yellow', 'defer', 'yellow', 'normal', 'media is throttled in yellow state'),
      voice: await runVoice('yellow', 'defer', 'yellow', 'normal', 'media is throttled in yellow state'),
      chatImage: await runChatImage('yellow', 'defer', 'yellow', 'normal', 'media is throttled in yellow state'),
      agentImage: await runAgentImage('yellow', 'defer', 'yellow', 'normal', 'media is throttled in yellow state'),
    }
    const queued = {
      file: await runFile('queue', 'queue', 'green', 'normal', 'exclusive slot is busy'),
      voice: await runVoice('queue', 'queue', 'green', 'normal', 'exclusive slot is busy'),
      chatImage: await runChatImage('queue', 'queue', 'green', 'normal', 'exclusive slot is busy'),
      agentImage: await runAgentImage('queue', 'queue', 'green', 'normal', 'exclusive slot is busy'),
    }
    console.log(JSON.stringify({ blocked, reportSilent, reportSilentCritical, yellow, queued }, null, 2))
    process.exitCode = 0
  } finally {
    restoreAdmission()
  }
}

run().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`

  const summary = runScenario('explicit media frontdoor admission compatibility', script, {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-regress-explicit-media-frontdoor-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return

  check('explicit media red/critical defer should not enqueue new media pending tasks',
    !summary.blocked.file.pendingIds.includes(summary.blocked.file.messageId)
      && !summary.blocked.voice.pendingIds.includes(summary.blocked.voice.messageId)
      && !summary.blocked.chatImage.pendingIds.includes(summary.blocked.chatImage.messageId)
      && !summary.blocked.agentImage.pendingEntries.length,
    JSON.stringify(summary.blocked))
  check('explicit media report_silent defer should keep recoverable queued work',
    summary.reportSilent.file.pendingIds.includes(summary.reportSilent.file.messageId)
      && summary.reportSilent.voice.pendingIds.includes(summary.reportSilent.voice.messageId)
      && summary.reportSilent.chatImage.pendingIds.includes(summary.reportSilent.chatImage.messageId)
      && summary.reportSilent.agentImage.pendingEntries.length > 0,
    JSON.stringify(summary.reportSilent))
  check('explicit media report_silent defer should still block queue writes in red/critical state',
    !summary.reportSilentCritical.file.pendingIds.includes(summary.reportSilentCritical.file.messageId)
      && !summary.reportSilentCritical.voice.pendingIds.includes(summary.reportSilentCritical.voice.messageId)
      && !summary.reportSilentCritical.chatImage.pendingIds.includes(summary.reportSilentCritical.chatImage.messageId)
      && !summary.reportSilentCritical.agentImage.pendingEntries.includes(summary.reportSilentCritical.agentImage.messageId),
    JSON.stringify(summary.reportSilentCritical))
  check('explicit media yellow defer should keep recoverable queued work',
    summary.yellow.file.pendingIds.includes(summary.yellow.file.messageId)
      && summary.yellow.voice.pendingIds.includes(summary.yellow.voice.messageId)
      && summary.yellow.chatImage.pendingIds.includes(summary.yellow.chatImage.messageId)
      && summary.yellow.agentImage.pendingEntries.length > summary.reportSilent.agentImage.pendingEntries.length,
    JSON.stringify(summary.yellow))
  check('explicit media queue decision should preserve enqueue semantics',
    summary.queued.file.pendingIds.includes(summary.queued.file.messageId)
      && summary.queued.voice.pendingIds.includes(summary.queued.voice.messageId)
      && summary.queued.chatImage.pendingIds.includes(summary.queued.chatImage.messageId)
      && summary.queued.agentImage.pendingEntries.length > summary.yellow.agentImage.pendingEntries.length,
    JSON.stringify(summary.queued))
}

function main() {
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
  testExpressionHarvestDirectiveCompatibility()
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
  testNotifierWithoutSenderLeavesTaskUntouched()
  testNotifierFailedRetryHasCooldown()
  testNotifierPrivateTargetUsesPrivateSend()
  testNotifierDoesNotOverrideUsableSearchSuccess()
  testTaskStoreDoesNotCreateTargetCopyWhenRenameFails()
  testMarkTaskRunningDoesNotCreateRunningCopyWhenRenameFails()
  testCancelTaskDoesNotCreateCancelledCopyWhenRenameFails()
  testClaimDoesNotReclaimStalePendingWhenHigherRankCopyExists()
  testExecutionDoesNotContinueWhenTaskNeverEntersRunning()
  testSupervisorReplacesLivePidZombieWithStagnantLoop()
  testSupervisorReplacesLivePidZombieWhenOnlyLoopStallsAcrossFreshSupervisorWrites()
  testSupervisorDoesNotKillParkedWorker()
  testSupervisorDoesNotKillWorkerRunningLongTask()
  testSupervisorDoesNotKillIdleWorkerWithoutBacklog()
  testWorkerSelfExitsOnConsecutiveClaimFailures()
  testWorkerSelfExitThresholdFallsBackWhenConfiguredInvalid()
  testSupervisorDoesNotLeaveStaleClaimingResidue()
  testCanonicalTaskReadAndCancelSelection()
  testTransitionChainDoesNotMigrateFromStaleOrGuessedSource()
  testExplicitTaskIdResubmitDoesNotRecreatePendingOrEvents()
  testDeferredAuditDoesNotCountNoOpTransitions()
  testStaleRunningAuditDoesNotCountNoOpFailure()
  testRecordedCleanupDoesNotCountNoOpTerminateAsCompleted()
  testNotifierDoesNotCountNoOpNotifyWriteback()
  testNotifierFailedCooldownRefreshesAfterRepeatedFailure()
  testPlannerStopEventsAreDedupedAcrossTicks()
  testDailyPrecomputeSchedulerStopsBeforePerChannelScanWhenBacklogIsFull()
  testWorkerMainParksBeforeClaimWhenBackgroundDirectiveBlocks()
  testMediaQueueDoesNotRescanDeferredBacklogDuringCooldown()
  testDeferredAuditRestoresGraduallyWhenBacklogHasRecovered()
  testWorkerMainDoesNotReportWorkedWhenTaskOnlyDeferredOrRequeued()
  testMediaQueueEnqueueDoesNotDedupAgainstDoneHistoryWithoutCacheIndex()
  testMediaQueueCacheIndexIsTrimmedOnWrite()
  testPrecomputeCoverageAppendDoesNotRecomputeWhenSlotsUnchanged()
  testPlannerBacklogStopHappensBeforeReadingLaterChannelData()
  testTaskStoreCanonicalHotPathDoesNotScanTaskDirs()
  testMediaQueueEnqueueDoesNotScanOtherKindQueues()
  testClaimNextTaskDoesNotMissTargetKindWhenOtherKindsFillPendingWindow()
  testGetTaskQueueSummaryCountsWithoutReadingTaskJson()
  testCountResourceTasksByKindDoesNotReadUnrelatedTaskJson()
  testActiveTaskDedupeDoesNotMissTargetsWhenBacklogWindowIsFull()
  testAgentDeferredBacklogCapStopsMultiUserDeferredPileup()
  testAgentDeferredTasksStillCountAsActiveAtSubmissionFrontdoor()
  testAgentDeferredTaskExpiryReleasesFrontdoorBlock()
  testDeferredAuditDoesNotRewriteAdmissionForKeptDeferredTasks()
  testRecentFilesReadDoesNotRewriteHistoryWithoutActualCleanup()
  testFileFollowupGuardDoesNotReadHistoryForNonFileChat()
  testMediaQueueUnderLimitEnqueueDoesNotRereadKindJsonForQueueLimit()
  testResourceSnapshotReadDoesNotRewriteSchedulerStateWithoutActualChange()
  testResourceSnapshotHeartbeatOnlyChangeDoesNotRewriteSchedulerState()
  testKnownKindTaskLookupDoesNotScanUnrelatedStatuses()
  testDailyReportOpenTaskLookupDoesNotMissUnderBacklogWindow()
  testIncomingVoiceAdmissionGatesQueueWrite()
  testExplicitMediaFrontdoorAdmissionGatesQueueWrite()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
