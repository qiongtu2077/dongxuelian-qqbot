const fs = require('fs')
const os = require('os')
const path = require('path')
const { seedCapabilityConfig } = require('../../koishi-plugin-dongxuelian-ai/test/helpers/ai-capability-fixture')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const PROTOCOL_PATH = path.resolve(__dirname, '..', 'lib', 'protocol.js')

let passed = 0
let failed = 0

// --- Test utilities --- #

// Prints a readable test section heading.
function section(title) {
  console.log('\n=== pet-bridge: ' + title + ' ===')
}

// Records one assertion result and keeps the final summary counters.
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log('  OK   ' + label)
  } else {
    failed += 1
    console.log('  FAIL ' + label + (detail ? ': ' + detail : ''))
  }
}

// Drops one module from Node's require cache if it has been loaded.
function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)]
  } catch { /* non-critical: cache cleanup skips modules that were never loaded */
  }
}

// Clears plugin and AI runtime modules that capture data paths at load time.
function clearPluginCaches() {
  clearModule(PLUGIN_PATH)
  clearModule(PROTOCOL_PATH)
  for (const rel of [
    'public/pet-bridge-runtime',
    'core/constants',
    'core/runtime-config',
    'persona/persona',
    'conversation',
    'core/api',
    'resource-scheduler/admission',
    'resource-gate/gate',
    'core/onebot-endpoint',
  ]) {
    clearModule('koishi-plugin-dongxuelian-ai/lib/' + rel)
  }
}

// Reloads the plugin entry after cache and environment setup.
function reloadPlugin() {
  clearModule(PLUGIN_PATH)
  return require(PLUGIN_PATH)
}

// Seeds the explicit text capability required by status and model-switch protocol calls.
function seedPetBridgeTextCapability(dataDir) {
  const data = {
    writeJson(name, value) {
      fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2), 'utf8')
    },
    writeText(name, value) {
      fs.writeFileSync(path.join(dataDir, name), value, 'utf8')
    },
  }
  seedCapabilityConfig(data, {
    text: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  })
}

// Creates a tiny Koishi-like context for event and logger assertions.
function makeCtx() {
  const events = new Map()
  const logs = []
  const ctx = {
    on(event, fn) {
      const list = events.get(event) || []
      list.push(fn)
      events.set(event, list)
      return fn
    },
    async emit(event) {
      for (const fn of events.get(event) || []) await fn()
    },
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: Array.from(args).map(String).join(' ') })
      return {
        info() { push('info', arguments) },
        warn() { push('warn', arguments) },
        error() { push('error', arguments) },
      }
    },
    _events: events,
    _logs: logs,
  }
  return ctx
}

