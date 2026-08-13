const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

let passed = 0
let failed = 0

// --- Test Harness --- #

// Print a successful assertion.
function pass(label) {
  passed += 1
  console.log(`OK   ${label}`)
}

// Print a failed assertion and keep running to show all evidence.
function fail(label, detail) {
  failed += 1
  console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`)
}

// Assert a condition with a compact diagnostic message.
function check(label, ok, detail = '') {
  if (ok) pass(label)
  else fail(label, detail)
}

// Create an isolated runtime data directory for one child process.
function createTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Parse the JSON summary emitted by a child scenario.
function parseScenarioOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) throw new Error('child produced no stdout')
  const start = text.lastIndexOf('\n{')
  const jsonText = start >= 0 ? text.slice(start + 1) : text
  return JSON.parse(jsonText)
}

// Run one child scenario with env-derived DATA_DIR before requiring business modules.
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

// --- S2/S10 Flow Scenarios --- #

// Verify 今日情绪 submits image rendering to S2 and worker/notifier finish the result.
function testEmotionRenderWorkerFlow() {
  const dataDir = createTempDataDir('resource-flow-emotion-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function todayCst() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function main() {
  let renderCalls = 0
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized.endsWith('koishi-plugin-dongxuelian-ai/lib/behavior/emotion-renderer') || normalized.endsWith('koishi-plugin-dongxuelian-ai/src/behavior/emotion-renderer') || normalized.endsWith('../behavior/emotion-renderer')) {
      return {
        renderEmotionImageDirect: async () => {
          renderCalls += 1
          return Buffer.from('emotion-image-ok')
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const command = require('./packages/koishi-plugin-dongxuelian-ai/lib/commands/emotion-command')
  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const workerMain = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
  const resultNotifier = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const sent = []
  const logs = []
  const session = {
    async send(message) {
      sent.push(String(message))
      return true
    },
  }
  const ctx = {
    logger(name) {
      return {
        info: message => logs.push({ name, level: 'info', message: String(message) }),
        warn: message => logs.push({ name, level: 'warn', message: String(message) }),
        error: message => logs.push({ name, level: 'error', message: String(message) }),
      }
    },
  }

  let modelCalls = 0
  const channelKey = 'emotion-flow-group'
  const state = {
    plain: '今日情绪',
    inGuild: true,
    channelKey,
    channelTodayCache: new Map([[channelKey, {
      date: todayCst(),
      messages: [
        { time: '10:00:01', ts: Date.now(), user: 'Alice', userId: 'u1', content: '今天活动很热闹' },
        { time: '10:01:02', ts: Date.now(), user: 'Bob', userId: 'u2', content: '大家都在聊新版本' },
        { time: '10:02:03', ts: Date.now(), user: 'Alice', userId: 'u1', content: '气氛还不错' },
      ],
    }]]),
    lastEmotionCache: new Map(),
    async loadConfig() {},
    async callOpenAI(messages) {
      modelCalls += 1
      const prompt = messages.map(item => String(item.content || '')).join('\n')
      if (prompt.includes('只输出 JSON')) {
        return JSON.stringify({ score: 76, confidence: 84, mood: '偏乐观', summary: '讨论热度高，整体偏积极。', reasons: ['成员围绕新版本持续互动', '负面表达很少'], keywords: ['新版本', '活动'] })
      }
      return '新版本讨论多，互动热度高，整体偏积极。'
    },
  }

  const handled = await command.handleEmotionCommand(session, ctx, state)
  const pending = taskStore.listResourceTasks({ statuses: ['pending'], limit: 20 }).filter(task => task.kind === 'emotion_render')
  const task = pending[0] || null
  const worked = await workerMain.runWorkerTick({ type: 'daily', workerName: 'emotion-flow-worker', gateWaitMs: 1000 })
  const doneTask = task ? taskStore.getResourceTaskById(task.id) : null
  const resultFile = task ? path.join(taskPaths.getTaskResultDir(task.id), 'result.json') : ''
  const result = resultFile && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const imagePath = result && result.imagePath ? String(result.imagePath) : ''
  const imageExists = imagePath ? fs.existsSync(imagePath) && fs.statSync(imagePath).size > 0 : false

  const botSends = []
  const bot = {
    internal: {
      async sendGroupMsg(target, segments) {
        botSends.push({ target, segments })
        return true
      },
    },
  }
  const notifySummary = await resultNotifier.notifyCompletedTasks({
    limit: 10,
    sender: resultNotifier.createResourceResultSender({
      bot,
      logger: { info: message => logs.push({ level: 'info', message: String(message) }), warn: message => logs.push({ level: 'warn', message: String(message) }) },
    }),
  })
  const notifiedTask = task ? taskStore.getResourceTaskById(task.id) : null
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    handledMatched: handled && handled.matched,
    handledResponse: handled && String(handled.response || ''),
    thinkingSent: sent.includes('Thinking......'),
    modelCalls,
    pendingCount: pending.length,
    taskId: task && task.id,
    worked,
    doneStatus: doneTask && doneTask.status,
    resultMode: result && result.mode,
    imageExists,
    imageText: imageExists ? fs.readFileSync(imagePath).toString() : '',
    renderCalls,
    notifySent: notifySummary.sent,
    notifiedStatus: notifiedTask && notifiedTask.notify && notifiedTask.notify.status,
    botSendCount: botSends.length,
    botSendTarget: botSends[0] && botSends[0].target,
    botSendFirstType: botSends[0] && botSends[0].segments && botSends[0].segments[0] && botSends[0].segments[0].type,
    taskDoneEvents: workerEvents.filter(event => event.event === 'task_done' && task && event.taskId === task.id).length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.handledMatched === true
    && summary.thinkingSent === true
    && /图片版已加入后台队列/.test(summary.handledResponse)
    && summary.pendingCount === 1
    && worked === true
    && summary.doneStatus === 'done'
    && summary.resultMode === 'emotion_image'
    && summary.imageExists === true
    && summary.imageText === 'emotion-image-ok'
    && summary.renderCalls === 1
    && summary.notifySent === 1
    && summary.notifiedStatus === 'sent'
    && summary.botSendCount === 1
    && summary.botSendTarget === channelKey
    && summary.botSendFirstType === 'image'
    && summary.taskDoneEvents >= 1
    && summary.gateLocked === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 emotion render worker flow', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  check('emotion command submits one S2 render task', summary.pendingCount === 1 && /图片版已加入后台队列/.test(summary.handledResponse), JSON.stringify(summary))
  check('daily worker completes emotion render task', summary.worked === true && summary.doneStatus === 'done' && summary.resultMode === 'emotion_image', JSON.stringify(summary))
  check('emotion worker writes image artifact without main-process chromium', summary.renderCalls === 1 && summary.imageExists === true && summary.imageText === 'emotion-image-ok', JSON.stringify(summary))
  check('result notifier sends emotion image and marks sent', summary.notifySent === 1 && summary.notifiedStatus === 'sent' && summary.botSendFirstType === 'image', JSON.stringify(summary))
  check('emotion render releases S0 gate', summary.gateLocked === false, JSON.stringify(summary))
}

// Verify Dashboard auto-memory enters S2 and only the agent worker calls the LLM.
function testAgentMemoryWorkerFlow() {
  const dataDir = createTempDataDir('resource-flow-memory-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function main() {
  const modelCalls = []
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized.endsWith('/core/api') || normalized.endsWith('../core/api')) {
      return {
        requestChatCompletions: async messages => {
          modelCalls.push({ messages })
          return { type: 'text', content: '用户喜欢午后喝乌龙茶\n用户偏好简洁日报' }
        },
      }
    }
    if (normalized.endsWith('/core/runtime-config') || normalized.endsWith('../core/runtime-config')) {
      return {
        loadConfig: async () => ({ model: 'mock-memory-model', provider: 'mock', apiKey: 'mock-key', baseURL: 'http://mock.local/v1' }),
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const memoryWorker = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/memory-worker')
  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const workerMain = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const userId = 'dashboard-memory-user'
  const submission = memoryWorker.submitAgentMemoryTask({
    userId,
    source: 'resource-flow-test',
    recentMessages: [
      { role: 'user', content: '我下午一般喜欢喝乌龙茶，日报也别太长。' },
      { role: 'assistant', content: '记住了，我会尽量简洁。' },
      { role: 'user', content: '尤其是工作流总结，直接列重点。' },
      { role: 'assistant', content: '收到，后续会按重点整理。' },
    ],
  })
  const callsAfterSubmit = modelCalls.length
  const pending = taskStore.listResourceTasks({ statuses: ['pending'], limit: 20 }).filter(task => task.kind === 'agent_memory')
  const task = pending[0] || null
  const worked = await workerMain.runWorkerTick({ type: 'agent', workerName: 'memory-flow-worker', gateWaitMs: 1000 })
  const doneTask = task ? taskStore.getResourceTaskById(task.id) : null
  const resultFile = task ? path.join(taskPaths.getTaskResultDir(task.id), 'result.json') : ''
  const result = resultFile && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const dailyFiles = fs.existsSync(memoryWorker.DAILY_DIR) ? fs.readdirSync(memoryWorker.DAILY_DIR) : []
  const dailyContent = dailyFiles.map(file => fs.readFileSync(path.join(memoryWorker.DAILY_DIR, file), 'utf8')).join('\n')
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    accepted: submission.accepted,
    submissionStatus: submission.status,
    taskId: task && task.id,
    callsAfterSubmit,
    modelCalls: modelCalls.length,
    pendingCount: pending.length,
    worked,
    doneStatus: doneTask && doneTask.status,
    resultMode: result && result.mode,
    extracted: result && result.extracted,
    dailyFiles,
    dailyContent,
    taskDoneEvents: workerEvents.filter(event => event.event === 'task_done' && task && event.taskId === task.id).length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.accepted === true
    && summary.pendingCount === 1
    && summary.callsAfterSubmit === 0
    && worked === true
    && summary.doneStatus === 'done'
    && summary.resultMode === 'agent_memory'
    && summary.extracted === true
    && /乌龙茶/.test(summary.dailyContent)
    && /简洁日报/.test(summary.dailyContent)
    && summary.modelCalls === 1
    && summary.taskDoneEvents >= 1
    && summary.gateLocked === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 agent memory worker flow', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  check('auto-memory submitter only creates S2 task', summary.accepted === true && summary.pendingCount === 1 && summary.callsAfterSubmit === 0, JSON.stringify(summary))
  check('agent worker completes memory extraction task', summary.worked === true && summary.doneStatus === 'done' && summary.resultMode === 'agent_memory', JSON.stringify(summary))
  check('memory worker calls mocked LLM exactly once', summary.modelCalls === 1 && summary.extracted === true, JSON.stringify(summary))
  check('memory worker writes daily memory file', /乌龙茶/.test(summary.dailyContent) && /简洁日报/.test(summary.dailyContent), JSON.stringify(summary))
  check('memory extraction releases S0 gate', summary.gateLocked === false, JSON.stringify(summary))
}

// Verify Dream compaction is queued through S2 and writes long-term memory in the agent worker.
function testAgentMemoryCompactionWorkerFlow() {
  const dataDir = createTempDataDir('resource-flow-dream-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function main() {
  const modelCalls = []
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized.endsWith('/core/api') || normalized.endsWith('../core/api')) {
      return {
        requestChatCompletions: async messages => {
          modelCalls.push({ messages })
          return { type: 'text', content: '用户长期偏好：日报要短，工作流总结直接列重点。\n用户长期习惯：下午喝乌龙茶。' }
        },
      }
    }
    if (normalized.endsWith('/core/runtime-config') || normalized.endsWith('../core/runtime-config')) {
      return {
        loadConfig: async () => ({ model: 'mock-dream-model', provider: 'mock', apiKey: 'mock-key', baseURL: 'http://mock.local/v1' }),
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const memoryWorker = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/memory-worker')
  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const workerMain = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const userId = 'dashboard-dream-user'
  fs.mkdirSync(memoryWorker.DAILY_DIR, { recursive: true })
  fs.writeFileSync(path.join(memoryWorker.DAILY_DIR, memoryWorker.safeUserId(userId) + '.2026-06-07.md'), '[12:00] 用户喜欢午后喝乌龙茶。\n[12:01] 用户希望日报简短。\n', 'utf8')

  const submission = memoryWorker.submitAgentMemoryCompactionTask(userId, 'resource-flow-test')
  const callsAfterSubmit = modelCalls.length
  const pending = taskStore.listResourceTasks({ statuses: ['pending'], limit: 20 }).filter(task => task.kind === 'agent_memory_compaction')
  const task = pending[0] || null
  const worked = await workerMain.runWorkerTick({ type: 'agent', workerName: 'dream-flow-worker', gateWaitMs: 1000 })
  const doneTask = task ? taskStore.getResourceTaskById(task.id) : null
  const resultFile = task ? path.join(taskPaths.getTaskResultDir(task.id), 'result.json') : ''
  const result = resultFile && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const longTermFile = memoryWorker.getLongTermFile(userId)
  const longTermContent = fs.existsSync(longTermFile) ? fs.readFileSync(longTermFile, 'utf8') : ''
  const remainingDailyFiles = fs.existsSync(memoryWorker.DAILY_DIR) ? fs.readdirSync(memoryWorker.DAILY_DIR) : []
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    accepted: submission.accepted,
    submissionStatus: submission.status,
    taskId: task && task.id,
    callsAfterSubmit,
    modelCalls: modelCalls.length,
    pendingCount: pending.length,
    worked,
    doneStatus: doneTask && doneTask.status,
    resultMode: result && result.mode,
    success: result && result.success,
    deletedFiles: result && result.deletedFiles,
    longTermContent,
    remainingDailyFiles,
    taskDoneEvents: workerEvents.filter(event => event.event === 'task_done' && task && event.taskId === task.id).length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.accepted === true
    && summary.pendingCount === 1
    && summary.callsAfterSubmit === 0
    && worked === true
    && summary.doneStatus === 'done'
    && summary.resultMode === 'agent_memory_compaction'
    && summary.success === true
    && /乌龙茶/.test(summary.longTermContent)
    && /日报要短/.test(summary.longTermContent)
    && summary.remainingDailyFiles.length === 0
    && summary.modelCalls === 1
    && summary.taskDoneEvents >= 1
    && summary.gateLocked === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 agent memory compaction worker flow', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  check('dream submitter only creates S2 compaction task', summary.accepted === true && summary.pendingCount === 1 && summary.callsAfterSubmit === 0, JSON.stringify(summary))
  check('agent worker completes memory compaction task', summary.worked === true && summary.doneStatus === 'done' && summary.resultMode === 'agent_memory_compaction', JSON.stringify(summary))
  check('dream worker calls mocked LLM exactly once', summary.modelCalls === 1 && summary.success === true, JSON.stringify(summary))
  check('dream worker writes long-term memory and clears daily notes', /乌龙茶/.test(summary.longTermContent) && /日报要短/.test(summary.longTermContent) && summary.remainingDailyFiles.length === 0, JSON.stringify(summary))
  check('memory compaction releases S0 gate', summary.gateLocked === false, JSON.stringify(summary))
}

// Verify background conversation summary is submitted to S2 and written by the agent worker.
function testConversationSummaryWorkerFlow() {
  const dataDir = createTempDataDir('resource-flow-summary-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function main() {
  const modelCalls = []
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized.endsWith('/core/api') || normalized.endsWith('../core/api')) {
      return {
        requestChatCompletions: async messages => {
          modelCalls.push({ messages })
          return { type: 'text', content: '这段对话主要围绕资源调度、后台 worker 和日报保底展开，用户要求减少主进程重负载。' }
        },
      }
    }
    if (normalized.endsWith('/core/runtime-config') || normalized.endsWith('../core/runtime-config')) {
      return {
        loadConfig: async () => ({ model: 'mock-summary-model', provider: 'mock', apiKey: 'mock-key', baseURL: 'http://mock.local/v1' }),
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const conversation = require('./packages/koishi-plugin-dongxuelian-ai/lib/conversation')
  const submissionApi = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/background-llm-submission')
  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const workerMain = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const key = 'summary-flow-group::summary-user'
  const messages = []
  for (let i = 0; i < 72; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '轮：讨论资源调度和后台 worker', ts: Date.now() + i })
  }
  conversation.writeConversationDisk(key, { summary: '', summaryTotal: 0, totalCount: 72, messages })

  const submission = submissionApi.submitConversationSummaryTask({ key, source: 'resource-flow-test' })
  const callsAfterSubmit = modelCalls.length
  const pending = taskStore.listResourceTasks({ statuses: ['pending'], limit: 20 }).filter(task => task.kind === 'conversation_summary')
  const task = pending[0] || null
  const worked = await workerMain.runWorkerTick({ type: 'agent', workerName: 'summary-flow-worker', gateWaitMs: 1000 })
  const doneTask = task ? taskStore.getResourceTaskById(task.id) : null
  const resultFile = task ? path.join(taskPaths.getTaskResultDir(task.id), 'result.json') : ''
  const result = resultFile && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const disk = conversation.readConversationDisk(key)
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    accepted: submission.accepted,
    submissionStatus: submission.status,
    taskId: task && task.id,
    callsAfterSubmit,
    modelCalls: modelCalls.length,
    pendingCount: pending.length,
    worked,
    doneStatus: doneTask && doneTask.status,
    resultMode: result && result.mode,
    summarized: result && result.summarized,
    summaryTotal: result && result.summaryTotal,
    diskSummary: disk && disk.summary,
    diskSummaryTotal: disk && disk.summaryTotal,
    taskDoneEvents: workerEvents.filter(event => event.event === 'task_done' && task && event.taskId === task.id).length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.accepted === true
    && summary.pendingCount === 1
    && summary.callsAfterSubmit === 0
    && worked === true
    && summary.doneStatus === 'done'
    && summary.resultMode === 'conversation_summary'
    && summary.summarized === true
    && /后台 worker/.test(summary.diskSummary)
    && summary.diskSummaryTotal === 72
    && summary.modelCalls === 1
    && summary.taskDoneEvents >= 1
    && summary.gateLocked === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S2 conversation summary worker flow', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  check('conversation summary submitter only creates S2 task', summary.accepted === true && summary.pendingCount === 1 && summary.callsAfterSubmit === 0, JSON.stringify(summary))
  check('agent worker completes conversation summary task', summary.worked === true && summary.doneStatus === 'done' && summary.resultMode === 'conversation_summary', JSON.stringify(summary))
  check('background LLM worker calls mocked LLM exactly once', summary.modelCalls === 1 && summary.summarized === true, JSON.stringify(summary))
  check('background LLM worker writes conversation summary', /后台 worker/.test(summary.diskSummary) && summary.diskSummaryTotal === 72, JSON.stringify(summary))
  check('conversation summary releases S0 gate', summary.gateLocked === false, JSON.stringify(summary))
}

// Verify final-input reader uses the same sanitized date/channel path as the writer.
function testDailyFinalInputPathContract() {
  const dataDir = createTempDataDir('resource-flow-final-input-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')

async function main() {
  const precomputeIndex = require('./packages/koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-index')
  const slotWorker = require('./packages/koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-slot-worker')
  const summaryMerge = require('./packages/koishi-plugin-dongxuelian-ai/lib/daily-precompute/daily-summary-merge')
  const status = require('./packages/koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-status')
  const files = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-common/files')

  const date = '2026/06/09'
  const channelKey = 'group final/input test 中文'
  precomputeIndex.appendPrecomputeIndex({
    date,
    channelKey,
    messageId: 'msg-final-1',
    timestamp: Date.now(),
    userId: 'user-final',
    userName: 'Final Tester',
    text: '这条消息用于验证 final-input 读写路径一致。',
  })
  slotWorker.runDailySlotTask({
    id: 'slot final/input 1',
    channelKey,
    payload: { date, channelKey, slotId: 'slot final/input 1', messageIds: ['msg-final-1'] },
  })
  const written = summaryMerge.mergeDailyFinalInput(date, channelKey)
  const readBack = status.readDailyFinalInput(date, channelKey)
  const expectedFile = path.join(status.FINAL_INPUT_ROOT, files.sanitizeId(date), files.sanitizeId(channelKey) + '.json')
  const rawFile = path.join(status.FINAL_INPUT_ROOT, String(date), String(channelKey) + '.json')
  const summary = {
    writtenChannelKey: written && written.channelKey,
    readBackChannelKey: readBack && readBack.channelKey,
    readBackSlotCount: readBack && readBack.slotCount,
    expectedFileExists: fs.existsSync(expectedFile),
    rawFileExists: fs.existsSync(rawFile),
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.writtenChannelKey === channelKey
    && summary.readBackChannelKey === channelKey
    && summary.readBackSlotCount === 1
    && summary.expectedFileExists === true
    && summary.rawFileExists === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S3 daily final-input path contract', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  }, 15000)
  if (!summary) return
  check('daily final-input writer stores sanitized path only', summary.expectedFileExists === true && summary.rawFileExists === false, JSON.stringify(summary))
  check('daily final-input reader uses the writer path', summary.readBackChannelKey === 'group final/input test 中文' && summary.readBackSlotCount === 1, JSON.stringify(summary))
}

// analyze_historical_image must queue only when the explicit-media frontdoor policy allows it.
function testAnalyzeHistoricalImageAdmissionQueueContract() {
  const dataDir = createTempDataDir('resource-flow-image-admission-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')

function removeIfExists(file) {
  try { fs.unlinkSync(file) } catch {}
}

function tasksFor(mediaQueue, messageId) {
  return mediaQueue.listPendingMediaTasks('media_image_analysis', 200)
    .filter(task => task && task.messageId === messageId)
}

async function main() {
  const analyzeImage = require('./packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/analyze-image')
  const mediaQueue = require('./packages/koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
  const constants = require('./packages/koishi-plugin-dongxuelian-ai/lib/core/constants')
  const scenarios = [
    { name: 'normal', mem: '1200', maintenance: false },
    { name: 'yellow', mem: '400', maintenance: false },
    { name: 'yellowBelowBudget', mem: '399', maintenance: false },
    { name: 'red', mem: '299', maintenance: false },
    { name: 'maintenance', mem: '1200', maintenance: true },
  ]
  const results = []
  for (const scenario of scenarios) {
    process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = scenario.mem
    process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
    if (scenario.maintenance) {
      fs.mkdirSync(path.dirname(constants.MAINTENANCE_FILE), { recursive: true })
      fs.writeFileSync(constants.MAINTENANCE_FILE, 'maintenance', 'utf8')
    } else {
      removeIfExists(constants.MAINTENANCE_FILE)
    }
    const channelKey = 'image-admission-' + scenario.name
    const userId = 'image-user-' + scenario.name
    const messageId = 'image-msg-' + scenario.name
    const url = 'https://example.test/image-admission-' + scenario.name + '.png'
    const before = tasksFor(mediaQueue, messageId).length
    const response = await analyzeImage.execute({ url, messageId }, { channelKey, userId })
    const afterTasks = tasksFor(mediaQueue, messageId)
    const after = afterTasks.length
    const duplicateResponse = await analyzeImage.execute({ url, messageId }, { channelKey, userId })
    const afterDuplicate = tasksFor(mediaQueue, messageId).length
    results.push({
      name: scenario.name,
      before,
      after,
      afterDuplicate,
      response,
      duplicateResponse,
      task: afterTasks[0] || null,
    })
  }
  removeIfExists(constants.MAINTENANCE_FILE)
  console.log(JSON.stringify({ results }, null, 2))
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S6 analyze_historical_image admission queue contract', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  const byName = Object.fromEntries((summary.results || []).map(item => [item.name, item]))
  check('image tool queues exactly once in normal green state',
    byName.normal && byName.normal.after === byName.normal.before + 1 && byName.normal.afterDuplicate === byName.normal.after && /green/.test(byName.normal.response || '') && /media-worker/.test(byName.normal.response || ''),
    JSON.stringify(byName.normal))
  check('image tool queues exactly once when yellow media budget is met',
    byName.yellow && byName.yellow.after === byName.yellow.before + 1 && byName.yellow.afterDuplicate === byName.yellow.after && /yellow/.test(byName.yellow.response || '') && /media-worker/.test(byName.yellow.response || ''),
    JSON.stringify(byName.yellow))
  check('image tool does not queue below its 400MB budget in yellow',
    byName.yellowBelowBudget && byName.yellowBelowBudget.after === byName.yellowBelowBudget.before && byName.yellowBelowBudget.afterDuplicate === byName.yellowBelowBudget.after && /yellow/.test(byName.yellowBelowBudget.response || '') && /available memory is below task min memory budget/.test(byName.yellowBelowBudget.response || '') && /暂时不能加入图片分析队列/.test(byName.yellowBelowBudget.response || ''),
    JSON.stringify(byName.yellowBelowBudget))
  check('image tool does not queue while red admission defers',
    byName.red && byName.red.after === byName.red.before && byName.red.afterDuplicate === byName.red.after && /red/.test(byName.red.response || '') && /resource state red defers business task/.test(byName.red.response || '') && /暂时不能加入图片分析队列/.test(byName.red.response || ''),
    JSON.stringify(byName.red))
  check('image tool does not queue while maintenance admission rejects',
    byName.maintenance && byName.maintenance.after === byName.maintenance.before && byName.maintenance.afterDuplicate === byName.maintenance.after && /maintenance mode rejects heavy tasks/.test(byName.maintenance.response || '') && /暂时不能加入图片分析队列/.test(byName.maintenance.response || ''),
    JSON.stringify(byName.maintenance))
}

// Run all resource flow regression checks.
function main() {
  console.log('=== resource-flow S2/S10 tests ===')
  testEmotionRenderWorkerFlow()
  testAgentMemoryWorkerFlow()
  testAgentMemoryCompactionWorkerFlow()
  testConversationSummaryWorkerFlow()
  testDailyFinalInputPathContract()
  testAnalyzeHistoricalImageAdmissionQueueContract()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
