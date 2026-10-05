const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert').strict
const { h, Universal } = require('koishi')
const { OneBotMessageEncoder } = require('koishi-plugin-adapter-onebot')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const STORAGE_PATH = path.resolve(__dirname, '..', 'lib', 'storage.js')
const TEST_GROUP_MAIN = 'test-group-main'
const TEST_GROUP_OTHER = 'test-group-other'
const TEST_BLACKLIST_GROUP = '900000001'
const TEST_BLACKLIST_OTHER = '900000002'
const TEST_BOT_ID = '900000000'
const TEST_ADMIN_ID = '900000100'
const TEST_MEMBER_ID = '900000101'
const TEST_MEMBER_ID_2 = '900000102'
const TEST_MEMBER_ID_3 = '900000103'
const TEST_ALIAS = 'alias-one'
const TEST_ALIAS_RISK = 'alias-risk'
const TEST_LEGACY_ALIAS = 'legacy-alias'
const TEST_COLLECTION = 'collection-one'
const TEST_BOUNDARY_COLLECTION = 'collection-boundary'

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
  delete require.cache[STORAGE_PATH]
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
    userId: TEST_ADMIN_ID,
    guildId: TEST_GROUP_MAIN,
    channelId: TEST_GROUP_MAIN,
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

// --- 消息记录验证 --- #

// 校验查询只发送一份消息记录，并读取其中每条消息的纯文本正文。
function readNicknameRecordPages(result) {
  assert.equal(result.sent.length, 1, 'nickname query should send one record')
  const records = h.parse(result.sent[0])
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.type, 'message')
  assert.ok('forward' in record.attrs, 'nickname query should be a forward record')
  return record.children.map(page => {
    assert.equal(page.type, 'message')
    assert.ok(page.children.every(child => child.type === 'text'))
    return page.children.map(child => child.attrs.content).join('')
  })
}

// 使用已安装的真实 OneBot 编码器，检查群聊和私聊各发送一次合并转发。
async function encodeNicknameRecord(content, isDirect) {
  const calls = []
  const channelId = isDirect ? `private:${TEST_MEMBER_ID}` : TEST_BLACKLIST_GROUP
  const bot = {
    selfId: TEST_BOT_ID,
    userId: TEST_BOT_ID,
    user: { name: 'fixture-bot' },
    session() { return { event: { message: {} }, app: { emit() {} } } },
    internal: {
      async sendGroupForwardMsg(groupId, messages) {
        calls.push({ method: 'group', target: groupId, messages })
        return 1
      },
      async sendPrivateForwardMsg(userId, messages) {
        calls.push({ method: 'private', target: userId, messages })
        return 1
      },
    },
  }
  const encoder = new OneBotMessageEncoder(bot, channelId)
  encoder.session = {
    event: { channel: { type: isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT } },
    channelId,
    guildId: isDirect ? undefined : channelId,
    isDirect,
  }
  await encoder.render(h.parse(content), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, isDirect ? 'private' : 'group')
  assert.equal(calls[0].target, isDirect ? TEST_MEMBER_ID : TEST_BLACKLIST_GROUP)
  return calls[0].messages
}

// --- 隔离数据与插件运行 --- #

