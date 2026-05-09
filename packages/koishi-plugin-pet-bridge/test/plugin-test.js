const fs = require('fs')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const PROTOCOL_PATH = path.resolve(__dirname, '..', 'lib', 'protocol.js')

let passed = 0
let failed = 0

function section(title) {
  console.log('\n=== pet-bridge: ' + title + ' ===')
}

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log('  OK   ' + label)
  } else {
    failed += 1
    console.log('  FAIL ' + label + (detail ? ': ' + detail : ''))
  }
}

function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

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
      return { info: function () { push('info', arguments) }, warn: function () { push('warn', arguments) }, error: function () { push('error', arguments) } }
    },
    _events: events,
    _logs: logs,
  }
  return ctx
}

// ===== 1. 模块加载 =====
section('module loading')
try {
  require(PROTOCOL_PATH)
  check('protocol.js loads', true)
} catch (e) {
  check('protocol.js loads', false, e.message)
}

try {
  reloadPlugin()
  check('index.js loads', true)
} catch (e) {
  check('index.js loads', false, e.message)
}

// ===== 2. 导出检查 =====
section('exports')
const protocol = require(PROTOCOL_PATH)
check('protocol exports handleMessage', typeof protocol.handleMessage === 'function')

const plugin = reloadPlugin()
check('plugin has name', plugin.name === 'pet-bridge')
check('plugin has apply', typeof plugin.apply === 'function')

  // ===== 3. plugin.apply 注册事件 =====
section('plugin apply')
const ctx = makeCtx()
plugin.apply(ctx)
check('ready event registered', (ctx._events.get('ready') || []).length === 1)

// ===== 4. handleMessage 未知类型/边界 =====
section('handleMessage edge cases')
;(async () => {
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

  // dispose event (registered inside ready handler)
  await ctx.emit('ready')
  check('dispose event registered', (ctx._events.get('dispose') || []).length === 1)

  // query: status (should return config)
  resp = await protocol.handleMessage({ id: 4, type: 'query', payload: { type: 'status' } })
  check('query status returns success', resp && resp.success === true && resp.id === 4)
  check('query status has provider/model', resp && resp.payload && typeof resp.payload.model === 'string')

  // query: personas (should return array)
  resp = await protocol.handleMessage({ id: 5, type: 'query', payload: { type: 'personas' } })
  check('query personas returns success', resp && resp.success === true && resp.id === 5)
  check('query personas has personas array', resp && resp.payload && Array.isArray(resp.payload.personas))

  // query: memory without userId
  resp = await protocol.handleMessage({ id: 6, type: 'query', payload: { type: 'memory' } })
  check('query memory missing userId', resp && resp.success === false && resp.id === 6)

  // query: memory with userId
  resp = await protocol.handleMessage({ id: 7, type: 'query', payload: { type: 'memory', userId: 'test-user', channelKey: 'test-channel' } })
  check('query memory with userId', resp && resp.success === true && resp.id === 7)
  check('query memory has summary field', resp && resp.payload && typeof resp.payload.summary === 'string')

  // query: summaries
  resp = await protocol.handleMessage({ id: 8, type: 'query', payload: { type: 'summaries' } })
  check('query summaries returns success', resp && resp.success === true && resp.id === 8)
  check('query summaries has groups array', resp && resp.payload && Array.isArray(resp.payload.groups))

  // command: toggle_search
  resp = await protocol.handleMessage({ id: 10, type: 'command', payload: { action: 'toggle_search', enabled: true } })
  check('toggle_search returns success', resp && resp.success === true && resp.id === 10)
  check('toggle_search payload has searchEnabled', resp && resp.payload && resp.payload.searchEnabled === true)

  // toggle back
  resp = await protocol.handleMessage({ id: 11, type: 'command', payload: { action: 'toggle_search', enabled: false } })
  check('toggle_search disable', resp && resp.success === true && resp.payload.searchEnabled === false)

  // command: toggle_thinking
  resp = await protocol.handleMessage({ id: 12, type: 'command', payload: { action: 'toggle_thinking', enabled: true } })
  check('toggle_thinking returns success', resp && resp.success === true && resp.id === 12)
  check('toggle_thinking payload has thinkingEnabled', resp && resp.payload && resp.payload.thinkingEnabled === true)

  resp = await protocol.handleMessage({ id: 13, type: 'command', payload: { action: 'toggle_thinking', enabled: false } })
  check('toggle_thinking disable', resp && resp.success === true && resp.payload.thinkingEnabled === false)

  // command: toggle_maintenance
  resp = await protocol.handleMessage({ id: 14, type: 'command', payload: { action: 'toggle_maintenance', enabled: true } })
  check('toggle_maintenance returns success', resp && resp.success === true && resp.id === 14)
  check('toggle_maintenance payload has maintenanceEnabled', resp && resp.payload && resp.payload.maintenanceEnabled === true)

  resp = await protocol.handleMessage({ id: 15, type: 'command', payload: { action: 'toggle_maintenance', enabled: false } })
  check('toggle_maintenance disable', resp && resp.success === true && resp.payload.maintenanceEnabled === false)

  // command: switch_persona with missing name
  resp = await protocol.handleMessage({ id: 16, type: 'command', payload: { action: 'switch_persona' } })
  check('switch_persona missing name returns fail', resp && resp.success === false && resp.id === 16)

  // command: manage_whitelist list
  resp = await protocol.handleMessage({ id: 17, type: 'command', payload: { action: 'manage_whitelist', whitelistAction: 'list' } })
  check('manage_whitelist list returns success', resp && resp.success === true && resp.id === 17)
  check('manage_whitelist list has whitelist array', resp && resp.payload && Array.isArray(resp.payload.whitelist))

  // command: send_group_msg missing params
  resp = await protocol.handleMessage({ id: 18, type: 'command', payload: { action: 'send_group_msg' } })
  check('send_group_msg missing params', resp && resp.success === false && resp.id === 18)

  // command: switch_model
  resp = await protocol.handleMessage({ id: 19, type: 'command', payload: { action: 'switch_model', provider: 'opencode' } })
  check('switch_model returns success', resp && resp.success === true && resp.id === 19)
  check('switch_model has provider in payload', resp && resp.payload && typeof resp.payload.provider === 'string')

  // chat missing text
  resp = await protocol.handleMessage({ id: 20, type: 'chat', payload: {} })
  check('chat missing text', resp && resp.success === false && resp.id === 20)

  // clean up WS server
  await ctx.emit('dispose')

  section('summary')
  console.log('  passed: ' + passed)
  console.log('  failed: ' + failed)
  if (failed) process.exitCode = 1
  process.exit(failed > 0 ? 1 : 0)
})()
