const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  OK   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

function makeCtx() {
  const events = new Map()
  const logs = []
  return {
    on(event, fn) {
      const list = events.get(event) || []
      list.push(fn)
      events.set(event, list)
      return fn
    },
    async emit(event, ...args) {
      for (const fn of events.get(event) || []) await fn(...args)
    },
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: args.map(String).join(' ') })
      return {
        info: (...args) => push('info', args),
        warn: (...args) => push('warn', args),
        error: (...args) => push('error', args),
      }
    },
    logs,
  }
}

function makeSession(overrides = {}) {
  const internalCalls = []
  return {
    subtype: 'poke',
    selfId: '90000',
    targetId: '90000',
    userId: '20001',
    guildId: '10001',
    internalCalls,
    bot: {
      selfId: '90000',
      internal: {
        async _request(action, params) {
          internalCalls.push({ action, params })
          return { status: 'ok' }
        },
      },
    },
    ...overrides,
  }
}

async function run() {
  console.log('\n=== dongxuelian-poke: notice handling ===')
  const plugin = reloadPlugin()
  check('plugin exports expected name', plugin.name === 'dongxuelian-poke')

  const ctx = makeCtx()
  plugin.apply(ctx)

  const normal = makeSession()
  await ctx.emit('notice', normal)
  check('group poke calls OneBot group_poke', normal.internalCalls.length === 1 && normal.internalCalls[0].action === 'group_poke', JSON.stringify(normal.internalCalls))
  check('group poke uses guild and user ids', normal.internalCalls[0].params.group_id === '10001' && normal.internalCalls[0].params.user_id === '20001', JSON.stringify(normal.internalCalls[0].params))

  const missingGuild = makeSession({ guildId: '' })
  await ctx.emit('notice', missingGuild)
  check('missing guild id does not poke back', missingGuild.internalCalls.length === 0, JSON.stringify(missingGuild.internalCalls))

  const missingUser = makeSession({ userId: '' })
  await ctx.emit('notice', missingUser)
  check('missing user id does not poke back', missingUser.internalCalls.length === 0, JSON.stringify(missingUser.internalCalls))

  const wrongTarget = makeSession({ targetId: '12345' })
  await ctx.emit('notice', wrongTarget)
  check('poke targeting other user is ignored', wrongTarget.internalCalls.length === 0, JSON.stringify(wrongTarget.internalCalls))

  const nonPoke = makeSession({ subtype: 'group_decrease' })
  await ctx.emit('notice', nonPoke)
  check('non-poke notice is ignored', nonPoke.internalCalls.length === 0, JSON.stringify(nonPoke.internalCalls))

  const missingRequest = makeSession({ bot: { selfId: '90000', internal: {} } })
  await ctx.emit('notice', missingRequest)
  check('missing internal request logs warning', ctx.logs.some(log => log.level === 'warn' && log.msg.includes('no _request method')), JSON.stringify(ctx.logs))

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
