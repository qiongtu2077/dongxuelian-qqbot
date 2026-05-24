const fs = require('fs')
const os = require('os')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n=== group-name-at: ${title} ===`)
}

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
  const commands = []
  const logs = []
  const ctx = {
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
    command(name, desc) {
      const command = {
        name,
        desc,
        action(fn) {
          commands.push({ name, desc, fn })
          return command
        },
      }
      return command
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
    commands,
    logs,
  }
  return ctx
}

function makeSession(content, overrides = {}) {
  return {
    content,
    sent: [],
    userId: '100000000',
    guildId: '10001',
    channelId: '10001',
    isDirect: false,
    author: { name: 'tester', nick: 'tester' },
    username: 'tester',
    event: { sender: { role: 'member' }, message: [] },
    bot: {
      async getGuildMember(guildId, userId) {
        return { name: `U${userId}` }
      },
    },
    async send(message) {
      this.sent.push(String(message))
      return message
    },
    ...overrides,
  }
}

async function runMiddleware(ctx, session) {
  let nextCalled = false
  const next = () => { nextCalled = true }
  for (const mw of ctx.middlewareList) {
    const result = await mw(session, next)
    if (result !== undefined && result !== null) session.sent.push(String(result))
    if (session.sent.length || nextCalled) break
  }
  return { sent: session.sent, nextCalled, logs: ctx.logs }
}

async function send(ctx, content, overrides) {
  return runMiddleware(ctx, makeSession(content, overrides))
}

async function withIsolatedPlugin(fn) {
  const oldEnv = {
    GROUP_NAME_AT_DATA_FILE: process.env.GROUP_NAME_AT_DATA_FILE,
    GROUP_NAME_AT_ADMIN_IDS_FILE: process.env.GROUP_NAME_AT_ADMIN_IDS_FILE,
    DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-name-at-'))
  const dataDir = path.join(tmpRoot, 'data')
  const dataFile = path.join(dataDir, 'nickname-collections.json')
  const adminIdsFile = path.join(dataDir, 'ai-admin-ids.json')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  process.env.GROUP_NAME_AT_DATA_FILE = dataFile
  process.env.GROUP_NAME_AT_ADMIN_IDS_FILE = adminIdsFile
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(adminIdsFile, JSON.stringify(['100000000']), 'utf8')
  delete require.cache[PLUGIN_PATH]

  try {
    const plugin = reloadPlugin()
    const ctx = makeCtx()
    plugin.apply(ctx)
    await fn({ plugin, ctx, tmpRoot, dataDir, dataFile, adminIdsFile })
  } finally {
    delete require.cache[PLUGIN_PATH]
    if (oldEnv.GROUP_NAME_AT_DATA_FILE === undefined) delete process.env.GROUP_NAME_AT_DATA_FILE
    else process.env.GROUP_NAME_AT_DATA_FILE = oldEnv.GROUP_NAME_AT_DATA_FILE
    if (oldEnv.GROUP_NAME_AT_ADMIN_IDS_FILE === undefined) delete process.env.GROUP_NAME_AT_ADMIN_IDS_FILE
    else process.env.GROUP_NAME_AT_ADMIN_IDS_FILE = oldEnv.GROUP_NAME_AT_ADMIN_IDS_FILE
    if (oldEnv.DONGXUELIAN_AI_DATA_DIR === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = oldEnv.DONGXUELIAN_AI_DATA_DIR
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

async function run() {
  section('env path and command behavior')
  await withIsolatedPlugin(async ({ ctx, tmpRoot, dataFile }) => {
    await ctx.emit('ready')

    let result = await send(ctx, '创建集合 战队 <at id="1001"/><at id="1002"/>')
    check('creates collection through middleware', result.sent.some(item => item.includes('已创建集合「战队」')), JSON.stringify(result.sent))
    check('writes configured data file', fs.existsSync(dataFile), dataFile)
    check('configured data file stays inside temp root', path.resolve(dataFile).startsWith(path.resolve(tmpRoot)), dataFile)

    result = await send(ctx, '集合添加 战队 <at id="1003"/>')
    check('adds collection member', result.sent.some(item => item.includes('已向集合「战队」添加 1 人')), JSON.stringify(result.sent))

    result = await send(ctx, '查看集合 战队')
    check('views collection by collection command', result.sent.some(item => item.includes('集合：战队')), JSON.stringify(result.sent))
    check('view collection includes member count', result.sent.some(item => item.includes('人数：3')), JSON.stringify(result.sent))

    result = await send(ctx, '清空集合 战队')
    check('clear collection asks for confirmation first', result.sent.some(item => item.includes('确认清空集合 战队')), JSON.stringify(result.sent))

    result = await send(ctx, '确认清空集合 战队')
    check('clear collection confirmation succeeds', result.sent.some(item => item.includes('已清空集合「战队」')), JSON.stringify(result.sent))

    await send(ctx, '集合添加 战队 <at id="1001"/>')
    result = await send(ctx, '删除集合 战队')
    check('delete collection asks for confirmation first', result.sent.some(item => item.includes('确认删除集合 战队')), JSON.stringify(result.sent))

    result = await send(ctx, '确认删除集合 战队')
    check('delete collection confirmation succeeds', result.sent.some(item => item.includes('已删除集合「战队」')), JSON.stringify(result.sent))

    result = await send(ctx, '昵称 小明 <at id="2001"/>')
    check('binds alias through middleware', result.sent.some(item => item.includes('昵称“小明”成功绑定到用户')), JSON.stringify(result.sent))

    result = await send(ctx, '昵称 风控 <at id="2002"/>', {
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })
    check('send failure is caught inside nickname plugin', result.sent.length === 0 && result.logs.some(log => log.level === 'warn' && log.msg.includes('send failed')), JSON.stringify(result))

    result = await send(ctx, '查看全部昵称')
    check('alias list command is not stolen by collection list', result.sent.some(item => item.includes('本群昵称：') && item.includes('小明')), JSON.stringify(result.sent))

    result = await send(ctx, '查看全部集合')
    check('collection list command is separate from alias list', result.sent.some(item => item.includes('本群还没有集合。')), JSON.stringify(result.sent))

    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    check('store writes atomically and remains parseable', stored && stored.scopes && stored.scopes['10001'], JSON.stringify(stored))
  })

  section('corrupt json handling')
  await withIsolatedPlugin(async ({ ctx, dataFile }) => {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    fs.writeFileSync(dataFile, '{ broken json', 'utf8')
    await ctx.emit('ready')

    const result = await send(ctx, '查看全部昵称')
    check('corrupt json returns friendly read failure', result.sent.some(item => item.includes('昵称数据读取失败')), JSON.stringify(result.sent))
    check('corrupt json is not overwritten', fs.readFileSync(dataFile, 'utf8') === '{ broken json')
    check('corrupt json warning is logged', ctx.logs.some(log => log.level === 'warn'))
  })

  section('boundary and edge cases')
  await withIsolatedPlugin(async ({ ctx, dataFile }) => {
    let result

    result = await send(ctx, '查看集合 不存在的集合')
    check('boundary: view nonexistent collection returns friendly message', result.sent.some(item => item.includes('未找到') || item.includes('不存在')), JSON.stringify(result.sent))

    result = await send(ctx, '查看昵称')
    check('boundary: missing alias argument returns friendly message', result.sent.some(item => item.includes('名称不能为空。')), JSON.stringify(result.sent))

    result = await send(ctx, '创建集合')
    check('boundary: missing collection argument returns friendly message', result.sent.some(item => item.includes('名称不能为空。')), JSON.stringify(result.sent))

    result = await send(ctx, '查看成员')
    check('boundary: missing member argument returns friendly message', result.sent.some(item => item.includes('请指定成员名')), JSON.stringify(result.sent))

    result = await send(ctx, '删除用户名 不存在的昵称')
    check('boundary: delete nonexistent alias does not crash', result.sent.length === 0 || result.sent.some(item => typeof item === 'string'), JSON.stringify(result.sent))

    result = await send(ctx, '创建集合 测试组 <at id="777"/>')
    check('boundary: create first collection returns success', result.sent.some(item => item.includes('已创建')), JSON.stringify(result.sent))
    result = await send(ctx, '创建集合 测试组 <at id="777"/>')
    check('boundary: duplicate creation does not crash', !result.sent.some(item => item.includes('崩溃') || item.includes('错误')), JSON.stringify(result.sent))

    result = await send(ctx, 'at集合名称 测试组')
    check('boundary: mention collection returns mention or notice', result.sent.length > 0, JSON.stringify(result.sent))

    result = await send(ctx, 'at集合名称 测试组', {
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })
    check('boundary: mention collection send failure is caught', result.sent.length === 0 && result.logs.some(log => log.level === 'warn' && log.msg.includes('send failed')), JSON.stringify(result))
  })

  section('runtime disabled groups and cleanup')
  await withIsolatedPlugin(async ({ ctx, dataDir, dataFile }) => {
    await ctx.emit('ready')
    let result = await send(ctx, '查看全部昵称', { guildId: '942033342', channelId: '942033342' })
    check('no source hardcoded group blacklist by default', result.sent.some(item => item.includes('本群还没有昵称。')), JSON.stringify(result.sent))

    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), JSON.stringify({ groups: ['942033342'] }), 'utf8')
    result = await send(ctx, '查看全部昵称', { guildId: '942033342', channelId: '942033342' })
    check('runtime disabled group file blocks nickname plugin', result.nextCalled && result.sent.length === 0, JSON.stringify(result))

    result = await send(ctx, '群聊昵称黑名单查看', { guildId: '942033342', channelId: '942033342', event: { sender: { role: 'admin' }, message: [] } })
    check('disabled group still allows blacklist view command', result.sent.some(item => item.includes('群聊昵称黑名单') && item.includes('942033342')), JSON.stringify(result.sent))

    result = await send(ctx, '<at id="90000"/> 昵称 小黑 <at id="3001"/>', {
      guildId: '942033342',
      channelId: '942033342',
      selfId: '90000',
    })
    check('disabled group blocks bot-mentioned nickname binding', result.nextCalled && result.sent.length === 0, JSON.stringify(result))
    check('disabled group nickname binding does not write alias', !fs.existsSync(dataFile), dataFile)

    result = await send(ctx, 'at小明', { guildId: '942033342', channelId: '942033342' })
    check('disabled group blocks at alias command', result.nextCalled && result.sent.length === 0, JSON.stringify(result))

    result = await send(ctx, '群聊昵称黑名单删除 942033342', {
      guildId: '942033342',
      channelId: '942033342',
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin can remove current group from nickname blacklist', result.sent.some(item => item.includes('已移出群聊昵称黑名单：942033342')), JSON.stringify(result.sent))
    check('nickname blacklist delete updates file', !JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), 'utf8'))).includes('942033342'))

    result = await send(ctx, '查看全部昵称', { guildId: '942033342', channelId: '942033342' })
    check('nickname plugin resumes after current group removed from blacklist', result.sent.some(item => item.includes('本群还没有昵称。')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单添加 942033342', {
      userId: '12345',
      author: { id: '12345', name: 'member', nick: 'member' },
      guildId: '942033342',
      channelId: '942033342',
      event: { sender: { role: 'member' }, message: [] },
    })
    check('regular member cannot add nickname blacklist', result.sent.some(item => item.includes('只有群主、群管理员或bot管理员才能操作')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单添加 123456', {
      userId: '12345',
      author: { id: '12345', name: 'member', nick: 'member' },
      guildId: '942033342',
      channelId: '942033342',
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin cannot add another group to nickname blacklist', result.sent.some(item => item.includes('只能操作当前群')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单添加 123456', {
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
    })
    check('bot admin can add any group to nickname blacklist', result.sent.some(item => item.includes('已添加群聊昵称黑名单：123456')), JSON.stringify(result.sent))
    check('bot admin add writes requested group', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), 'utf8'))).includes('123456'))

    result = await send(ctx, '群聊昵称黑名单删除 123456', {
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
    })
    check('bot admin can delete any group from nickname blacklist', result.sent.some(item => item.includes('已移出群聊昵称黑名单：123456')), JSON.stringify(result.sent))

    const plugin = reloadPlugin()
    plugin._test.pendingConfirms.clear()
    plugin._test.pendingConfirms.set('old', Date.now() - 1)
    plugin._test.pendingConfirms.set('fresh', Date.now() + 60000)
    plugin._test.trimPendingConfirms()
    check('pending confirmations trim expired entries', !plugin._test.pendingConfirms.has('old') && plugin._test.pendingConfirms.has('fresh'))
  })

  console.log(`\n=== group-name-at summary ===`)
  console.log(`  passed: ${passed}`)
  console.log(`  failed: ${failed}`)
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
