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
  const middlewareList = []
  const events = new Map()
  const logs = []
  return {
    middleware(fn) {
      middlewareList.push(fn)
      return fn
    },
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
    middlewareList,
    logs,
  }
}

async function runHelpCase(ctx, content) {
  let nextCalled = false
  const session = { content }
  const result = await ctx.middlewareList[0](session, () => {
    nextCalled = true
    return 'NEXT'
  })
  return { result, nextCalled }
}

async function run() {
  console.log('\n=== dongxuelian-help: command middleware ===')
  const plugin = reloadPlugin()
  check('plugin exports expected name', plugin.name === 'dongxuelian-help')

  const ctx = makeCtx()
  plugin.apply(ctx)
  await ctx.emit('ready')
  check('ready event logs loaded message', ctx.logs.some(log => log.level === 'info' && log.msg.includes('loaded')), JSON.stringify(ctx.logs))

  let result = await runHelpCase(ctx, 'help东雪莲')
  const expectedRootHelp = [
    '东雪莲帮助：',
    '- helpAI / 帮助AI / AI帮助',
    '- help集合 / 帮助集合 / 东雪莲集合',
    '- 杂项功能',
    '- /help XX （模糊查询）',
  ].join('\n')
  check('root help returns exact compact menu', result.result === expectedRootHelp, String(result.result))
  check('root help no longer lists quick reference menu', typeof result.result === 'string' && !result.result.includes('指令速查') && !result.result.includes('其他帮助'), String(result.result))
  check('root help does not call next', result.nextCalled === false)

  result = await runHelpCase(ctx, '[CQ:at,qq=90000] helpAI')
  check('mentions are stripped before helpAI match', typeof result.result === 'string' && result.result.includes('AI帮助'), String(result.result))
  check('AI help lists tree branches only', typeof result.result === 'string' && result.result.includes('【切换模型与供应商】') && !result.result.includes('【常用】') && !result.result.includes('【集合】'), String(result.result))

  result = await runHelpCase(ctx, '杂项功能')
  check('misc help returns root-level misc branch', typeof result.result === 'string' && result.result.includes('【杂项功能】') && result.result.includes('今日情绪'), String(result.result))

  result = await runHelpCase(ctx, '【杂项功能】')
  check('bracketed misc branch title also matches', typeof result.result === 'string' && result.result.includes('【杂项功能】'), String(result.result))

  result = await runHelpCase(ctx, 'help集合')
  check('collection help returns collection commands', typeof result.result === 'string' && result.result.includes('集合添加'), String(result.result))

  result = await runHelpCase(ctx, '东雪莲集合')
  check('new collection alias returns collection commands', typeof result.result === 'string' && result.result.includes('集合添加'), String(result.result))

  result = await runHelpCase(ctx, '指令速查')
  check('removed quick reference exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '常用')
  check('removed common exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '集合')
  check('removed bare collection exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '/help 人格')
  check('fuzzy help returns matching lines', typeof result.result === 'string' && result.result.includes('/help人格 结果'), String(result.result))

  result = await runHelpCase(ctx, '供应商 opencode')
  check('provider model help returns provider models', typeof result.result === 'string' && result.result.includes('OpenCode Go 可用模型'), String(result.result))

  result = await runHelpCase(ctx, '不是帮助命令')
  check('unknown text falls through to next', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
