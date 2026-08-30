'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

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

// 运行通知、任务迁移、claim 和 supervisor 状态机场景。
function runTaskStateAndSupervisorScenarios() {
  testNotifierWithoutSenderLeavesTaskUntouched()
  testNotifierFailedRetryHasCooldown()
  testNotifierPrivateTargetUsesPrivateSend()
  testNotifierDoesNotOverrideUsableSearchSuccess()
  testNotifierSkipsPlaceholderEmptyAgentReply()
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
}

module.exports = { runTaskStateAndSupervisorScenarios }
