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

// Run one child scenario with fresh module cache and env-derived DATA_DIR.
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

// --- S8 Scenarios --- #

// Verify Windows taskkill fallback policy and result verification without real process termination.
function testWindowsTerminationFallbackPolicy() {
  const dataDir = createTempDataDir('s8-windows-termination-policy-')
  const script = String.raw`
const systemProtection = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')

// Build a deterministic Windows process runtime and retain every dangerous call.
function createRuntime(options = {}) {
  const alive = Array.isArray(options.alive) ? options.alive.slice() : [true]
  const calls = { taskkill: 0, alive: 0, kill: 0 }
  let lastAlive = alive.length ? !!alive[alive.length - 1] : true
  return {
    calls,
    runtime: {
      runTaskkill() {
        calls.taskkill += 1
        return {
          status: options.status === undefined ? 1 : options.status,
          signal: null,
          error: options.taskkillError || null,
          stdout: options.stdout || '',
          stderr: options.stderr || '',
        }
      },
      isPidAlive() {
        calls.alive += 1
        if (alive.length) lastAlive = !!alive.shift()
        return lastAlive
      },
      killPid() {
        calls.kill += 1
        if (options.killError) throw options.killError
      },
    },
  }
}

// Run one public terminateProcessTree case with an injected Windows runtime.
function runCase(pid, runtimeCase, options = {}) {
  const result = systemProtection.terminateProcessTree(pid, {
    reason: 'windows_fallback_policy_test',
    windowsRuntime: runtimeCase.runtime,
    ...options,
  })
  return { result, calls: runtimeCase.calls }
}

const taskkillSuccess = runCase(910001, createRuntime({ status: 0, alive: [true, false] }))
const taskkillNonzeroGone = runCase(910002, createRuntime({ status: 1, alive: [true, false], stderr: 'already gone' }))
const unauthorizedRuntime = createRuntime({ status: 1, alive: [true, true], stderr: 'taskkill failed' })
const unauthorized = runCase(910003, unauthorizedRuntime)
const fallbackSuccess = runCase(
  910004,
  createRuntime({ status: 1, alive: [true, true, false], stderr: 'taskkill failed' }),
  { allowSingleProcessFallback: true },
)
const fallbackStillAlive = runCase(
  910005,
  createRuntime({ status: 1, alive: [true, true, true], stderr: 'taskkill failed' }),
  { allowSingleProcessFallback: true },
)
const permissionError = new Error('operation not permitted')
permissionError.code = 'EPERM'
const fallbackDenied = runCase(
  910006,
  createRuntime({ status: 1, alive: [true, true, true], killError: permissionError }),
  { allowSingleProcessFallback: true },
)

const unsafeRuntime = createRuntime({ status: 1, alive: [true] })
const unsafePidOne = runCase(1, unsafeRuntime)
const unsafeCurrent = runCase(process.pid, unsafeRuntime)
const unsafeParent = runCase(process.ppid, unsafeRuntime)

systemProtection.writeProcessCleanupEvent({
  event: 'chromium_launched',
  taskId: 'recorded-fallback-policy-task',
  browserPid: 910007,
})
const recordedRuntime = createRuntime({ status: 1, alive: [true, true], stderr: 'recorded taskkill failed' })
const recorded = systemProtection.terminateRecordedProcessPids({
  taskId: 'recorded-fallback-policy-task',
  windowsRuntime: recordedRuntime.runtime,
})

console.log(JSON.stringify({
  taskkillSuccess,
  taskkillNonzeroGone,
  unauthorized,
  fallbackSuccess,
  fallbackStillAlive,
  fallbackDenied,
  unsafe: {
    pidOne: unsafePidOne.result,
    current: unsafeCurrent.result,
    parent: unsafeParent.result,
    calls: unsafeRuntime.calls,
  },
  recorded: { result: recorded, calls: recordedRuntime.calls },
}, null, 2))
`
  const summary = runScenario('S8 Windows termination fallback policy', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  })
  if (!summary) return

  check('taskkill success skips fallback and confirms tree termination',
    summary.taskkillSuccess.calls.kill === 0
      && summary.taskkillSuccess.result.treeTerminationConfirmed === true
      && summary.taskkillSuccess.result.event === 'process_tree_terminated',
    JSON.stringify(summary.taskkillSuccess))
  check('taskkill nonzero with exited root skips fallback without false failure',
    summary.taskkillNonzeroGone.calls.kill === 0
      && summary.taskkillNonzeroGone.result.treeTerminationConfirmed === false
      && summary.taskkillNonzeroGone.result.event === 'process_tree_terminated',
    JSON.stringify(summary.taskkillNonzeroGone))
  check('taskkill failure without ownership refuses single-process fallback',
    summary.unauthorized.calls.kill === 0
      && summary.unauthorized.result.event === 'process_tree_terminate_failed'
      && summary.unauthorized.result.error === 'single_process_fallback_not_authorized',
    JSON.stringify(summary.unauthorized))
  check('authorized fallback only succeeds after root exit verification',
    summary.fallbackSuccess.calls.kill === 1
      && summary.fallbackSuccess.result.event === 'process_tree_terminated'
      && summary.fallbackSuccess.result.fallbackScope === 'root_only'
      && summary.fallbackSuccess.result.aliveAfterFallback === false
      && summary.fallbackSuccess.result.killedPids.length === 1,
    JSON.stringify(summary.fallbackSuccess))
  check('authorized fallback does not report a still-alive root as killed',
    summary.fallbackStillAlive.calls.kill === 1
      && summary.fallbackStillAlive.result.event === 'process_tree_terminate_failed'
      && summary.fallbackStillAlive.result.aliveAfterFallback === true
      && summary.fallbackStillAlive.result.killedPids.length === 0,
    JSON.stringify(summary.fallbackStillAlive))
  check('fallback EPERM preserves error code and reports failure',
    summary.fallbackDenied.calls.kill === 1
      && summary.fallbackDenied.result.event === 'process_tree_terminate_failed'
      && summary.fallbackDenied.result.errorCode === 'EPERM'
      && summary.fallbackDenied.result.failedPids[0].errorCode === 'EPERM',
    JSON.stringify(summary.fallbackDenied))
  check('unsafe pids are rejected before any Windows runtime call',
    summary.unsafe.calls.taskkill === 0
      && summary.unsafe.calls.kill === 0
      && summary.unsafe.calls.alive === 0
      && summary.unsafe.pidOne.skippedReason === 'pid_le_1'
      && summary.unsafe.current.skippedReason === 'current_process'
      && summary.unsafe.parent.skippedReason === 'parent_process',
    JSON.stringify(summary.unsafe))
  check('recorded historical pid never receives single-process fallback authorization',
    summary.recorded.calls.taskkill === 1
      && summary.recorded.calls.kill === 0
      && summary.recorded.result.event === 'recorded_process_cleanup_skipped',
    JSON.stringify(summary.recorded))
}