function safeScopeFileName(scopeId) {
  return encodeURIComponent(String(scopeId || 'global'))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function getScopeFile(scopeDataDir, scopeId) {
  return path.join(scopeDataDir, `${safeScopeFileName(scopeId)}.json`)
}

async function withIsolatedPlugin(fn, options = {}) {
  const oldEnv = {
    GROUP_NAME_AT_DATA_FILE: process.env.GROUP_NAME_AT_DATA_FILE,
    GROUP_NAME_AT_DATA_DIR: process.env.GROUP_NAME_AT_DATA_DIR,
    GROUP_NAME_AT_ADMIN_IDS_FILE: process.env.GROUP_NAME_AT_ADMIN_IDS_FILE,
    DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-name-at-'))
  const dataDir = path.join(tmpRoot, 'data')
  const dataFile = path.join(dataDir, 'nickname-collections.json')
  const scopeDataDir = path.join(dataDir, 'nickname-collections')
  const adminIdsFile = path.join(dataDir, 'ai-admin-ids.json')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  if (options.legacyStore) process.env.GROUP_NAME_AT_DATA_FILE = dataFile
  else delete process.env.GROUP_NAME_AT_DATA_FILE
  process.env.GROUP_NAME_AT_DATA_DIR = scopeDataDir
  process.env.GROUP_NAME_AT_ADMIN_IDS_FILE = adminIdsFile
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(adminIdsFile, JSON.stringify([TEST_ADMIN_ID]), 'utf8')
  delete require.cache[PLUGIN_PATH]
  delete require.cache[STORAGE_PATH]

  try {
    const plugin = reloadPlugin()
    const ctx = makeCtx()
    plugin.apply(ctx)
    await fn({ plugin, ctx, tmpRoot, dataDir, dataFile, scopeDataDir, adminIdsFile })
  } finally {
    delete require.cache[PLUGIN_PATH]
    delete require.cache[STORAGE_PATH]
    if (oldEnv.GROUP_NAME_AT_DATA_FILE === undefined) delete process.env.GROUP_NAME_AT_DATA_FILE
    else process.env.GROUP_NAME_AT_DATA_FILE = oldEnv.GROUP_NAME_AT_DATA_FILE
    if (oldEnv.GROUP_NAME_AT_DATA_DIR === undefined) delete process.env.GROUP_NAME_AT_DATA_DIR
    else process.env.GROUP_NAME_AT_DATA_DIR = oldEnv.GROUP_NAME_AT_DATA_DIR
    if (oldEnv.GROUP_NAME_AT_ADMIN_IDS_FILE === undefined) delete process.env.GROUP_NAME_AT_ADMIN_IDS_FILE
    else process.env.GROUP_NAME_AT_ADMIN_IDS_FILE = oldEnv.GROUP_NAME_AT_ADMIN_IDS_FILE
    if (oldEnv.DONGXUELIAN_AI_DATA_DIR === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = oldEnv.DONGXUELIAN_AI_DATA_DIR
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

async function run() {
  section('env path and command behavior')
  await withIsolatedPlugin(async ({ ctx, tmpRoot, dataFile, scopeDataDir }) => {
    await ctx.emit('ready')

    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    let result = await send(ctx, `创建集合 ${TEST_COLLECTION} <at id="${TEST_MEMBER_ID}"/><at id="${TEST_MEMBER_ID_2}"/>`)
    check('creates collection through middleware', result.sent.some(item => item.includes(`已创建集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))
    check('writes scoped data file', fs.existsSync(scopeFile), scopeFile)
    check('scoped data file stays inside temp root', path.resolve(scopeFile).startsWith(path.resolve(tmpRoot)), scopeFile)
    check('does not create legacy aggregate file by default', !fs.existsSync(dataFile), dataFile)

    result = await send(ctx, `集合添加 ${TEST_COLLECTION} <at id="${TEST_MEMBER_ID_3}"/>`)
    check('adds collection member', result.sent.some(item => item.includes(`已向集合「${TEST_COLLECTION}」添加 1 人`)), JSON.stringify(result.sent))

    result = await send(ctx, `查看集合 ${TEST_COLLECTION}`)
    check('views collection by collection command', result.sent.some(item => item.includes(`集合：${TEST_COLLECTION}`)), JSON.stringify(result.sent))
    check('view collection includes member count', result.sent.some(item => item.includes('人数：3')), JSON.stringify(result.sent))

    result = await send(ctx, `清空集合 ${TEST_COLLECTION}`)
    check('clear collection asks for confirmation first', result.sent.some(item => item.includes(`确认清空集合 ${TEST_COLLECTION}`)), JSON.stringify(result.sent))

    result = await send(ctx, `确认清空集合 ${TEST_COLLECTION}`)
    check('clear collection confirmation succeeds', result.sent.some(item => item.includes(`已清空集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))

    await send(ctx, `集合添加 ${TEST_COLLECTION} <at id="${TEST_MEMBER_ID}"/>`)
    result = await send(ctx, `删除集合 ${TEST_COLLECTION}`)
    check('delete collection asks for confirmation first', result.sent.some(item => item.includes(`确认删除集合 ${TEST_COLLECTION}`)), JSON.stringify(result.sent))

    result = await send(ctx, `确认删除集合 ${TEST_COLLECTION}`)
    check('delete collection confirmation succeeds', result.sent.some(item => item.includes(`已删除集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))

    result = await send(ctx, `昵称 ${TEST_ALIAS} <at id="${TEST_MEMBER_ID}"/>`)
    check('binds alias through middleware', result.sent.some(item => item.includes(`昵称“${TEST_ALIAS}”成功绑定到用户`)), JSON.stringify(result.sent))

    result = await send(ctx, `昵称 ${TEST_ALIAS_RISK} <at id="${TEST_MEMBER_ID_2}"/>`, {
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })
    check('send failure is caught inside nickname plugin', result.sent.length === 0 && result.logs.some(log => log.level === 'warn' && log.msg.includes('send failed')), JSON.stringify(result))

    result = await send(ctx, '查看全部昵称')
    check('alias list command is not stolen by collection list', result.sent.some(item => item.includes('本群昵称：') && item.includes(TEST_ALIAS)), JSON.stringify(result.sent))

    result = await send(ctx, '查看全部集合')
    check('collection list command is separate from alias list', result.sent.some(item => item.includes('本群还没有集合。')), JSON.stringify(result.sent))

    const stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
    check('store writes atomically and remains parseable', stored && stored.scopeId === TEST_GROUP_MAIN && stored.aliases && stored.aliases[TEST_ALIAS], JSON.stringify(stored))

    result = await send(ctx, '查看全部昵称', { guildId: TEST_GROUP_OTHER, channelId: TEST_GROUP_OTHER })
    check('scoped store keeps other group isolated', result.sent.some(item => item.includes('本群还没有昵称。')), JSON.stringify(result.sent))

    result = await send(ctx, `<at id="${TEST_MEMBER_ID}"/> 查看昵称`)
    check('member nickname lookup supports mention before command with space', result.sent.some(item => item.includes(TEST_ALIAS)), JSON.stringify(result.sent))

    result = await send(ctx, `<at id="${TEST_MEMBER_ID}"/>查看昵称`)
    check('member nickname lookup supports mention before command without space', result.sent.some(item => item.includes(TEST_ALIAS)), JSON.stringify(result.sent))

    result = await send(ctx, `查看昵称 <at id="${TEST_MEMBER_ID}"/>`)
    check('member nickname lookup supports command before mention with space', result.sent.some(item => item.includes(TEST_ALIAS)), JSON.stringify(result.sent))

    result = await send(ctx, `查看昵称<at id="${TEST_MEMBER_ID}"/>`)
    check('member nickname lookup supports command before mention without space', result.sent.some(item => item.includes(TEST_ALIAS)), JSON.stringify(result.sent))
  })

  section('nickname query forward records')
  for (const count of [0, 1, 99, 100, 101, 200, 201]) {
    await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
      const expectedLines = Array.from({ length: count }, (_, index) => `nickname-${String(index).padStart(3, '0')} (1)`)
      const aliases = Object.fromEntries(expectedLines.map(line => [line.slice(0, -4), {
        members: [{ userId: TEST_MEMBER_ID, displayName: `U${TEST_MEMBER_ID}` }],
      }]))
      // 群昵称列表排除集合和空条目；成员查询排除未绑定目标成员的集合。
      aliases['other-collection'] = { members: [TEST_MEMBER_ID_2, TEST_MEMBER_ID_3].map(userId => ({ userId, displayName: `U${userId}` })) }
      aliases['empty-collection'] = { members: [] }
      const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
      fs.mkdirSync(scopeDataDir, { recursive: true })
      fs.writeFileSync(scopeFile, JSON.stringify({ scopeId: TEST_GROUP_MAIN, aliases }), 'utf8')
      await ctx.emit('ready')

      for (const command of ['查看全部昵称', `查看昵称 <at id="${TEST_MEMBER_ID}"/>`]) {
        const result = await send(ctx, command)
        const pages = readNicknameRecordPages(result)
        const lines = pages.flatMap(page => page.split('\n').slice(1))
        check(`forward record: ${command} with ${count} aliases has expected pages`, pages.length === Math.max(1, Math.ceil(count / 100)), JSON.stringify(pages))
        check(`forward record: ${command} keeps all ${count} aliases in order`, JSON.stringify(lines) === JSON.stringify(expectedLines), JSON.stringify(lines))
        check(`forward record: ${command} has at most 100 aliases per message`, pages.every(page => page.split('\n').length - 1 <= 100), JSON.stringify(pages))
        check(`forward record: ${command} consumes the query`, !result.nextCalled)
        if (count === 0) check(`forward record: ${command} keeps empty result hint`, pages[0].includes(command === '查看全部昵称' ? '本群还没有昵称' : '暂时没有昵称'))
      }

      if (count !== 201) return
      for (const command of [
        'nicklist',
        `<at id="${TEST_MEMBER_ID}"/> 查看昵称`,
        `<at id="${TEST_MEMBER_ID}"/>查看昵称`,
        `查看昵称<at id="${TEST_MEMBER_ID}"/>`,
        `<at id="${TEST_MEMBER_ID}"/> 昵称`,
        `查看成员 <at id="${TEST_MEMBER_ID}"/>`,
        `查看成员 ${TEST_MEMBER_ID}`,
      ]) {
        const pages = readNicknameRecordPages(await send(ctx, command))
        check(`forward record: query alias ${command} uses 100/100/1 pages`, JSON.stringify(pages.map(page => page.split('\n').length - 1)) === '[100,100,1]')
      }

      const session = makeSession('nicklist')
      await ctx.commands.find(command => command.name === 'nicklist').fn({ session })
      const commandPages = readNicknameRecordPages({ sent: session.sent })
      check('forward record: registered nicklist action sends paginated record', commandPages.length === 3)

      const result = await send(ctx, '查看全部昵称')
      for (const isDirect of [false, true]) {
        const nodes = await encodeNicknameRecord(result.sent[0], isDirect)
        check(`forward record: real OneBot encoder ${isDirect ? 'private' : 'group'} preserves 100/100/1 pages`, JSON.stringify(nodes.map(node => node.data.content[0].data.text.split('\n').length - 1)) === '[100,100,1]')
      }
    })
  }

  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    const specialAlias = '<at id="900000104"/>&昵称'
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    fs.mkdirSync(scopeDataDir, { recursive: true })
    fs.writeFileSync(scopeFile, JSON.stringify({ aliases: {
      [specialAlias]: { members: [{ userId: TEST_MEMBER_ID, displayName: `U${TEST_MEMBER_ID}` }] },
      'shared-collection': { members: [TEST_MEMBER_ID, TEST_MEMBER_ID_2].map(userId => ({ userId, displayName: `U${userId}` })) },
    } }), 'utf8')
    const groupResult = await send(ctx, '查看全部昵称')
    const groupPages = readNicknameRecordPages(groupResult)
    check('forward record: nickname message tags remain literal text', groupPages[0].includes(specialAlias), JSON.stringify(groupPages))
    const nodes = await encodeNicknameRecord(groupResult.sent[0], false)
    check('forward record: OneBot receives text without injected mentions', nodes[0].data.content.every(segment => segment.type === 'text') && nodes[0].data.content[0].data.text.includes(specialAlias), JSON.stringify(nodes))

    const memberPages = readNicknameRecordPages(await send(ctx, `查看昵称 <at id="${TEST_MEMBER_ID}"/>`))
    check('forward record: member lookup retains nickname and collection bindings', memberPages[0].includes(specialAlias) && memberPages[0].includes('shared-collection (2)'), JSON.stringify(memberPages))

    const collections = await send(ctx, '查看全部集合')
    check('forward record: collection list retains ordinary text behavior', collections.sent.length === 1 && collections.sent[0].startsWith('本群集合：'), JSON.stringify(collections))

    const failure = await send(ctx, '查看全部昵称', {
      async send() { throw new Error('retcode: 1200 risk control') },
    })
    check('forward record: send failure is caught without extra messages', failure.sent.length === 0 && !failure.nextCalled && failure.logs.some(log => log.level === 'warn' && log.msg.includes('send failed')), JSON.stringify(failure))
  })

  section('corrupt json handling')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    fs.mkdirSync(path.dirname(scopeFile), { recursive: true })
    fs.writeFileSync(scopeFile, '{ broken json', 'utf8')
    await ctx.emit('ready')

    const result = await send(ctx, '查看全部昵称')
    check('corrupt json returns friendly read failure', result.sent.some(item => item.includes('昵称数据读取失败')), JSON.stringify(result.sent))
    check('corrupt json is not overwritten', fs.readFileSync(scopeFile, 'utf8') === '{ broken json')
    check('corrupt json warning is logged', ctx.logs.some(log => log.level === 'warn'))
  })

  section('legacy migration and compatibility')
  await withIsolatedPlugin(async ({ ctx, dataFile, scopeDataDir }) => {
    fs.writeFileSync(dataFile, JSON.stringify({
      scopes: {
        [TEST_GROUP_MAIN]: {
          aliases: {
            [TEST_LEGACY_ALIAS]: {
              members: [{ userId: TEST_MEMBER_ID, displayName: 'fixture-user', createdBy: TEST_ADMIN_ID, createdAt: '2026-01-01T00:00:00.000Z' }],
            },
          },
        },
      },
    }), 'utf8')
    await ctx.emit('ready')

    const result = await send(ctx, `查看昵称 ${TEST_LEGACY_ALIAS}`)
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    check('legacy aggregate data migrates lazily for current group', result.sent.some(item => item.includes(`昵称：${TEST_LEGACY_ALIAS}`)), JSON.stringify(result.sent))
    check('lazy migration writes scoped file', fs.existsSync(scopeFile), scopeFile)
    check('lazy migration leaves legacy aggregate file in place', fs.existsSync(dataFile), dataFile)
  })

  await withIsolatedPlugin(async ({ ctx, dataFile, scopeDataDir }) => {
    await ctx.emit('ready')

    const result = await send(ctx, `昵称 ${TEST_ALIAS} <at id="${TEST_MEMBER_ID}"/>`)
    check('explicit legacy data file mode still binds alias', result.sent.some(item => item.includes(`昵称“${TEST_ALIAS}”成功绑定到用户`)), JSON.stringify(result.sent))
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    check('explicit legacy data file mode writes aggregate file', stored && stored.scopes && stored.scopes[TEST_GROUP_MAIN]?.aliases?.[TEST_ALIAS], JSON.stringify(stored))
    check('explicit legacy data file mode does not require scoped file', !fs.existsSync(getScopeFile(scopeDataDir, TEST_GROUP_MAIN)), scopeDataDir)
  }, { legacyStore: true })

  section('boundary and edge cases')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
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

    result = await send(ctx, `创建集合 ${TEST_BOUNDARY_COLLECTION} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: create first collection returns success', result.sent.some(item => item.includes('已创建')), JSON.stringify(result.sent))
    result = await send(ctx, `创建集合 ${TEST_BOUNDARY_COLLECTION} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: duplicate creation does not crash', !result.sent.some(item => item.includes('崩溃') || item.includes('错误')), JSON.stringify(result.sent))

    result = await send(ctx, `at${TEST_BOUNDARY_COLLECTION}`)
    check('boundary: mention collection returns mention or notice', result.sent.length > 0, JSON.stringify(result.sent))

    result = await send(ctx, `at${TEST_BOUNDARY_COLLECTION}`, {
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })
    check('boundary: mention collection send failure is caught', result.sent.length === 0 && result.logs.some(log => log.level === 'warn' && log.msg.includes('send failed')), JSON.stringify(result))

    const maxAsciiAlias = 'a'.repeat(512)
    result = await send(ctx, `昵称 ${maxAsciiAlias} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: 512 byte alias is accepted', result.sent.some(item => item.includes(`昵称“${maxAsciiAlias}”成功绑定到用户`)), JSON.stringify(result.sent))

    const tooLongAsciiAlias = 'b'.repeat(513)
    result = await send(ctx, `昵称 ${tooLongAsciiAlias} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: 513 byte alias is rejected', result.sent.some(item => item.includes('昵称超限，最大512字符')), JSON.stringify(result.sent))
    const storedAfterTooLongAlias = JSON.parse(fs.readFileSync(getScopeFile(scopeDataDir, TEST_GROUP_MAIN), 'utf8'))
    check('boundary: rejected overlong alias is not stored', !storedAfterTooLongAlias.aliases[tooLongAsciiAlias], JSON.stringify(storedAfterTooLongAlias.aliases))

    const maxUtf8Alias = '测'.repeat(170) + 'ab'
    result = await send(ctx, `昵称 ${maxUtf8Alias} <at id="${TEST_MEMBER_ID_2}"/>`)
    check('boundary: 512 byte utf8 alias is accepted', result.sent.some(item => item.includes('成功绑定到用户')), JSON.stringify(result.sent))

    const tooLongUtf8Alias = '测'.repeat(171)
    result = await send(ctx, `昵称 ${tooLongUtf8Alias} <at id="${TEST_MEMBER_ID_2}"/>`)
    check('boundary: 513 byte utf8 alias is rejected', result.sent.some(item => item.includes('昵称超限，最大512字符')), JSON.stringify(result.sent))

    result = await send(ctx, `创建集合 ${tooLongAsciiAlias} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: overlong collection name is rejected', result.sent.some(item => item.includes('昵称超限，最大512字符')), JSON.stringify(result.sent))

    const renameSource = 'rename-source'
    result = await send(ctx, `创建集合 ${renameSource} <at id="${TEST_MEMBER_ID}"/>`)
    check('boundary: create rename source collection succeeds', result.sent.some(item => item.includes(`已创建集合「${renameSource}」`)), JSON.stringify(result.sent))
    result = await send(ctx, `重命名集合 ${renameSource} ${tooLongAsciiAlias}`)
    check('boundary: overlong rename target is rejected', result.sent.some(item => item.includes('昵称超限，最大512字符')), JSON.stringify(result.sent))
    result = await send(ctx, `查看集合 ${renameSource}`)
    check('boundary: rejected overlong rename keeps source entry', result.sent.some(item => item.includes(renameSource) && item.includes('人数：1')), JSON.stringify(result.sent))

    result = await send(ctx, `复制集合 ${renameSource} ${tooLongAsciiAlias}`)
    check('boundary: overlong copy target is rejected', result.sent.some(item => item.includes('昵称超限，最大512字符')), JSON.stringify(result.sent))
  })

  section('runtime disabled groups and cleanup')
  await withIsolatedPlugin(async ({ ctx, dataDir, scopeDataDir }) => {
    await ctx.emit('ready')
    let result = await send(ctx, '查看全部昵称', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP })
    check('no source hardcoded group blacklist by default', result.sent.some(item => item.includes('本群还没有昵称。')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单查看', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP, event: { sender: { role: 'admin' }, message: [] } })
    check('nickname blacklist view handles empty list', result.sent.some(item => item.includes('群聊昵称黑名单为空。')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单添加', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP, event: { sender: { role: 'admin' }, message: [] } })
    check('nickname blacklist add requires group id', result.sent.some(item => item.includes('请指定群号。')), JSON.stringify(result.sent))

    result = await send(ctx, '群聊昵称黑名单删除 abc', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP, event: { sender: { role: 'admin' }, message: [] } })
    check('nickname blacklist delete rejects invalid group id', result.sent.some(item => item.includes('群号必须是数字。')), JSON.stringify(result.sent))

    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), JSON.stringify({ groups: [TEST_BLACKLIST_GROUP] }), 'utf8')
    result = await send(ctx, '查看全部昵称', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP })
    check('runtime disabled group file blocks nickname plugin', result.nextCalled && result.sent.length === 0, JSON.stringify(result))

    result = await send(ctx, '群聊昵称黑名单查看', { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP, event: { sender: { role: 'admin' }, message: [] } })
    check('disabled group still allows blacklist view command', result.sent.some(item => item.includes('群聊昵称黑名单') && item.includes(TEST_BLACKLIST_GROUP)), JSON.stringify(result.sent))

    result = await send(ctx, `<at id="${TEST_BOT_ID}"/> 昵称 ${TEST_ALIAS} <at id="${TEST_MEMBER_ID}"/>`, {
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      selfId: TEST_BOT_ID,
    })
    check('disabled group blocks bot-mentioned nickname binding', result.nextCalled && result.sent.length === 0, JSON.stringify(result))
    check('disabled group nickname binding does not write alias', !fs.existsSync(getScopeFile(scopeDataDir, TEST_BLACKLIST_GROUP)), scopeDataDir)

    result = await send(ctx, `at${TEST_ALIAS}`, { guildId: TEST_BLACKLIST_GROUP, channelId: TEST_BLACKLIST_GROUP })
    check('disabled group blocks at alias command', result.nextCalled && result.sent.length === 0, JSON.stringify(result))

    result = await send(ctx, `群聊昵称黑名单删除 ${TEST_BLACKLIST_GROUP}`, {
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin can remove current group from nickname blacklist', result.sent.some(item => item.includes(`已移出群聊昵称黑名单：${TEST_BLACKLIST_GROUP}`)), JSON.stringify(result.sent))
    check('nickname blacklist delete updates file', !JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), 'utf8'))).includes(TEST_BLACKLIST_GROUP))

    result = await send(ctx, `群聊昵称黑名单添加${TEST_BLACKLIST_GROUP}`, {
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin can add current group without command space', result.sent.some(item => item.includes(`已添加群聊昵称黑名单：${TEST_BLACKLIST_GROUP}`)), JSON.stringify(result.sent))

    result = await send(ctx, `群聊昵称黑名单删除${TEST_BLACKLIST_GROUP}`, {
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin can delete current group without command space', result.sent.some(item => item.includes(`已移出群聊昵称黑名单：${TEST_BLACKLIST_GROUP}`)), JSON.stringify(result.sent))

    result = await send(ctx, `群聊昵称黑名单添加 ${TEST_BLACKLIST_GROUP}`, {
      userId: TEST_MEMBER_ID,
      author: { id: TEST_MEMBER_ID, name: 'member', nick: 'member' },
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      event: { sender: { role: 'member' }, message: [] },
    })
    check('regular member cannot add nickname blacklist', result.sent.some(item => item.includes('只有群主、群管理员或bot管理员才能操作')), JSON.stringify(result.sent))

    result = await send(ctx, `群聊昵称黑名单添加 ${TEST_BLACKLIST_OTHER}`, {
      userId: TEST_MEMBER_ID,
      author: { id: TEST_MEMBER_ID, name: 'member', nick: 'member' },
      guildId: TEST_BLACKLIST_GROUP,
      channelId: TEST_BLACKLIST_GROUP,
      event: { sender: { role: 'admin' }, message: [] },
    })
    check('group admin cannot add another group to nickname blacklist', result.sent.some(item => item.includes('只能操作当前群')), JSON.stringify(result.sent))

    result = await send(ctx, `群聊昵称黑名单添加 ${TEST_BLACKLIST_OTHER}`, {
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
    })
    check('bot admin can add any group to nickname blacklist', result.sent.some(item => item.includes(`已添加群聊昵称黑名单：${TEST_BLACKLIST_OTHER}`)), JSON.stringify(result.sent))
    check('bot admin add writes requested group', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'group-name-at-disabled-groups.json'), 'utf8'))).includes(TEST_BLACKLIST_OTHER))

    result = await send(ctx, `群聊昵称黑名单删除 ${TEST_BLACKLIST_OTHER}`, {
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
    })
    check('bot admin can delete any group from nickname blacklist', result.sent.some(item => item.includes(`已移出群聊昵称黑名单：${TEST_BLACKLIST_OTHER}`)), JSON.stringify(result.sent))

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
