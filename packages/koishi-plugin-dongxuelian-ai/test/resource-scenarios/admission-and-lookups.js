'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

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
  check('agent deferred/backlog should still allow the first two distinct users to materialize deferred placeholders under red memory',
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
  check('D.45 first agent submission may still materialize one deferred task under red memory',
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
  check('D.46 fixture should start from one deferred agent task that blocks a same-user resubmit under red memory',
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
  check('deferred audit/write amplification fixture should keep the deferred agent task in place under red memory',
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
    summary.thirdState === 'red'
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

// 运行队列查重、已知 kind 查找、deferred 前门和媒体准入场景。
function runAdmissionAndLookupScenarios() {
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
}

module.exports = { runAdmissionAndLookupScenarios }