// Verify worker fallback authorization follows the live ChildProcess handle lifecycle.
function testWorkerFallbackOwnership() {
  const dataDir = createTempDataDir('s8-worker-fallback-ownership-')
  const script = String.raw`
const Module = require('module')
const { EventEmitter } = require('events')
const realChildProcess = require('child_process')

class FakeChildProcess extends EventEmitter {
  // Build a live ChildProcess-compatible test handle.
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
  }

  // Match ChildProcess.unref without changing test process lifetime.
  unref() {}
}

const fakeChildren = []
const terminateCalls = []
let nextPid = 920001

// Return a new owned worker handle for each supervisor spawn.
function fakeSpawn() {
  const child = new FakeChildProcess(nextPid++)
  fakeChildren.push(child)
  return child
}

const originalLoad = Module._load
let supervisor
try {
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized === 'child_process') return { ...realChildProcess, spawn: fakeSpawn }
    if (normalized === '../resource-system/system-protection' || normalized.endsWith('/resource-system/system-protection')) {
      return {
        writeProcessCleanupEvent: () => {},
        terminateProcessTree(pid, options = {}) {
          terminateCalls.push({ pid: Number(pid), allow: options.allowSingleProcessFallback === true })
          return { event: 'process_tree_terminated', killedPids: [Number(pid)], failedPids: [] }
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  supervisor = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
} finally {
  Module._load = originalLoad
}

const started = supervisor.startWorkerProcess('daily', 'generation-a')
const ownedPid = Number(started.pid)
supervisor.recoverZombieWorker({ name: 'daily-worker', pid: ownedPid, kind: 'daily' })
supervisor.recoverZombieWorker({ name: 'daily-worker', pid: ownedPid + 100, kind: 'daily' })
fakeChildren[0].exitCode = 0
fakeChildren[0].emit('exit', 0, null)
supervisor.recoverZombieWorker({ name: 'daily-worker', pid: ownedPid, kind: 'daily' })
const restarted = supervisor.startWorkerProcess('daily')
supervisor.clearOwnedWorkerProcesses()
supervisor.recoverZombieWorker({ name: 'daily-worker', pid: Number(restarted.pid), kind: 'daily' })

console.log(JSON.stringify({ ownedPid, restartedPid: restarted.pid, terminateCalls, startedGeneration: started.generation, startedToken: started.startToken, startedArgs: started.args }, null, 2))
`
  const summary = runScenario('S8 worker fallback ownership', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
  })
  if (!summary) return
  check('worker live owned handle authorizes fallback',
    summary.terminateCalls[0].pid === summary.ownedPid && summary.terminateCalls[0].allow === true,
    JSON.stringify(summary))
  check('worker launch carries generation and one-time start token',
    summary.startedGeneration === 'generation-a'
      && typeof summary.startedToken === 'string'
      && summary.startedToken.startsWith('generation-a-daily-')
      && summary.startedArgs.includes('--generation')
      && summary.startedArgs.includes('--start-token'),
    JSON.stringify(summary))
  check('worker mismatched pid does not authorize fallback',
    summary.terminateCalls[1].allow === false,
    JSON.stringify(summary))
  check('worker exited handle does not authorize fallback',
    summary.terminateCalls[2].allow === false,
    JSON.stringify(summary))
  check('worker ownership map clear revokes fallback authorization',
    summary.terminateCalls[3].pid === Number(summary.restartedPid) && summary.terminateCalls[3].allow === false,
    JSON.stringify(summary))
}