// Runs a test body with AI runtime files redirected to a temporary data dir.
async function withIsolatedPlugin(fn) {
  const oldEnv = {
    DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-bridge-'))
  const dataDir = path.join(tmpRoot, 'data')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  fs.mkdirSync(dataDir, { recursive: true })
  seedPetBridgeTextCapability(dataDir)
  clearPluginCaches()

  try {
    let petBridgeRuntime = null
    let petBridgeRuntimeLoadError = null
    try {
      petBridgeRuntime = require('koishi-plugin-dongxuelian-ai/lib/public/pet-bridge-runtime')
    } catch (error) {
      petBridgeRuntimeLoadError = error
    }
    const protocol = require(PROTOCOL_PATH)
    const plugin = reloadPlugin()
    const constants = require('koishi-plugin-dongxuelian-ai/lib/core/constants')
    await fn({ protocol, plugin, constants, petBridgeRuntime, petBridgeRuntimeLoadError, tmpRoot, dataDir })
  } finally {
    clearPluginCaches()
    if (oldEnv.DONGXUELIAN_AI_DATA_DIR === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = oldEnv.DONGXUELIAN_AI_DATA_DIR
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// --- Test cases --- #

// Executes pet-bridge protocol and lifecycle regression checks.
async function run() {
  await withIsolatedPlugin(async ({ protocol, plugin, constants, petBridgeRuntime, petBridgeRuntimeLoadError, dataDir }) => {
    section('module loading and exports')
    check('protocol exports handleMessage', typeof protocol.handleMessage === 'function')
    check('plugin has name', plugin.name === 'pet-bridge')
    check('plugin has apply', typeof plugin.apply === 'function')
    check('constants use isolated data dir', constants.THINKING_MODE_FILE.startsWith(dataDir), constants.THINKING_MODE_FILE)
    const runtimeExports = [
      'getPetBridgeStatus',
      'listPetBridgePersonas',
      'getPetBridgeMemorySummary',
      'listPetBridgeSummaryGroups',
      'switchPetBridgeModel',
      'setPetBridgeSearchEnabled',
      'setPetBridgeThinkingEnabled',
      'setPetBridgeMaintenanceEnabled',
      'getPetBridgeMaintenanceMessage',
      'sendPetBridgeGroupMessage',
      'managePetBridgeRandomWhitelist',
      'switchPetBridgePersona',
      'getCurrentPetBridgePersona',
      'generatePetBridgeChatReply',
    ]
    check('pet bridge runtime loads from public AI boundary', !!petBridgeRuntime && !petBridgeRuntimeLoadError, petBridgeRuntimeLoadError && petBridgeRuntimeLoadError.message)
    check('pet bridge runtime exports public domain operations', !!petBridgeRuntime && runtimeExports.every(name => typeof petBridgeRuntime[name] === 'function'), runtimeExports.filter(name => !petBridgeRuntime || typeof petBridgeRuntime[name] !== 'function').join(', '))
    const protocolSource = fs.readFileSync(PROTOCOL_PATH, 'utf8')
    const forbiddenDeepRequires = [
      'koishi-plugin-dongxuelian-ai/lib/core/runtime-config',
      'koishi-plugin-dongxuelian-ai/lib/core/api',
      'koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission',
      'koishi-plugin-dongxuelian-ai/lib/resource-gate/gate',
      'koishi-plugin-dongxuelian-ai/lib/persona/persona',
      'koishi-plugin-dongxuelian-ai/lib/conversation',
      'koishi-plugin-dongxuelian-ai/lib/core/onebot-endpoint',
      'koishi-plugin-dongxuelian-ai/lib/core/constants',
    ]
    check('protocol uses only AI public pet bridge runtime', protocolSource.includes('koishi-plugin-dongxuelian-ai/lib/public/pet-bridge-runtime') && forbiddenDeepRequires.every(item => !protocolSource.includes(item)), forbiddenDeepRequires.filter(item => protocolSource.includes(item)).join(', '))

    section('plugin apply')
    const ctx = makeCtx()
    plugin.apply(ctx, { port: 0 })
    check('ready event registered', (ctx._events.get('ready') || []).length === 1)
    await ctx.emit('ready')
    check('dispose event registered', (ctx._events.get('dispose') || []).length === 1)
    await ctx.emit('dispose')

    section('handleMessage edge cases')
    let resp

    resp = await protocol.handleMessage({})
    check('empty message returns response', resp && resp.type === 'response')
    check('empty message success=false', resp && resp.success === false)

    resp = await protocol.handleMessage({ id: 1, type: 'unknown_type', payload: {} })
    check('unknown type', resp && resp.success === false && resp.id === 1)

    resp = await protocol.handleMessage({ id: 2, type: 'query', payload: { type: 'nonexistent_thing' } })
    check('unknown query type', resp && resp.success === false && resp.id === 2)

    resp = await protocol.handleMessage({ id: 3, type: 'command', payload: { action: 'nonexistent_command' } })
    check('unknown command action', resp && resp.success === false && resp.id === 3)

    section('queries')
    resp = await protocol.handleMessage({ id: 4, type: 'query', payload: { type: 'status' } })
    check('query status returns success', resp && resp.success === true && resp.id === 4)
    check('query status has provider/model', resp && resp.payload && typeof resp.payload.model === 'string')

    resp = await protocol.handleMessage({ id: 5, type: 'query', payload: { type: 'personas' } })
    check('query personas returns success', resp && resp.success === true && resp.id === 5)
    check('query personas has personas array', resp && resp.payload && Array.isArray(resp.payload.personas))

    resp = await protocol.handleMessage({ id: 6, type: 'query', payload: { type: 'memory' } })
    check('query memory missing userId', resp && resp.success === false && resp.id === 6)

    resp = await protocol.handleMessage({ id: 7, type: 'query', payload: { type: 'memory', userId: 'test-user', channelKey: 'test-channel' } })
    check('query memory with userId', resp && resp.success === true && resp.id === 7)
    check('query memory has summary field', resp && resp.payload && typeof resp.payload.summary === 'string')

    resp = await protocol.handleMessage({ id: 8, type: 'query', payload: { type: 'summaries' } })
    check('query summaries returns success', resp && resp.success === true && resp.id === 8)
    check('query summaries has groups array', resp && resp.payload && Array.isArray(resp.payload.groups))

    section('commands')
    resp = await protocol.handleMessage({ id: 10, type: 'command', payload: { action: 'toggle_search', enabled: true } })
    check('toggle_search returns success', resp && resp.success === true && resp.id === 10)
    check('toggle_search payload has searchEnabled', resp && resp.payload && resp.payload.searchEnabled === true)

    resp = await protocol.handleMessage({ id: 11, type: 'command', payload: { action: 'toggle_search', enabled: false } })
    check('toggle_search disable', resp && resp.success === true && resp.payload.searchEnabled === false)

    resp = await protocol.handleMessage({ id: 12, type: 'command', payload: { action: 'toggle_thinking', enabled: true } })
    check('toggle_thinking returns success', resp && resp.success === true && resp.id === 12)
    check('toggle_thinking writes on', fs.readFileSync(constants.THINKING_MODE_FILE, 'utf8').trim() === 'on')

    resp = await protocol.handleMessage({ id: 13, type: 'command', payload: { action: 'toggle_thinking', enabled: false } })
    check('toggle_thinking disable', resp && resp.success === true && resp.payload.thinkingEnabled === false)
    check('toggle_thinking writes off', fs.readFileSync(constants.THINKING_MODE_FILE, 'utf8').trim() === 'off')

    resp = await protocol.handleMessage({ id: 14, type: 'command', payload: { action: 'toggle_maintenance', enabled: true } })
    check('toggle_maintenance returns success', resp && resp.success === true && resp.id === 14)
    check('toggle_maintenance payload has maintenanceEnabled', resp && resp.payload && resp.payload.maintenanceEnabled === true)

    resp = await protocol.handleMessage({ id: 15, type: 'command', payload: { action: 'toggle_maintenance', enabled: false } })
    check('toggle_maintenance disable', resp && resp.success === true && resp.payload.maintenanceEnabled === false)

    resp = await protocol.handleMessage({ id: 16, type: 'command', payload: { action: 'switch_persona' } })
    check('switch_persona missing name returns fail', resp && resp.success === false && resp.id === 16)

    resp = await protocol.handleMessage({ id: 17, type: 'command', payload: { action: 'manage_whitelist', whitelistAction: 'list' } })
    check('manage_whitelist list returns success', resp && resp.success === true && resp.id === 17)
    check('manage_whitelist list has whitelist array', resp && resp.payload && Array.isArray(resp.payload.whitelist))

    resp = await protocol.handleMessage({ id: 18, type: 'command', payload: { action: 'send_group_msg' } })
    check('send_group_msg missing params', resp && resp.success === false && resp.id === 18)

    resp = await protocol.handleMessage({ id: 19, type: 'command', payload: { action: 'switch_model', provider: 'opencode' } })
    check('switch_model returns success', resp && resp.success === true && resp.id === 19)
    check('switch_model has provider in payload', resp && resp.payload && typeof resp.payload.provider === 'string')

    resp = await protocol.handleMessage({ id: 20, type: 'chat', payload: {} })
    check('chat missing text', resp && resp.success === false && resp.id === 20)
  })

  section('summary')
  console.log('  passed: ' + passed)
  console.log('  failed: ' + failed)
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
