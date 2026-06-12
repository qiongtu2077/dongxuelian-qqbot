const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

let passed = 0
let failed = 0

function pass(label) {
  passed += 1
  console.log(`OK   ${label}`)
}

function fail(label, detail) {
  failed += 1
  console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`)
}

function check(label, ok, detail = '') {
  if (ok) pass(label)
  else fail(label, detail)
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
    fail(`${label} output is JSON`, error instanceof Error ? error.message : String(error))
    return null
  }
}

function testLoopStressBoundedGrowth() {
  const dataDir = createTempDataDir('resource-loop-stress-')
  const script = String.raw`
const fs = require('fs')
const Module = require('module')

let mediaRecursiveScans = 0
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\\\/g, '/')
  const loaded = originalLoad.apply(this, arguments)
  if (normalized.endsWith('/resource-common/files') || normalized.includes('resource-common/files')) {
    return {
      ...loaded,
      listJsonFiles(root, options) {
        const rootText = String(root || '').replace(/\\\\/g, '/').toLowerCase()
        if (options && options.recursive && rootText.includes('media')) mediaRecursiveScans += 1
        return loaded.listJsonFiles(root, options)
      },
    }
  }
  return loaded
}

const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const taskPaths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const precomputeIndex = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
const startupSchedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
const mediaQueue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const mediaWorker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')
const admission = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const systemProtection = require('koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function createCtx() {
  return {
    logger() {
      return {
        info() {},
        warn() {},
      }
    },
  }
}

async function main() {
  taskStore.ensureTaskDirs()
  mediaQueue.ensureMediaDirs()

  const duplicateTaskId = 'loop-stress-daily-summary-dup-1'
  const duplicateKind = 'daily_summary'
  const duplicateBase = {
    id: duplicateTaskId,
    kind: duplicateKind,
    source: 'resource-loop-stress',
    channelKey: '',
    userId: '',
    priority: 70,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    expiresAt: '',
    timeoutMs: 120000,
    payload: {},
  }
  const doneFile = taskPaths.getTaskFile('done', duplicateKind, duplicateTaskId)
  const failedFile = taskPaths.getTaskFile('failed', duplicateKind, duplicateTaskId)
  fs.writeFileSync(doneFile, JSON.stringify({ ...duplicateBase, status: 'done', notify: { target: 'none', status: 'pending' } }))
  fs.writeFileSync(failedFile, JSON.stringify({ ...duplicateBase, status: 'failed', notify: { target: 'none', status: 'pending' } }))

  const date = '2026-06-11'
  const channelKey = 'loop-stress-group'
  for (let i = 0; i < 160; i += 1) {
    precomputeIndex.appendPrecomputeIndex({
      date,
      channelKey,
      messageId: 'loop-stress-msg-' + i,
      timestamp: 1749600000000 + i * 1000,
      userId: 'u' + (i % 5),
      text: 'loop stress message ' + i,
    })
  }

  const mediaTask = mediaQueue.enqueueMediaTask({
    kind: 'media_image_analysis',
    channelKey: 'loop-stress-media',
    messageId: 'loop-stress-media-msg',
    url: 'https://example.test/loop-stress-media.png',
  })

  // 只统计正式压力循环期间的递归扫盘，避免把建夹具阶段的队列探测计进来。
  mediaRecursiveScans = 0

  const rssSamplesMb = [Math.round(process.memoryUsage().rss / 1024 / 1024)]
  const planningSummaries = []
  const mediaWorkedResults = []
  const LOOP_TICKS = 12
  for (let i = 0; i < LOOP_TICKS; i += 1) {
    const planning = await startupSchedulers.runDailyPrecomputePlanningTick(createCtx())
    planningSummaries.push(planning)
    const mediaWorked = await mediaWorker.drainOneMediaTask({ workerName: 'loop-stress-media-worker', gateWaitMs: 1000 })
    mediaWorkedResults.push(mediaWorked)
    await notifier.notifyCompletedTasks({ limit: 100 })
    systemProtection.collectProcessMetrics({ workerName: 'loop-stress-worker', workerType: 'stress' })
    rssSamplesMb.push(Math.round(process.memoryUsage().rss / 1024 / 1024))
  }

  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const admissionEvents = readJsonl(admission.admissionEventFile())
  const systemStatus = systemProtection.getSystemProtectionStatus()
  const mediaStatus = mediaQueue.getMediaBackpressureStatus()
  const plannerEvents = readJsonl(precomputeIndex.precomputeEventFile())

  const notifyUpdatedCount = workerEvents.filter(event =>
    event.event === 'task_notify_updated'
    && event.taskId === duplicateTaskId
  ).length
  const mediaAdmissionCount = admissionEvents.filter(event =>
    event.event === 'admission_decided'
    && event.taskId === mediaTask.id
  ).length
  const processMetricsCount = (systemStatus.processMetrics || []).filter(event =>
    event.event === 'process_metrics'
    && event.workerName === 'loop-stress-worker'
  ).length
  const memoryBlackCount = (systemStatus.memoryAlerts || []).filter(event =>
    event.event === 'memory_black'
  ).length
  const plannerSkippedEvents = plannerEvents.filter(event =>
    event.event === 'daily_slot_planning_skipped'
    && event.channelKey === channelKey
  ).length
  const rssMinMb = Math.min(...rssSamplesMb)
  const rssMaxMb = Math.max(...rssSamplesMb)
  const rssDeltaMb = rssMaxMb - rssMinMb

  console.log(JSON.stringify({
    loopTicks: LOOP_TICKS,
    planningPlannedCounts: planningSummaries.map(item => item.planned),
    planningParkedCount: planningSummaries.filter(item => item.parked === true).length,
    plannerSkippedEvents,
    mediaWorkedResults,
    mediaPending: mediaStatus.imagePending,
    mediaRecursiveScans,
    mediaAdmissionCount,
    notifyUpdatedCount,
    processMetricsCount,
    memoryBlackCount,
    rssSamplesMb,
    rssMinMb,
    rssMaxMb,
    rssDeltaMb,
  }, null, 2))
  process.exitCode = 0
}

