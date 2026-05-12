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
  const sent = []
  return {
    sent,
    userId: '20001',
    guildId: '10001',
    channelId: '10001',
    event: { guild: { id: '10001' }, user: { id: '20001' } },
    bot: {
      async sendMessage(target, message) {
        sent.push({ target: String(target), message: String(message) })
        return message
      },
    },
    ...overrides,
  }
}

async function run() {
  console.log('\n=== group-leave-notice: member removed ===')
  const plugin = reloadPlugin()
  check('plugin exports expected name', plugin.name === 'group-leave-notice')

  const ctx = makeCtx()
  plugin.apply(ctx)
  await ctx.emit('ready')
  check('ready event logs loaded message', ctx.logs.some(log => log.level === 'info' && log.msg.includes('loaded')), JSON.stringify(ctx.logs))

  const normal = makeSession()
  await ctx.emit('guild-member-removed', normal)
  check('member removed sends leave notice', normal.sent.length === 1, JSON.stringify(normal.sent))
  check('leave notice prefers channel id target', normal.sent[0].target === '10001', JSON.stringify(normal.sent[0]))
  check('leave notice contains user id', normal.sent[0].message.includes('20001 退群了'), normal.sent[0].message)

  const eventOnly = makeSession({ userId: '', channelId: '', guildId: '', event: { guild: { id: 'eventGuild' }, member: { user: { id: 'eventUser' } } } })
  await ctx.emit('guild-member-removed', eventOnly)
  check('event fields are used as fallback', eventOnly.sent.length === 1 && eventOnly.sent[0].target === 'eventGuild' && eventOnly.sent[0].message.includes('eventUser'), JSON.stringify(eventOnly.sent))

  const missingUser = makeSession({ userId: '', event: { guild: { id: '10001' } } })
  await ctx.emit('guild-member-removed', missingUser)
  check('missing user id does not send', missingUser.sent.length === 0, JSON.stringify(missingUser.sent))

  const missingTarget = makeSession({ channelId: '', guildId: '', event: { user: { id: '20001' } } })
  await ctx.emit('guild-member-removed', missingTarget)
  check('missing target does not send', missingTarget.sent.length === 0, JSON.stringify(missingTarget.sent))

  const missingSend = makeSession({ bot: {} })
  await ctx.emit('guild-member-removed', missingSend)
  check('missing sendMessage does not throw or send', missingSend.sent.length === 0, JSON.stringify(missingSend.sent))

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
