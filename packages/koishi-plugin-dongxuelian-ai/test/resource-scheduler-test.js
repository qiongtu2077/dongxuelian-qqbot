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
  minMemMb: 450,
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

// Verify red memory forces daily downgrade and blocks Chromium-class work.
function testRedMemoryAdmission() {
  const summary = runScenario('S1 red memory injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-red-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '420',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('red injection reports red critical snapshot', summary.resourceState === 'red' && summary.botMode === 'critical' && summary.memAvailableMb === 420, JSON.stringify(summary))
  check('red injection downgrades daily report', summary.dailyDecision === 'downgrade' && summary.dailyFallback === 'daily_report_text', JSON.stringify(summary))
  check('red injection defers browser action', summary.browserDecision === 'defer', JSON.stringify(summary))
  check('red injection rejects 450MB video budget below minimum', summary.videoDecision === 'reject', JSON.stringify(summary))
  check('red injection defers media below its task budget', summary.mediaDecision === 'defer', JSON.stringify(summary))
  check('red injection silences normal chat', summary.normalChatDecision === 'silent_drop' && summary.normalPolicyAction === 'silent_drop', JSON.stringify(summary))
  check('red injection returns resource notices for explicit Agent and chat entries', summary.agentPolicyAction === 'resource_notice' && summary.interactivePolicyAction === 'resource_notice', JSON.stringify(summary))
  check('red injection entry directive matches mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction && summary.interactiveDirectiveAction === summary.interactivePolicyAction, JSON.stringify(summary))
  check('red injection task directive matches legacy admission', summary.dailyDirectiveAction === 'downgrade' && summary.dailyDirectiveFallback === summary.dailyFallback && summary.browserDirectiveAction === summary.browserDecision.replace('run_now', 'pass'), JSON.stringify(summary))
}

// Verify 450MB is the yellow boundary and still honors heavy-task budgets.
function testYellowMemoryAdmission() {
  const summary = runScenario('S1 yellow memory injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-yellow-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '450',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('yellow injection reports yellow normal snapshot', summary.resourceState === 'yellow' && summary.botMode === 'normal' && summary.memAvailableMb === 450, JSON.stringify(summary))
  check('yellow injection downgrades daily below task budget', summary.dailyDecision === 'downgrade' && summary.dailyFallback === 'daily_report_text', JSON.stringify(summary))
  check('yellow injection defers browser below task budget', summary.browserDecision === 'defer', JSON.stringify(summary))
  check('yellow injection allows 450MB video budget', summary.videoDecision === 'run_now', JSON.stringify(summary))
  check('yellow injection defers media below its 600MB task budget', summary.mediaDecision === 'defer', JSON.stringify(summary))
  check('yellow injection allows normal chat policy', summary.normalChatDecision === 'run_now' && summary.normalPolicyAction === 'pass', JSON.stringify(summary))
  check('yellow injection entry directive matches legacy mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction, JSON.stringify(summary))
  check('yellow injection task directive matches legacy admission', summary.dailyDirectiveAction === 'downgrade' && summary.dailyDirectiveFallback === summary.dailyFallback && summary.browserDirectiveAction === summary.browserDecision, JSON.stringify(summary))
}

// Verify black memory defers heavy tasks and silences chat.
function testBlackMemoryAdmission() {
  const summary = runScenario('S1 black memory injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-black-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '250',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('black injection reports black critical snapshot', summary.resourceState === 'black' && summary.botMode === 'critical' && summary.memAvailableMb === 250, JSON.stringify(summary))
  check('black injection defers daily report', summary.dailyDecision === 'defer', JSON.stringify(summary))
  check('black injection defers browser action', summary.browserDecision === 'defer', JSON.stringify(summary))
  check('black injection silences normal chat and returns explicit resource notices', summary.normalChatDecision === 'silent_drop' && summary.normalPolicyAction === 'silent_drop' && summary.agentPolicyAction === 'resource_notice' && summary.interactivePolicyAction === 'resource_notice', JSON.stringify(summary))
  check('black injection entry directive matches legacy mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction, JSON.stringify(summary))
  check('black injection task directive matches legacy admission', summary.dailyDirectiveAction === summary.dailyDecision && summary.browserDirectiveAction === summary.browserDecision, JSON.stringify(summary))
}

// Verify yellow media runs once its own 600MB budget is met instead of waiting for green=900MB.
function testYellowMediaBudgetAdmission() {
  const summary = runScenario('S1 yellow media budget injection', {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('s1-yellow-media-test-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '650',
    RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('yellow media budget scenario remains yellow', summary.resourceState === 'yellow' && summary.memAvailableMb === 650, JSON.stringify(summary))
  check('yellow media budget allows media above its own minimum', summary.mediaDecision === 'run_now', JSON.stringify(summary))
}

// Verify red recovery requires 550MB to remain available for the full two-minute hold.
function testRedRecoveryHysteresis() {
  const snapshot = require('../lib/resource-scheduler/resource-snapshot')
  const startedAt = Date.parse('2026-07-26T00:00:00.000Z')
  const previous = {
    resourceState: 'red',
    recoveryCandidateAt: '',
  }
  const first = snapshot.resolveResourceStateWithHysteresis(550, previous, startedAt)
  const holding = snapshot.resolveResourceStateWithHysteresis(550, { ...previous, recoveryCandidateAt: first.recoveryCandidateAt }, startedAt + 119999)
  const recovered = snapshot.resolveResourceStateWithHysteresis(550, { ...previous, recoveryCandidateAt: first.recoveryCandidateAt }, startedAt + 120000)
  const reset = snapshot.resolveResourceStateWithHysteresis(549, { ...previous, recoveryCandidateAt: first.recoveryCandidateAt }, startedAt + 120000)
  check('red recovery starts and preserves a candidate timestamp', first.resourceState === 'red' && !!first.recoveryCandidateAt && holding.resourceState === 'red', JSON.stringify({ first, holding }))
  check('red recovery exits only after two minutes at 550MB', recovered.resourceState === 'yellow' && recovered.recoveryCandidateAt === '', JSON.stringify(recovered))
  check('red recovery candidate resets below 550MB', reset.resourceState === 'red' && reset.recoveryCandidateAt === '', JSON.stringify(reset))
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
  testBlackMemoryAdmission()
  testYellowMediaBudgetAdmission()
  testRedRecoveryHysteresis()
  testServerModeSnapshotAndBackgroundAllowed()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
