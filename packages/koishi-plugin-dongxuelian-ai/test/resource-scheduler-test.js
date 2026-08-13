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
function runScenario(label, env, timeoutMs = 15000) {
const script = String.raw`
const { readResourceSnapshot } = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-snapshot')
const { admitTask } = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const { decideModePolicy } = require('./packages/koishi-plugin-dongxuelian-ai/lib/bot-mode/mode-policy')
const { decideEntryDirective, decideTaskDirective } = require('./packages/koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-directive')

const snapshot = readResourceSnapshot()
const dailyAdmission = admitTask({
  kind: 'daily_report',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const browserAdmission = admitTask({
  kind: 'browser_action',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const videoAdmission = admitTask({
  kind: 'external_video_download',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const mediaAdmission = admitTask({
  kind: 'media_image_analysis',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const normalChatAdmission = admitTask({
  kind: 'normal_chat',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const normalPolicy = decideModePolicy('normal_chat', snapshot)
const agentPolicy = decideModePolicy('agent_command', snapshot)
const interactivePolicy = decideModePolicy('interactive_chat', snapshot)
const normalDirective = decideEntryDirective('normal_chat', snapshot)
const agentDirective = decideEntryDirective('agent_command', snapshot)
const interactiveDirective = decideEntryDirective('interactive_chat', snapshot)
const dailyDirective = decideTaskDirective({
  kind: 'daily_report',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
}, snapshot)
const browserDirective = decideTaskDirective({
  kind: 'browser_action',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
}, snapshot)
const summary = {
  resourceState: snapshot.resourceState,
  botMode: snapshot.botMode,
  memAvailableMb: snapshot.memAvailableMb,
  memTotalMb: snapshot.memTotalMb,
  dailyDecision: dailyAdmission.decision,
  dailyFallback: dailyAdmission.fallback || '',
  browserDecision: browserAdmission.decision,
  videoDecision: videoAdmission.decision,
  mediaDecision: mediaAdmission.decision,
  normalChatDecision: normalChatAdmission.decision,
  normalPolicyAction: normalPolicy.action,
  agentPolicyAction: agentPolicy.action,
  interactivePolicyAction: interactivePolicy.action,
  normalDirectiveAction: normalDirective.directive.action,
  normalDirectiveReason: normalDirective.directive.reason,
  agentDirectiveAction: agentDirective.directive.action,
  interactiveDirectiveAction: interactiveDirective.directive.action,
  dailyDirectiveAction: dailyDirective.directive.action,
  dailyDirectiveFallback: dailyDirective.directive.fallback || '',
  browserDirectiveAction: browserDirective.directive.action,
}
console.log(JSON.stringify(summary, null, 2))
`
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

// --- S1 Scenarios --- #

// Verify 299 MB enters red and pauses every business task.
function testRedMemoryAdmission() {
  const summary = runScenario('S1 red memory injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-red-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '299',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('299MB injection reports red critical snapshot', summary.resourceState === 'red' && summary.botMode === 'critical' && summary.memAvailableMb === 299, JSON.stringify(summary))
  check('red injection defers daily report without fallback execution', summary.dailyDecision === 'defer' && summary.dailyFallback === '', JSON.stringify(summary))
  check('red injection defers browser action', summary.browserDecision === 'defer', JSON.stringify(summary))
  check('red injection rejects video before probe or download', summary.videoDecision === 'reject', JSON.stringify(summary))
  check('red injection defers media', summary.mediaDecision === 'defer', JSON.stringify(summary))
  check('red injection silences normal chat', summary.normalChatDecision === 'silent_drop' && summary.normalPolicyAction === 'silent_drop', JSON.stringify(summary))
  check('red injection returns resource notices for explicit Agent and chat entries', summary.agentPolicyAction === 'resource_notice' && summary.interactivePolicyAction === 'resource_notice', JSON.stringify(summary))
  check('red injection entry directive matches mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction && summary.interactiveDirectiveAction === summary.interactivePolicyAction, JSON.stringify(summary))
  check('red injection task directive matches admission', summary.dailyDirectiveAction === summary.dailyDecision && summary.dailyDirectiveFallback === summary.dailyFallback && summary.browserDirectiveAction === summary.browserDecision, JSON.stringify(summary))
}

// Verify 300 MB is the yellow boundary and task-specific budgets still apply.
function testYellowMemoryAdmission() {
  const summary = runScenario('S1 yellow memory injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-yellow-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '300',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('300MB injection reports yellow normal snapshot', summary.resourceState === 'yellow' && summary.botMode === 'normal' && summary.memAvailableMb === 300, JSON.stringify(summary))
  check('yellow injection downgrades daily below task budget', summary.dailyDecision === 'downgrade' && summary.dailyFallback === 'daily_report_text', JSON.stringify(summary))
  check('yellow injection defers browser below task budget', summary.browserDecision === 'defer', JSON.stringify(summary))
  check('yellow injection allows video at its 300MB boundary', summary.videoDecision === 'run_now', JSON.stringify(summary))
  check('yellow injection defers media below its 400MB task budget', summary.mediaDecision === 'defer', JSON.stringify(summary))
  check('yellow injection allows normal chat policy', summary.normalChatDecision === 'run_now' && summary.normalPolicyAction === 'pass', JSON.stringify(summary))
  check('yellow injection entry directive matches legacy mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction, JSON.stringify(summary))
  check('yellow injection task directive matches admission', summary.dailyDirectiveAction === 'downgrade' && summary.dailyDirectiveFallback === summary.dailyFallback && summary.browserDirectiveAction === summary.browserDecision, JSON.stringify(summary))
}

// Verify task thresholds at 400 MB allow daily and media but still defer browser.
function testTaskBudgetAdmission() {
  const summary = runScenario('S1 task budget injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-task-budget-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '400',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('400MB remains yellow', summary.resourceState === 'yellow' && summary.memAvailableMb === 400, JSON.stringify(summary))
  check('400MB allows daily, video, and media budgets', summary.dailyDecision === 'run_now' && summary.videoDecision === 'run_now' && summary.mediaDecision === 'run_now', JSON.stringify(summary))
  check('400MB still defers the 500MB browser budget', summary.browserDecision === 'defer', JSON.stringify(summary))
}

// Verify all state and browser boundaries without any recovery delay.
function testImmediateStateAndBrowserBoundaries() {
  const snapshot = require('../lib/resource-scheduler/resource-snapshot')
  const states = [299, 300, 599, 600].map(value => snapshot.classifyResourceState(value))
  check('299/300/599/600MB map to red/yellow/yellow/green', JSON.stringify(states) === JSON.stringify(['red', 'yellow', 'yellow', 'green']), JSON.stringify(states))

  const below = runScenario('S1 browser 499MB injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-browser-499-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '499',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  const boundary = runScenario('S1 browser 500MB injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-browser-500-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '500',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  check('browser rejects at 499MB and runs at 500MB', below?.browserDecision === 'defer' && boundary?.browserDecision === 'run_now', JSON.stringify({ below, boundary }))
}

// Verify the full registered budget table and direct-call overrides stay aligned.
function testRegisteredBudgetsAndDirectOverrides() {
  const { normalizeTaskBudget } = require('../lib/resource-scheduler/task-budget')
  const expected = {
    daily_report: 400,
    daily_report_render: 600,
    daily_summary: 300,
    agent_task: 400,
    dashboard_agent: 300,
    agent_memory: 300,
    agent_memory_compaction: 300,
    expression_harvest: 400,
    conversation_summary: 300,
    sensitive_cache_analysis: 400,
    emotion_render: 400,
    browser_action: 500,
    voice_tts_generation: 400,
    diagnostic_probe: 300,
    mcp_local_check: 600,
    external_video_download: 300,
    pet_bridge_chat: 600,
    media_image_analysis: 400,
    media_file_analysis: 400,
    media_voice_transcription: 400,
    normal_chat: 300,
    status_query: 0,
  }
  const actual = Object.fromEntries(Object.keys(expected).map(kind => [kind, normalizeTaskBudget({ kind }).minMemMb]))
  check('all registered task budgets match the plan table', JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual))
  check('future unknown task kinds keep the explicit 600MB fallback', normalizeTaskBudget({ kind: 'future_unknown_task' }).minMemMb === 600)

  const root = path.resolve(__dirname, '..', '..', '..')
  const agentExecution = fs.readFileSync(path.join(root, 'packages', 'koishi-plugin-dongxuelian-ai', 'src', 'agent', 'resource-execution.ts'), 'utf8')
  const emotionRenderer = fs.readFileSync(path.join(root, 'packages', 'koishi-plugin-dongxuelian-ai', 'src', 'behavior', 'emotion-renderer.ts'), 'utf8')
  const dailyReport = fs.readFileSync(path.join(root, 'packages', 'koishi-plugin-daily-report', 'src', 'index.ts'), 'utf8')
  check('agent and dashboard submissions no longer override the registered budget', !/minMemMb\s*:/.test(agentExecution))
  check('emotion renderer direct override is 400MB', /source:\s*['"]emotion-renderer['"][\s\S]{0,250}minMemMb:\s*400/.test(emotionRenderer))
  check('daily report direct override is 400MB', /kind:\s*['"]daily_report['"][\s\S]{0,350}minMemMb:\s*400/.test(dailyReport))
  check('daily_report_render is not submitted as an independent resource task', !/kind:\s*['"]daily_report_render['"]/.test(dailyReport))
}

// Verify browser startup guard defaults and explicit environment bounds in fresh processes.
function testBrowserStartupMemoryGuard() {
  const script = String.raw`
const browserAction = require('./packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action')
let result = 'pass'
try { browserAction.assertEnoughMemoryForBrowser() } catch (error) { result = String(error && error.message || error) }
console.log(JSON.stringify({ min: browserAction.BROWSER_MIN_AVAILABLE_MB, result }))
`
  const runBrowserGuard = (label, env) => {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      env: { ...process.env, DONGXUELIAN_BROWSER_FORCE: '', ...env },
      encoding: 'utf8',
      timeout: 15000,
    })
    check(`${label} exits 0`, result.status === 0, String(result.stderr || result.stdout))
    return result.status === 0 ? JSON.parse(String(result.stdout).trim()) : null
  }
  const below = runBrowserGuard('browser startup guard 499MB', {
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '499',
  })
  const boundary = runBrowserGuard('browser startup guard 500MB', {
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '500',
  })
  const lowerBound = runBrowserGuard('browser startup guard env lower bound', {
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '1',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '8192',
  })
  const upperBound = runBrowserGuard('browser startup guard env upper bound', {
    DONGXUELIAN_BROWSER_MIN_MEM_MB: '99999',
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '8192',
  })
  check('browser startup guard defaults to 500MB and rejects 499MB', below?.min === 500 && /需要至少 500MB/.test(below.result), JSON.stringify(below))
  check('browser startup guard passes at 500MB', boundary?.min === 500 && boundary.result === 'pass', JSON.stringify(boundary))
  check('browser startup guard clamps explicit env to 256–8192MB', lowerBound?.min === 256 && upperBound?.min === 8192, JSON.stringify({ lowerBound, upperBound }))
}

function runModeScenario(label, env, timeoutMs = 15000) {
  const script = String.raw`
const fs = require('fs')
const path = require('path')
const snapshot = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-snapshot')
const serverMode = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/server-mode-policy')
const backgroundDirective = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/background-directive')
const activityLease = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const supervisor = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-supervisor')
const workerMain = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')

const defaultSnapshot = snapshot.readResourceSnapshot()
const modeFile = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-control', 'config.json')
serverMode.writeServerModeConfig('small', { updatedBy: 'resource-scheduler-test' })
const defaultModeState = serverMode.readServerModeState({
  resourceState: 'green',
  maintenance: false,
  toolActive: false,
  renderActive: false,
})
taskStore.submitResourceTask({
  id: 'resource-scheduler-agent-backlog',
  kind: 'agent_task',
  source: 'resource-scheduler-test',
  channelKey: 'global',
  userId: '',
  payload: {},
  notify: { target: 'none', status: 'pending' },
})
taskStore.submitResourceTask({
  id: 'resource-scheduler-daily-backlog',
  kind: 'daily_report',
  source: 'resource-scheduler-test',
  channelKey: 'global',
  userId: '',
  payload: {},
  notify: { target: 'none', status: 'pending' },
})
const selectedSmallWorker = supervisor.selectWorkerTypesToStart(['agent', 'daily', 'media'], new Set(), {
  serverMode: 'small',
  resourceState: 'yellow',
  backgroundAllowed: true,
})
const selectedWhileActive = supervisor.selectWorkerTypesToStart(['agent', 'daily', 'media'], new Set(['daily-worker']), {
  serverMode: 'small',
  resourceState: 'yellow',
  backgroundAllowed: true,
})
const selectedUnderRed = supervisor.selectWorkerTypesToStart(['agent', 'daily', 'media'], new Set(), {
  serverMode: 'small',
  resourceState: 'red',
  backgroundAllowed: false,
})
const idleSinceAt = new Date(Date.now() - 60000).toISOString()
const managedIdleExit = workerMain.shouldExitManagedWorker({ type: 'agent', ownerGeneration: 'generation-a', startToken: 'token-a', idleExitMs: 30000 }, idleSinceAt)
const unmanagedIdleExit = workerMain.shouldExitManagedWorker({ type: 'agent', idleExitMs: 30000 }, idleSinceAt)
const releaseRender = activityLease.acquireResourceActivityLease('render_active', {
  owner: 'resource-scheduler-test',
  taskId: 'resource-scheduler-mode-render',
  ttlMs: 5000,
})
try {
  const modeSnapshot = snapshot.readResourceSnapshot()
  const parked = backgroundDirective.decideBackgroundDirective({
    kind: 'expression_harvest',
    source: 'resource-scheduler-test',
    channelKey: 'global',
    userId: '',
    priority: 40,
    exclusive: true,
    timeoutMs: 120000,
    queueTimeoutMs: 120000,
    runTimeoutMs: 120000,
  }, modeSnapshot)
  console.log(JSON.stringify({
    defaultSnapshot,
    defaultModeState,
    modeSnapshot,
    parkedAction: parked.directive.action,
    parkedReason: parked.directive.reason,
    selectedSmallWorker,
    selectedWhileActive,
    selectedUnderRed,
    managedIdleExit,
    unmanagedIdleExit,
    modeFileExists: fs.existsSync(modeFile),
  }, null, 2))
  process.exitCode = 0
} finally {
  releaseRender('resource-scheduler-test-finally')
}
`
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

function testServerModeSnapshotAndBackgroundAllowed() {
  const summary = runModeScenario('server mode snapshot and background allowed', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-scheduler-mode-'),
  })
  if (!summary) return
  check('server mode defaults to large before config exists',
    summary.defaultSnapshot && summary.defaultSnapshot.serverMode === 'large' && summary.defaultSnapshot.backgroundAllowed === true,
    JSON.stringify(summary.defaultSnapshot))
  check('server mode config round-trips through config file and write helper',
    summary.defaultModeState && summary.defaultModeState.serverMode === 'small' && summary.defaultModeState.serverModeSource === 'resource-control/config.json',
    JSON.stringify(summary.defaultModeState))
  check('render_active lease forces background_allowed false in small mode',
    summary.modeSnapshot && summary.modeSnapshot.serverMode === 'small'
      && summary.modeSnapshot.renderActive === true
      && summary.modeSnapshot.backgroundAllowed === false,
    JSON.stringify(summary.modeSnapshot))
  check('small mode background directive parks expression harvest while render_active is held',
    summary.parkedAction === 'park' && /render_active|background|资源保护/i.test(String(summary.parkedReason || '')),
    JSON.stringify({ parkedAction: summary.parkedAction, parkedReason: summary.parkedReason }))
  check('small mode selects only the highest-priority backlog worker',
    Array.isArray(summary.selectedSmallWorker) && summary.selectedSmallWorker.length === 1 && summary.selectedSmallWorker[0] === 'agent',
    JSON.stringify(summary.selectedSmallWorker))
  check('small mode starts no second worker while one is active or while red',
    summary.selectedWhileActive.length === 0 && summary.selectedUnderRed.length === 0,
    JSON.stringify({ active: summary.selectedWhileActive, red: summary.selectedUnderRed }))
  check('only generation-owned small workers exit after the idle grace',
    summary.managedIdleExit === true && summary.unmanagedIdleExit === false,
    JSON.stringify({ managed: summary.managedIdleExit, unmanaged: summary.unmanagedIdleExit }))
}

// Run all resource-scheduler regression checks.
function main() {
  console.log('=== resource-scheduler S1 tests ===')
  testRedMemoryAdmission()
  testYellowMemoryAdmission()
  testTaskBudgetAdmission()
  testImmediateStateAndBrowserBoundaries()
  testRegisteredBudgetsAndDirectOverrides()
  testBrowserStartupMemoryGuard()
  testServerModeSnapshotAndBackgroundAllowed()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
