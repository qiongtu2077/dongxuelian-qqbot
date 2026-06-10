/**
 * S0-S8 资源架构重整 — 阶段 0 止血回归测试。
 * 覆盖本次事故链的三处具体 bug（见 待完成与待审核任务/2026-06-10-S0-S8资源架构重整计划.md 9.13.2 阶段 0）：
 *   1. S2 result-notifier：同 taskId done/failed 双副本不再每轮 tick 重复写回 notify 状态。
 *   2. S3 daily-slot-planner：red/black/maintenance 下不 planning（planned=0）。
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

// === Scenario 2: S3 red/black/maintenance 下不 planning ===
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

  // 对照：green 内存下应能规划出 slot，证明跳过逻辑不是误杀。
  const dataDir2 = createTempDataDir('resource-regress-plan-green-')
  const summaryGreen = runScenario('S3 planner under green memory', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir2,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summaryGreen) return
  check('S3 planner still plans slots under green memory', summaryGreen.plannedCount > 0, JSON.stringify(summaryGreen))
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
  const decision2 = admission.admitTask(admissionInput)
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
    admissionEvents: admissions.filter(item => item.event === 'admission_decided' && item.taskId === 's1-dedup-task-1').length,
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
  process.memoryUsage = originalMemoryUsage
}
`
  const summary = runScenario('S8/S1 write dedupe scenario', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_DAILY_WORKER_RSS_MB: '128',
  }, 30000)
  if (!summary) return
  check('S1 admission duplicate decision writes only one event', summary.admissionEvents === 1, JSON.stringify(summary))
  check('S8 process metrics duplicate sample writes only one event', summary.processMetricsEvents === 1, JSON.stringify(summary))
  check('S8 memory_black duplicate alert writes only one event', summary.memoryBlackEvents === 1, JSON.stringify(summary))
  check('S8 worker memory duplicate alert writes only one event per file', summary.workerMemoryExceededEvents === 1 && summary.workerShouldExitEvents === 1, JSON.stringify(summary))
  check('S8 recorded cleanup without candidates does not write completed summary', summary.recordedCleanupCompletedEvents === 0, JSON.stringify(summary))
}

function main() {
  testNotifierNoDuplicateWriteback()
  testPlannerSkipsUnderPressure()
  testMediaWorkerNoBusyLoop()
  testResourceWriteDeduping()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
