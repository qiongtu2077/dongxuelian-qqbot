'use strict'

const fs = require('fs')
const path = require('path')

/** Builds the behavior-to-scenario coverage contract. */
function buildCoverageMap(AI_ROOT) {
  return [
  {
    behavior: 'sticker text/image send order',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'sticker.test.js'),
    needles: ['scenario: sticker sendReply', 'scenario sticker sends text before internal image'],
  },
  {
    behavior: 'repeat trigger cooldown window toggle',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'repeat.test.js'),
    needles: ['scenario: repeat middleware', 'scenario text repeat triggers for two users', 'scenario repeat window expiry blocks old message'],
  },
  {
    behavior: 'sensitive detect switch and notification',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'sensitive.test.js'),
    needles: ['scenario: sensitive detection middleware', 'scenario sensitive detect enables', 'scenario sensitive close prevents later notification'],
  },
  {
    behavior: 'chat reasoning and thinking guard',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'chat.test.js'),
    needles: ['scenario: chat middleware and thinking guard', 'scenario reasoning-only response falls back', 'scenario conversation stores visible reply only'],
  },
  {
    behavior: 'managed capability fallback behavior',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'fallback.test.js'),
    needles: ['scenario: managed capability fallback', "['invalid JSON'", 'all managed steps error is sanitized'],
  },
  {
    behavior: 'forward summary resolution',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'forward.test.js'),
    needles: ['scenario: forward summary resolution', 'scenario forward nested CQ calls inner id', 'scenario forward empty array returns empty summary'],
  },
  {
    behavior: 'vision session field ownership',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'vision.test.js'),
    needles: ['scenario: vision session helpers', 'scenario vision quoted image marks session', 'scenario vision clear removes current image marker'],
  },
  {
    behavior: 'file history and natural reading',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'file.test.js'),
    needles: ['scenario: file history and natural reading', 'scenario empty group file stores metadata before early return', 'scenario read file command sends natural summary'],
  },
  {
    behavior: 'random proactive reply behavior',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'random.test.js'),
    needles: ['scenario: random reply trigger', 'scenario random whitelisted rate 100 sends reply', 'scenario empty random whitelist does not call model'],
  },
  {
    behavior: 'concurrent JSON write integrity',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'persistence.test.js'),
    needles: ['scenario: persistence write stress', 'scenario concurrent write leaves parseable JSON', 'scenario concurrent write cleans temp files'],
  },
  {
    behavior: 'business concurrency behavior',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'concurrency.test.js'),
    needles: ['scenario: business concurrency', 'scenario concurrent repeat triggers exactly once', 'scenario sensitive close race prevents later notification'],
  },
  {
    behavior: 'command permissions and status',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'command.test.js'),
    needles: ['scenario: command middleware', 'scenario AI status does not leak key', 'scenario non-admin sensitive switch does not write file'],
  },
  {
    behavior: 'setup.sh executable behavior',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'setup.test.js'),
    needles: ['scenario: setup.sh simulated install', 'scenario setup shell syntax passes before simulation', 'scenario setup rejects escaped koishi output path'],
  },
  {
    behavior: 'persona prompt composition',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'persona-prompt.test.js'),
    needles: ['scenario: persona prompt composition', 'scenario personal persona overrides group persona', 'scenario Terra lore injects for Theresa trigger'],
  },
  {
    behavior: 'persona regression assets',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'persona-regression.test.js'),
    needles: ['scenario: persona regression assets', 'persona regression covers required personas', 'persona regression covers required risk tags'],
  },
  {
    behavior: 'send guard platform mute and rate limit',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'send-guard.test.js'),
    needles: ['scenario: send guard platform mute and rate limit', 'scenario send guard skips bot member mute', 'scenario send guard retries sanitized rate limit reply'],
  },
  {
    behavior: 'dashboard standalone deployer security helpers',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'deployer.test.js'),
    needles: ['scenario: dashboard deployer security', 'deployer isLocalAuthBypass rejects loopback without GLOBAL_LOCAL_MODE', 'deployer isLocalAuthBypass rejects non-loopback with GLOBAL_LOCAL_MODE', 'deployer KOISHI_PID_FILE follows KOISHI_DIR env', 'deployer stale pid pointing non Dashboard does not kill', 'deployer stale pid pointing Dashboard command kills'],
  },
  {
    behavior: 'bot resource gate regression',
    file: path.join(AI_ROOT, 'test', 'scenarios', 'bot-regression.test.js'),
    needles: ['scenario: bot resource gate regression', 'scenario daily report running does not globally mute explicit chat', 'scenario daily report running keeps explicit voice follow-up recoverable'],
  },
  {
    behavior: 'retaliation score calculation',
    file: path.join(AI_ROOT, 'lib', 'behavior', 'retaliation.js'),
    needles: [],
  },
]
}

/** Verifies that every mapped scenario exists, contains its sentinels, and is wired. */
async function runCoverageContract(context) {
  const { AI_ROOT, ROOT, section, check, read } = context
  const coverageMap = buildCoverageMap(AI_ROOT)
  section('1b. scenario coverage map')
  const scenarioIndex = path.join(AI_ROOT, 'test', 'scenarios', 'index.js')
  const scenarioIndexSrc = fs.existsSync(scenarioIndex) ? read(scenarioIndex) : ''
  for (const item of coverageMap) {
    const exists = fs.existsSync(item.file)
    check(`coverage map file exists: ${item.behavior}`, exists, path.relative(ROOT, item.file))
    if (!exists) continue
    const source = read(item.file)
    for (const needle of item.needles) {
      check(`coverage map needle: ${item.behavior}: ${needle}`, source.includes(needle), path.relative(ROOT, item.file))
    }
    const scenarioDir = path.join(AI_ROOT, 'test', 'scenarios') + path.sep
    const resolvedFile = path.resolve(item.file)
    if (resolvedFile.startsWith(path.resolve(scenarioDir))) {
      const moduleName = './' + path.basename(item.file, '.js')
      check(
        `coverage map scenario wired: ${item.behavior}`,
        scenarioIndexSrc.includes(`require('${moduleName}')`) || scenarioIndexSrc.includes(`require("${moduleName}")`),
        moduleName
      )
    }
  }
}

module.exports = { buildCoverageMap, runCoverageContract }