main().catch(error => {
  Module._load = originalLoad
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('resource loop-stress bounded growth', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '50',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return

  check(
    'loop-stress keeps S3 planning at 0 across repeated black-memory ticks',
    Array.isArray(summary.planningPlannedCounts)
      && summary.planningPlannedCounts.length === summary.loopTicks
      && summary.planningPlannedCounts.every(count => count === 0),
    JSON.stringify(summary)
  )
  check(
    'loop-stress keeps media worker parked instead of claim/admit self-rotation',
    Array.isArray(summary.mediaWorkedResults)
      && summary.mediaWorkedResults.length === summary.loopTicks
      && summary.mediaWorkedResults.every(value => value === false)
      && summary.mediaAdmissionCount === 0
      && summary.mediaRecursiveScans === 0
      && summary.mediaPending === 1,
    JSON.stringify(summary)
  )
  check(
    'loop-stress keeps duplicate notifier writeback bounded to one task_notify_updated',
    summary.notifyUpdatedCount === 1,
    JSON.stringify(summary)
  )
  check(
    'loop-stress keeps S8 metrics and memory-black events bounded under repeated ticks',
    summary.processMetricsCount <= 2
      && summary.memoryBlackCount <= 2,
    JSON.stringify(summary)
  )
  check(
    'loop-stress temp DATA_DIR run keeps local RSS drift within bounded budget',
    typeof summary.rssDeltaMb === 'number'
      && summary.rssDeltaMb <= 128,
    JSON.stringify(summary)
  )
}

function main() {
  console.log('=== resource loop-stress tests ===')
  testLoopStressBoundedGrowth()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
