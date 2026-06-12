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
const normalChatAdmission = admitTask({
  kind: 'normal_chat',
  source: 'resource-scheduler-test',
  channelKey: 'scheduler-test-group',
  userId: 'scheduler-test-user',
})
const normalPolicy = decideModePolicy('normal_chat', snapshot)
const agentPolicy = decideModePolicy('agent_command', snapshot)
const normalDirective = decideEntryDirective('normal_chat', snapshot)
const agentDirective = decideEntryDirective('agent_command', snapshot)
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
  normalChatDecision: normalChatAdmission.decision,
  normalPolicyAction: normalPolicy.action,
  agentPolicyAction: agentPolicy.action,
  normalDirectiveAction: normalDirective.directive.action,
  normalDirectiveReason: normalDirective.directive.reason,
  agentDirectiveAction: agentDirective.directive.action,
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
  check('red injection silences normal chat', summary.normalChatDecision === 'silent_drop' && summary.normalPolicyAction === 'silent_drop', JSON.stringify(summary))
  check('red injection entry directive matches legacy mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction, JSON.stringify(summary))
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
  check('black injection silences normal chat and rejects agent policy', summary.normalChatDecision === 'silent_drop' && summary.normalPolicyAction === 'silent_drop' && summary.agentPolicyAction === 'reject', JSON.stringify(summary))
  check('black injection entry directive matches legacy mode policy', summary.normalDirectiveAction === summary.normalPolicyAction && summary.agentDirectiveAction === summary.agentPolicyAction, JSON.stringify(summary))
  check('black injection task directive matches legacy admission', summary.dailyDirectiveAction === summary.dailyDecision && summary.browserDirectiveAction === summary.browserDecision, JSON.stringify(summary))
}

// Run all resource-scheduler regression checks.
function main() {
  console.log('=== resource-scheduler S1 tests ===')
  testRedMemoryAdmission()
  testYellowMemoryAdmission()
  testBlackMemoryAdmission()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