// Verify browser fallback authorization requires the same live process handle at close time.
function testBrowserFallbackOwnership() {
  const dataDir = createTempDataDir('s8-browser-fallback-ownership-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

// Create the minimum page surface required by browser_action startup and close.
function createPage() {
  return {
    on: () => {},
    setRequestInterception: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => null,
    setUserAgent: async () => {},
    setViewport: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    url: () => 'about:blank',
    close: async () => {},
  }
}

const fakeBrowserPath = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'fake-chromium.exe')
fs.writeFileSync(fakeBrowserPath, '')
process.env.DONGXUELIAN_BROWSER_PATH = fakeBrowserPath
const browserStates = []
const terminateCalls = []
let nextPid = 930001

// Create a browser whose process handle can disappear before close.
function createBrowser() {
  const state = {
    exposeProcess: true,
    child: { pid: nextPid++, exitCode: null, signalCode: null },
    processCalls: 0,
    closeCalls: 0,
  }
  browserStates.push(state)
  return {
    process: () => {
      state.processCalls += 1
      return state.exposeProcess ? state.child : null
    },
    newPage: async () => createPage(),
    close: async () => {
      state.closeCalls += 1
      throw new Error('mock browser close failed')
    },
  }
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const normalized = String(request || '').replace(/\\/g, '/')
  if (normalized === 'puppeteer-core') return { launch: async () => createBrowser() }
  if (normalized.endsWith('/resource-scheduler/admission') || normalized.includes('resource-scheduler/admission')) {
    return {
      admitTask: () => ({ decision: 'run_now', reason: 'test-allow', resourceState: 'green', botMode: 'normal', memAvailableMb: 1600 }),
    }
  }
  if (normalized.endsWith('/resource-system/system-protection') || normalized.includes('resource-system/system-protection')) {
    return {
      writeProcessCleanupEvent: () => {},
      terminateProcessTree(pid, options = {}) {
        terminateCalls.push({ pid: Number(pid), allow: options.allowSingleProcessFallback === true })
        return { event: 'process_tree_terminated', killedPids: [Number(pid)], failedPids: [] }
      },
    }
  }
  return originalLoad.apply(this, arguments)
}

async function main() {
  const browserAction = require('./packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
  await browserAction.execute({ action: 'start' }, { userId: 'owned-browser', channelKey: 'owned-browser', taskId: 'owned-browser' })
  await browserAction.execute({ action: 'close' }, { userId: 'owned-browser', channelKey: 'owned-browser', taskId: 'owned-browser' })

  await browserAction.execute({ action: 'start' }, { userId: 'lost-browser', channelKey: 'lost-browser', taskId: 'lost-browser' })
  browserStates[1].exposeProcess = false
  await browserAction.execute({ action: 'close' }, { userId: 'lost-browser', channelKey: 'lost-browser', taskId: 'lost-browser' })

  console.log(JSON.stringify({ browserStates, terminateCalls }, null, 2))
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S8 browser fallback ownership', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '1',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('browser live matching handle authorizes fallback',
    summary.terminateCalls[0].pid === summary.browserStates[0].child.pid && summary.terminateCalls[0].allow === true,
    JSON.stringify(summary))
  check('browser missing close-time handle does not authorize fallback',
    summary.terminateCalls[1]?.pid === summary.browserStates[1]?.child?.pid && summary.terminateCalls[1]?.allow === false,
    JSON.stringify(summary))
}

// Verify worker timeout writes S8/S2 evidence and releases S0.
function testWorkerTimeoutInjection() {
  const dataDir = createTempDataDir('s8-worker-timeout-test-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { spawn } = require('child_process')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

async function main() {
  let fakeChromiumProcess = null
  let fakeChromiumPid = null
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\/g, '/')
    if (normalized.endsWith('koishi-plugin-daily-report/lib/report-pipeline') || normalized.endsWith('koishi-plugin-daily-report/src/report-pipeline')) {
      return {
        generateDailyReportResult: async (options = {}) => {
          fakeChromiumProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          fakeChromiumPid = fakeChromiumProcess.pid
          const protection = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')
          protection.writeProcessCleanupEvent({
            event: 'daily_chromium_launched',
            source: 'daily_report_render',
            taskId: String(options.taskId || 's8-timeout-daily'),
            browserPid: fakeChromiumPid,
          })
          return new Promise(() => {})
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const workerMain = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
  const systemProtection = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const task = taskStore.submitResourceTask({
    id: 's8-timeout-daily',
    kind: 'daily_report',
    source: 's8-timeout-injection-test',
    channelKey: 's8-timeout-group',
    userId: 's8-tester',
    priority: 1,
    timeoutMs: 1,
    payload: { detail: false, renderImage: false },
    notify: { target: 'none', status: 'pending' },
  })

  const startedAt = Date.now()
  const worked = await workerMain.runWorkerTick({ type: 'daily', workerName: 's8-timeout-worker', gateWaitMs: 1000 })
  const elapsedMs = Date.now() - startedAt
  await sleep(500)
  const fakeAliveAfterTimeout = fakeChromiumPid ? isPidAlive(fakeChromiumPid) : null
  if (fakeAliveAfterTimeout) {
    try { process.kill(fakeChromiumPid, 'SIGKILL') } catch {}
  }
  const observedExitCode = process.exitCode || 0
  const failedTask = taskStore.getResourceTaskById(task.id)
  const resultFile = path.join(taskPaths.getTaskResultDir(task.id), 'result.json')
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const status = systemProtection.getSystemProtectionStatus()
  const cleanupEvents = Array.isArray(status.cleanupEvents) ? status.cleanupEvents : []
  const timeoutEvents = cleanupEvents.filter(event => event.event === 'task_timed_out' && event.taskId === task.id && event.workerName === 's8-timeout-worker')
  const processTreeTerminated = cleanupEvents.filter(event => event.event === 'process_tree_terminated' && Number(event.rootPid) === Number(fakeChromiumPid))
  const recordedCleanup = cleanupEvents.filter(event => event.event === 'recorded_process_cleanup_completed' && event.taskId === task.id)
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const taskFailedEvents = workerEvents.filter(event => event.event === 'task_failed' && event.taskId === task.id)
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    worked,
    elapsedMs,
    fakeChromiumPid,
    fakeAliveAfterTimeout,
    observedExitCode,
    taskStatus: failedTask && failedTask.status,
    taskStep: failedTask && failedTask.step,
    taskError: failedTask && failedTask.error,
    resultOk: result && result.ok,
    resultError: result && result.error,
    timeoutEventCount: timeoutEvents.length,
    processTreeTerminatedCount: processTreeTerminated.length,
    recordedCleanupCount: recordedCleanup.length,
    taskFailedEventCount: taskFailedEvents.length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = worked === true
    && elapsedMs >= 9500
    && observedExitCode === 76
    && failedTask && failedTask.status === 'failed'
    && result && result.ok === false
    && /timed out/i.test(String(result.error || failedTask.error || ''))
    && timeoutEvents.length >= 1
    && fakeChromiumPid
    && fakeAliveAfterTimeout === false
    && processTreeTerminated.length >= 1
    && recordedCleanup.length >= 1
    && taskFailedEvents.length >= 1
    && gateStatus.locked === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S8 worker timeout injection', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 30000)
  if (!summary) return
  check('worker timeout observed exit code 76', summary.observedExitCode === 76, JSON.stringify(summary))
  check('worker timeout failed task and released gate', summary.taskStatus === 'failed' && summary.gateLocked === false, JSON.stringify(summary))
  check('worker timeout wrote cleanup event', summary.timeoutEventCount >= 1, JSON.stringify(summary))
  check('worker timeout terminates recorded chromium child process', summary.processTreeTerminatedCount >= 1 && summary.fakeAliveAfterTimeout === false, JSON.stringify(summary))
}

// Verify agent worker timeout exits the standalone worker before late engine side effects can land.
function testAgentWorkerTimeoutStopsLateSideEffects() {
  const dataDir = createTempDataDir('s8-agent-worker-timeout-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const hookFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'agent-worker-timeout-hook.js')
  const engineStartedFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'engine-started.txt')
  const lateSideEffectFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'late-side-effect.txt')
  const hookSource = [
    "const fs = require('fs')",
    "const path = require('path')",
    "const Module = require('module')",
    "const startedFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'engine-started.txt')",
    "const lateFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'late-side-effect.txt')",
    "const originalLoad = Module._load",
    "Module._load = function patchedLoad(request, parent, isMain) {",
    "  const normalized = String(request || '').replace(/\\\\\\\\/g, '/')",
    "  if (normalized.endsWith('/agent/engine') || normalized.endsWith('../agent/engine')) {",
    "    return {",
    "      run: async () => {",
    "        fs.writeFileSync(startedFile, 'started', 'utf8')",
    "        await new Promise(resolve => setTimeout(resolve, 10200))",
    "        fs.writeFileSync(lateFile, 'late side effect', 'utf8')",
    "        return { reply: 'late reply' }",
    "      },",
    "      resumePending: async () => {",
    "        fs.writeFileSync(startedFile, 'resume', 'utf8')",
    "        await new Promise(resolve => setTimeout(resolve, 10200))",
    "        fs.writeFileSync(lateFile, 'late side effect', 'utf8')",
    "        return { reply: 'late resume' }",
    "      },",
    "    }",
    "  }",
    "  return originalLoad.apply(this, arguments)",
    "}",
    "",
  ].join('\n')
  fs.writeFileSync(hookFile, hookSource, 'utf8')

  const taskStore = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const taskPaths = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
  const payloads = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/agent-payload')
  const resourceGate = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

  const task = taskStore.submitResourceTask({
    id: 's8-timeout-agent-worker',
    kind: 'agent_task',
    source: 's8-timeout-agent-worker-test',
    channelKey: 's8-agent-timeout-group',
    userId: 's8-agent-timeout-user',
    priority: 1,
    timeoutMs: 1,
    payload: {
      entry: 's8-timeout-agent-worker-test',
      agentWorker: payloads.createAgentRunWorkerPayload('s8-timeout-agent-worker-test', {
        userMessage: '请执行一个会超时的 agent 任务',
        userName: 'S8 Tester',
        userId: 's8-agent-timeout-user',
        channelKey: 's8-agent-timeout-group',
        channel: 'qq',
      }),
    },
    notify: { target: 'none', status: 'pending' },
  })

  const workerEntry = path.join(process.cwd(), 'packages/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main.js')
  const child = spawnSync(process.execPath, [workerEntry, '--type', 'agent', '--once'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
      RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
      RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
      RESOURCE_WORKER_RSS_MB: '2048',
      NODE_OPTIONS: '--require=' + hookFile,
    },
    encoding: 'utf8',
    timeout: 30000,
  })

  await sleep(700)
  const taskAfter = taskStore.getResourceTaskById(task.id)
  const resultFile = path.join(taskPaths.getTaskResultDir(task.id), 'result.json')
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  const workerEvents = readJsonl(taskPaths.getWorkerEventFile())
  const taskFailedEvents = workerEvents.filter(event => event.event === 'task_failed' && event.taskId === task.id)
  const taskDoneEvents = workerEvents.filter(event => event.event === 'task_done' && event.taskId === task.id)
  const gateStatus = resourceGate.getResourceGateStatus()
  const summary = {
    childStatus: child.status,
    childSignal: child.signal,
    childStdoutTail: String(child.stdout || '').slice(-1000),
    childStderrTail: String(child.stderr || '').slice(-1000),
    engineStarted: fs.existsSync(engineStartedFile),
    sideEffectExists: fs.existsSync(lateSideEffectFile),
    taskStatus: taskAfter && taskAfter.status,
    taskStep: taskAfter && taskAfter.step,
    taskError: taskAfter && taskAfter.error,
    resultOk: result && result.ok,
    resultError: result && result.error,
    taskFailedEventCount: taskFailedEvents.length,
    taskDoneEventCount: taskDoneEvents.length,
    gateLocked: gateStatus.locked,
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = summary.childStatus === 76
    && summary.engineStarted === true
    && summary.taskStatus === 'failed'
    && /timed out/i.test(String(summary.resultError || summary.taskError || ''))
    && summary.taskFailedEventCount >= 1
    && summary.taskDoneEventCount === 0
    && summary.gateLocked === false
    && summary.sideEffectExists === false
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S8 agent worker timeout stops late side effects', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
    RESOURCE_WORKER_RSS_MB: '2048',
  }, 40000)
  if (!summary) return
  check('agent worker timeout actually starts engine before timeout', summary.engineStarted === true, JSON.stringify(summary))
  check('agent worker timeout exits with 76 and marks task failed', summary.childStatus === 76 && summary.taskStatus === 'failed' && /timed out/i.test(String(summary.resultError || summary.taskError || '')), JSON.stringify(summary))
  check('agent worker timeout emits failed but no done event and releases gate', summary.taskFailedEventCount >= 1 && summary.taskDoneEventCount === 0 && summary.gateLocked === false, JSON.stringify(summary))
  check('agent worker timeout prevents late side effects after worker exit', summary.sideEffectExists === false, JSON.stringify(summary))
}

// Verify browser close failures are recorded as S8 cleanup events.
function testChromiumCloseFailureInjection() {
  const dataDir = createTempDataDir('s8-chromium-close-test-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { spawn } = require('child_process')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

async function main() {
  const fakeBrowserPath = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'fake-chromium.exe')
  fs.writeFileSync(fakeBrowserPath, '')
  process.env.DONGXUELIAN_BROWSER_PATH = fakeBrowserPath
  let fakeChromiumProcess = null

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (String(request || '') === 'puppeteer-core') {
      const page = {
        isClosed: () => false,
        on: () => {},
        setUserAgent: async () => {},
        setViewport: async () => {},
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        url: () => 'about:blank',
        close: async () => { throw new Error('mock page close failed') },
      }
      const browser = {
        process: () => fakeChromiumProcess,
        newPage: async () => page,
        close: async () => { throw new Error('mock browser close failed') },
      }
      return {
        launch: async () => {
          fakeChromiumProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          return browser
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  const browserAction = require('./packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
  const systemProtection = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection')
  const startResult = await browserAction.execute({ action: 'start' }, { userId: 's8-user', channelKey: 's8-channel', taskId: 's8-browser-task' })
  const fakePid = fakeChromiumProcess && fakeChromiumProcess.pid
  const closeResult = await browserAction.execute({ action: 'close' }, { userId: 's8-user', channelKey: 's8-channel', taskId: 's8-browser-task' })
  await sleep(500)
  const fakeAliveAfterClose = fakePid ? isPidAlive(fakePid) : null
  if (fakeAliveAfterClose) {
    try { process.kill(fakePid, 'SIGKILL') } catch {}
  }
  const status = systemProtection.getSystemProtectionStatus()
  const cleanupEvents = Array.isArray(status.cleanupEvents) ? status.cleanupEvents : []
  const launched = cleanupEvents.filter(event => event.event === 'chromium_launched')
  const pageCloseFailed = cleanupEvents.filter(event => event.event === 'chromium_page_close_failed' && String(event.error || '').includes('mock page close failed'))
  const browserCloseFailed = cleanupEvents.filter(event => event.event === 'chromium_close_failed' && String(event.error || '').includes('mock browser close failed'))
  const processTreeTerminated = cleanupEvents.filter(event => event.event === 'process_tree_terminated' && Number(event.rootPid) === Number(fakePid))
  const summary = {
    startResult,
    closeResult,
    fakePid,
    fakeAliveAfterClose,
    launchedCount: launched.length,
    pageCloseFailedCount: pageCloseFailed.length,
    browserCloseFailedCount: browserCloseFailed.length,
    processTreeTerminatedCount: processTreeTerminated.length,
    cleanupEventNames: cleanupEvents.map(event => event.event).slice(-6),
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok = /启动/.test(startResult)
    && /关闭/.test(closeResult)
    && fakePid
    && fakeAliveAfterClose === false
    && launched.length >= 1
    && pageCloseFailed.length >= 1
    && browserCloseFailed.length >= 1
    && processTreeTerminated.length >= 1
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S8 chromium close failure injection', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '1',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('chromium close failure wrote page event', summary.pageCloseFailedCount >= 1, JSON.stringify(summary))
  check('chromium close failure wrote browser event', summary.browserCloseFailedCount >= 1, JSON.stringify(summary))
  check('chromium close failure terminates recorded child process', summary.processTreeTerminatedCount >= 1 && summary.fakeAliveAfterClose === false, JSON.stringify(summary))
}

// Verify browser_action rebuilds the entire browser context on session switch.
function testBrowserSessionSwitchIsolation() {
  const dataDir = createTempDataDir('s8-browser-session-switch-')
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')

function makePage(browserState, id) {
  let closed = false
  let currentUrl = 'about:blank'
  let currentTitle = 'tab-' + id
  const api = {
    __id: id,
    isClosed: () => closed,
    close: async () => {
      if (closed) return
      closed = true
      browserState.pages = browserState.pages.filter(page => page !== api)
    },
    on: () => {},
    setRequestInterception: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => null,
    setUserAgent: async () => {},
    setViewport: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    url: () => currentUrl,
    title: async () => currentTitle,
    goto: async (url) => {
      currentUrl = String(url || '')
      currentTitle = currentUrl === 'about:blank'
        ? 'blank'
        : currentUrl.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
      return null
    },
    cookies: async () => browserState.cookies.map(cookie => ({ ...cookie })),
    setCookie: async (cookie) => {
      browserState.cookies = browserState.cookies.filter(item => !(item.name === cookie.name && item.url === cookie.url))
      browserState.cookies.push({ ...cookie })
    },
    deleteCookie: async (...cookies) => {
      const blocked = new Set(cookies.map(cookie => cookie.name + '|' + String(cookie.url || '') + '|' + String(cookie.domain || '') + '|' + String(cookie.path || '')))
      browserState.cookies = browserState.cookies.filter(cookie => !blocked.has(cookie.name + '|' + String(cookie.url || '') + '|' + String(cookie.domain || '') + '|' + String(cookie.path || '')))
    },
    context: () => ({
      clearCookies: async () => { browserState.cookies = [] },
    }),
  }
  return api
}

function createBrowserState() {
  return {
    pages: [],
    cookies: [],
    closed: false,
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
  const launchedBrowsers = []
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request || '').replace(/\\\\/g, '/')
    if (normalized === 'puppeteer-core') {
      return {
        launch: async () => {
          const browserState = createBrowserState()
          const browser = createBrowser(browserState)
          launchedBrowsers.push(browserState)
          return browser
        },
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

  const browserAction = require('./packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
  const sessionA = { userId: 'session-a-user', channelKey: 'session-a-channel', taskId: 'browser-l32-a' }
  const sessionB = { userId: 'session-b-user', channelKey: 'session-b-channel', taskId: 'browser-l32-b' }

  await browserAction.execute({ action: 'start' }, sessionA)
  await browserAction.execute({ action: 'navigate', url: 'https://session-a-root.example/path' }, sessionA)
  await browserAction.execute({ action: 'new_tab' }, sessionA)
  await browserAction.execute({ action: 'navigate', url: 'https://session-a-extra.example/next' }, sessionA)
  await browserAction.execute({ action: 'cookies_set', name: 'sessionA', value: 'cookie-a' }, sessionA)

  const tabsA = JSON.parse(await browserAction.execute({ action: 'tabs' }, sessionA))
  const switchA = await browserAction.execute({ action: 'switch_tab', index: 1 }, sessionA)
  const cookiesA = JSON.parse(await browserAction.execute({ action: 'cookies_get' }, sessionA))

  const tabsB = JSON.parse(await browserAction.execute({ action: 'tabs' }, sessionB))
  const cookiesB = JSON.parse(await browserAction.execute({ action: 'cookies_get' }, sessionB))
  let switchBError = ''
  try {
    await browserAction.execute({ action: 'switch_tab', index: 1 }, sessionB)
  } catch (error) {
    switchBError = String(error && error.message || error)
  }
  await browserAction.execute({ action: 'new_tab' }, sessionB)
  const tabsBAfterNewTab = JSON.parse(await browserAction.execute({ action: 'tabs' }, sessionB))
  await browserAction.execute({ action: 'close' }, sessionB)

  const summary = {
    launchCount: launchedBrowsers.length,
    tabsA,
    switchA,
    cookiesA,
    tabsB,
    cookiesB,
    switchBError,
    tabsBAfterNewTab,
    browserPageCounts: launchedBrowsers.map(item => item.pages.length),
    browserClosedStates: launchedBrowsers.map(item => item.closed),
  }
  console.log(JSON.stringify(summary, null, 2))
  const hasSessionARoot = tabsA.some(item => String(item.url || '').includes('session-a-root.example'))
  const hasSessionAExtra = tabsA.some(item => String(item.url || '').includes('session-a-extra.example'))
  const sessionBSeesA = tabsB.some(item => String(item.url || '').includes('session-a-root.example') || String(item.url || '').includes('session-a-extra.example'))
  const ok = launchedBrowsers.length >= 2
    && tabsA.length === 2
    && hasSessionARoot
    && hasSessionAExtra
    && String(switchA).includes('session-a-extra.example')
    && cookiesA.some(item => item.name === 'sessionA')
    && tabsB.length === 1
    && sessionBSeesA === false
    && cookiesB.length === 0
    && /tab index/i.test(switchBError)
    && tabsBAfterNewTab.length === 2
    && launchedBrowsers[0] && launchedBrowsers[0].closed === true
  process.exitCode = ok ? 0 : 1
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
`
  const summary = runScenario('S8 browser session switch isolation', script, {
    DONGXUELIAN_AI_DATA_DIR: dataDir,
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '1',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  }, 30000)
  if (!summary) return
  check('browser session A keeps same-session extra tabs', summary.tabsA.length === 2, JSON.stringify(summary))
  check('browser session B does not inherit session A tabs', summary.tabsB.length === 1 && !summary.tabsB.some(item => String(item.url || '').includes('session-a-')), JSON.stringify(summary))
  check('browser session switch clears old cookies with rebuilt context', Array.isArray(summary.cookiesB) && summary.cookiesB.length === 0, JSON.stringify(summary))
  check('browser session B cannot switch to session A extra tab index', /tab index/i.test(String(summary.switchBError || '')), JSON.stringify(summary))
  check('browser session B can still create its own new tab after rebuild', summary.tabsBAfterNewTab.length === 2, JSON.stringify(summary))
}

// Run all resource-system regression checks.
function main() {
  console.log('=== resource-system S8 tests ===')
  testWindowsTerminationFallbackPolicy()
  testWorkerFallbackOwnership()
  testBrowserFallbackOwnership()
  testWorkerTimeoutInjection()
  testAgentWorkerTimeoutStopsLateSideEffects()
  testChromiumCloseFailureInjection()
  testBrowserSessionSwitchIsolation()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
