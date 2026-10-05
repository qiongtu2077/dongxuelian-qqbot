const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert').strict
const { h, Universal } = require('koishi')
const { OneBotMessageEncoder } = require('koishi-plugin-adapter-onebot')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const STORAGE_PATH = path.resolve(__dirname, '..', 'lib', 'storage.js')
const SCHEMA_PATH = path.resolve(__dirname, '..', 'lib', 'scope-schema.js')
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

// 校验文件中两个方向描述同一组唯一关系，且没有失效的用户条目。
function assertBidirectionalStore(store) {
  assert.equal(store.version, 2)
  const expectedUsers = {}
  for (const [alias, userIds] of Object.entries(store.aliases)) {
    assert.ok(Array.isArray(userIds), 'alias should store a user list')
    assert.equal(new Set(userIds).size, userIds.length)
    for (const userId of userIds) (expectedUsers[userId] || (expectedUsers[userId] = [])).push(alias)
  }
  const sortedUsers = Object.fromEntries(Object.entries(store.users).map(([userId, names]) => [userId, [...names].sort()]))
  const expected = Object.fromEntries(Object.entries(expectedUsers).map(([userId, names]) => [userId, names.sort()]))
  assert.deepEqual(sortedUsers, expected)
}

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

  section('collection deletion confirmation ownership')
  await withIsolatedPlugin(async ({ plugin, ctx, scopeDataDir }) => {
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    const createCommand = `创建集合 ${TEST_COLLECTION} <at id="${TEST_MEMBER_ID}"/><at id="${TEST_MEMBER_ID_2}"/>`
    const deleteCommand = `删除集合 ${TEST_COLLECTION}`
    const confirmCommand = `确认删除集合 ${TEST_COLLECTION}`
    await send(ctx, createCommand)
    await send(ctx, createCommand, { guildId: TEST_GROUP_OTHER, channelId: TEST_GROUP_OTHER })
    const originalStore = fs.readFileSync(scopeFile, 'utf8')

    let result = await send(ctx, confirmCommand)
    check('confirmation without a deletion request is silently consumed', result.sent.length === 0 && !result.nextCalled, JSON.stringify(result.sent))

    result = await send(ctx, deleteCommand)
    check('initiator gets a deletion confirmation prompt', result.sent.some(item => item.includes(confirmCommand) && item.includes('60 秒内有效')), JSON.stringify(result.sent))
    const [pendingKey, expiresAt] = [...plugin._test.pendingConfirms.entries()][0]
    check('deletion request does not delete the collection', fs.readFileSync(scopeFile, 'utf8') === originalStore)

    // 无效确认必须静默结束中间件，不能消耗或延长发起者的确认。
    for (const [label, command, overrides] of [
      ['another member', confirmCommand, { userId: TEST_MEMBER_ID_2 }],
      ['same sender in another group', confirmCommand, { guildId: TEST_GROUP_OTHER, channelId: TEST_GROUP_OTHER }],
      ['same sender for another collection', '确认删除集合 another-collection', {}],
    ]) {
      result = await send(ctx, command, overrides)
      check(`${label} confirmation is silently consumed without forwarding`, result.sent.length === 0 && !result.nextCalled, JSON.stringify(result.sent))
      check(`${label} confirmation preserves initiator deadline`, plugin._test.pendingConfirms.size === 1 && plugin._test.pendingConfirms.get(pendingKey) === expiresAt)
    }
    check('invalid confirmations leave all collection members intact', fs.readFileSync(scopeFile, 'utf8') === originalStore)

    result = await send(ctx, confirmCommand)
    check('initiator can still confirm after others tried', result.sent.some(item => item.includes(`已删除集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))
    check('successful confirmation deletes collection and consumes pending request', !JSON.parse(fs.readFileSync(scopeFile, 'utf8')).aliases[TEST_COLLECTION] && plugin._test.pendingConfirms.size === 0)
    result = await send(ctx, confirmCommand)
    check('replayed deletion confirmation is silently consumed', result.sent.length === 0 && !result.nextCalled, JSON.stringify(result.sent))

    await send(ctx, createCommand)
    await send(ctx, deleteCommand)
    const storeBeforeExpiry = fs.readFileSync(scopeFile, 'utf8')
    // 直接设置已存在的截止时间，验证超时而不引入全局假计时器。
    plugin._test.pendingConfirms.set(pendingKey, Date.now() - 1)
    result = await send(ctx, confirmCommand)
    check('expired deletion confirmation is silently consumed', result.sent.length === 0 && !result.nextCalled, JSON.stringify(result.sent))
    check('expired confirmation preserves collection and removes expired request', fs.readFileSync(scopeFile, 'utf8') === storeBeforeExpiry && plugin._test.pendingConfirms.size === 0)
    await send(ctx, deleteCommand)
    result = await send(ctx, confirmCommand)
    check('initiator can request again and confirm after expiry', result.sent.some(item => item.includes(`已删除集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))

    await send(ctx, createCommand)
    await send(ctx, `清空集合 ${TEST_COLLECTION}`)
    const clearRequest = [...plugin._test.pendingConfirms.entries()]
    result = await send(ctx, confirmCommand)
    check('clear request cannot authorize deletion and remains pending', result.sent.length === 0 && !result.nextCalled && JSON.stringify([...plugin._test.pendingConfirms.entries()]) === JSON.stringify(clearRequest))
    result = await send(ctx, `确认清空集合 ${TEST_COLLECTION}`)
    check('clear confirmation retains its existing behavior', result.sent.some(item => item.includes(`已清空集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))

    // 使用 Session 已有的发送者字段验证身份归属，避免缺少 userId 时共享 unknown 身份。
    for (const [label, requester, stranger] of [
      ['author id', { userId: undefined, author: { id: TEST_ADMIN_ID } }, { userId: undefined, author: { id: TEST_MEMBER_ID_2 } }],
      ['event user id', { userId: undefined, event: { user: { id: TEST_ADMIN_ID } } }, { userId: undefined, event: { user: { id: TEST_MEMBER_ID_2 } } }],
      ['numeric user id', { userId: Number(TEST_ADMIN_ID) }, { userId: Number(TEST_MEMBER_ID_2) }],
    ]) {
      await send(ctx, createCommand)
      await send(ctx, deleteCommand, requester)
      result = await send(ctx, confirmCommand, stranger)
      check(`${label} keeps other sender confirmation silent`, result.sent.length === 0 && !result.nextCalled, JSON.stringify(result.sent))
      result = await send(ctx, confirmCommand, { userId: TEST_ADMIN_ID })
      check(`${label} requester can confirm with normalized userId`, result.sent.some(item => item.includes(`已删除集合「${TEST_COLLECTION}」`)), JSON.stringify(result.sent))
    }

    await send(ctx, createCommand)
    const storeBeforeUnidentifiedSender = fs.readFileSync(scopeFile, 'utf8')
    const unidentifiedSender = { userId: undefined, author: {}, event: {} }
    await send(ctx, deleteCommand, unidentifiedSender)
    check('missing sender identity cannot create a shared confirmation request', plugin._test.pendingConfirms.size === 0)
    result = await send(ctx, confirmCommand, unidentifiedSender)
    check('missing sender identity cannot confirm deletion', result.sent.length === 0 && !result.nextCalled && fs.readFileSync(scopeFile, 'utf8') === storeBeforeUnidentifiedSender)

    result = await send(ctx, '普通聊天消息')
    check('ordinary chat still reaches downstream middleware', result.nextCalled && result.sent.length === 0)
  })

  section('bidirectional migration and indexed lookup')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    const details = { displayName: 'fixture-user', createdBy: TEST_ADMIN_ID, createdAt: '2026-01-01T00:00:00.000Z' }
    const oldData = JSON.stringify({ version: 1, scopeId: TEST_GROUP_MAIN, aliases: {
      'name-a': { members: [{ userId: TEST_MEMBER_ID, ...details }] },
      'name-b': { members: [{ userId: TEST_MEMBER_ID, ...details }] },
      'shared-set': { members: [TEST_MEMBER_ID, TEST_MEMBER_ID_2].map(userId => ({ userId, ...details })) },
      'other-name': { members: [{ userId: TEST_MEMBER_ID_3, displayName: 'other-user' }] },
      'empty-set': { members: [] },
    } })
    fs.mkdirSync(scopeDataDir, { recursive: true })
    fs.writeFileSync(scopeFile, oldData, 'utf8')
    let lookups = 0
    const forbiddenLookup = async () => { lookups++; throw new Error('member lookup should not happen during indexed query') }
    const bot = { getGuildMember: forbiddenLookup, getGroupMember: forbiddenLookup, getUser: forbiddenLookup, internal: { getGroupMemberInfo: forbiddenLookup, get_group_member_info: forbiddenLookup } }
    let result = await send(ctx, `<at id="${TEST_MEMBER_ID}"/> 查看昵称`, { bot })
    let pages = readNicknameRecordPages(result)
    check('migration keeps target nicknames and collection', pages[0].includes('name-a (1)') && pages[0].includes('name-b (1)') && pages[0].includes('shared-set (2)') && !pages[0].includes('other-name'))
    check('member query does not call any QQ member profile API', lookups === 0, String(lookups))
    const stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
    assertBidirectionalStore(stored)
    check('migration persists user-to-name and name-to-user lists', JSON.stringify(stored.users[TEST_MEMBER_ID]) === '["name-a","name-b","shared-set"]' && JSON.stringify(stored.aliases['shared-set']) === JSON.stringify([TEST_MEMBER_ID, TEST_MEMBER_ID_2]))
    check('migration retains member name, creator and timestamp', JSON.stringify(stored.memberDetails['name-a'][TEST_MEMBER_ID]) === JSON.stringify(details))
    check('migration retains empty collections', Array.isArray(stored.aliases['empty-set']) && stored.aliases['empty-set'].length === 0)
    check('migration keeps an exact old-format backup', fs.readFileSync(`${scopeFile}.v1.bak`, 'utf8') === oldData)

    const storage = require(STORAGE_PATH)
    const scope = await storage.loadScopeStore(TEST_GROUP_MAIN)
    const originalUsers = scope.users
    const originalAliases = scope.aliases
    const visitedUsers = []
    const visitedAliases = []
    // 精确查询禁止枚举整个群的索引，也禁止访问不属于目标用户的昵称。
    scope.users = new Proxy(originalUsers, {
      ownKeys() { throw new Error('exact lookup scanned all users') },
      get(target, key) { visitedUsers.push(key); return target[key] },
    })
    scope.aliases = new Proxy(originalAliases, {
      ownKeys() { throw new Error('exact lookup scanned all aliases') },
      get(target, key) { assert.ok(originalUsers[TEST_MEMBER_ID].includes(key)); visitedAliases.push(key); return target[key] },
    })
    try {
      result = await send(ctx, `查看成员 ${TEST_MEMBER_ID}`, { bot })
      pages = readNicknameRecordPages(result)
      check('QQ id lookup visits only target user and its names', visitedUsers.length === 1 && visitedUsers[0] === TEST_MEMBER_ID && visitedAliases.length === 3 && pages[0].includes('shared-set'))
      result = await send(ctx, '查看成员 999999999', { bot })
      check('missing QQ id stops without scanning aliases', readNicknameRecordPages(result)[0].includes('暂时没有昵称') && visitedAliases.length === 3)
      check('cached query does not rewrite store or refresh profiles', fs.readFileSync(scopeFile, 'utf8') === JSON.stringify(stored, null, 2) && lookups === 0)
    } finally {
      scope.users = originalUsers
      scope.aliases = originalAliases
    }
    result = await send(ctx, '查看成员 fixture-user', { bot })
    check('local fuzzy name search keeps all matches without duplicate collections', readNicknameRecordPages(result)[0].split('\n').filter(line => line === 'shared-set (2)').length === 1 && lookups === 0)
    delete require.cache[STORAGE_PATH]
    const reloaded = await require(STORAGE_PATH).loadScopeStore(TEST_GROUP_MAIN)
    check('new format reloads without losing indices or metadata', JSON.stringify(reloaded.users[TEST_MEMBER_ID]) === JSON.stringify(stored.users[TEST_MEMBER_ID]) && reloaded.aliases['name-a'].members[0].createdAt === details.createdAt)
    check('reloading does not overwrite the original backup', fs.readFileSync(`${scopeFile}.v1.bak`, 'utf8') === oldData)
  })

  section('bidirectional mutations')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    for (const [command, expectedAliases] of [
      [`昵称 alpha <at id="${TEST_MEMBER_ID}"/>`, { alpha: [TEST_MEMBER_ID] }],
      [`昵称 alpha <at id="${TEST_MEMBER_ID_2}"/>`, { alpha: [TEST_MEMBER_ID, TEST_MEMBER_ID_2] }],
      [`删除昵称 alpha <at id="${TEST_MEMBER_ID}"/>`, { alpha: [TEST_MEMBER_ID_2] }],
      [`昵称 beta <at id="${TEST_MEMBER_ID}"/>`, { alpha: [TEST_MEMBER_ID_2], beta: [TEST_MEMBER_ID] }],
      ['重命名昵称 beta gamma', { alpha: [TEST_MEMBER_ID_2], gamma: [TEST_MEMBER_ID] }],
      ['复制集合 gamma copy', { alpha: [TEST_MEMBER_ID_2], gamma: [TEST_MEMBER_ID], copy: [TEST_MEMBER_ID] }],
      [`集合添加 copy <at id="${TEST_MEMBER_ID_2}"/>`, { alpha: [TEST_MEMBER_ID_2], gamma: [TEST_MEMBER_ID], copy: [TEST_MEMBER_ID, TEST_MEMBER_ID_2] }],
      [`集合删除 copy <at id="${TEST_MEMBER_ID}"/>`, { alpha: [TEST_MEMBER_ID_2], gamma: [TEST_MEMBER_ID], copy: [TEST_MEMBER_ID_2] }],
      ['合并集合 gamma alpha', { alpha: [TEST_MEMBER_ID_2], gamma: [TEST_MEMBER_ID, TEST_MEMBER_ID_2], copy: [TEST_MEMBER_ID_2] }],
      [`删除昵称 alpha <at id="${TEST_MEMBER_ID_2}"/>`, { gamma: [TEST_MEMBER_ID, TEST_MEMBER_ID_2], copy: [TEST_MEMBER_ID_2] }],
      ['清空集合 copy', { gamma: [TEST_MEMBER_ID, TEST_MEMBER_ID_2], copy: [TEST_MEMBER_ID_2] }],
      ['确认清空集合 copy', { gamma: [TEST_MEMBER_ID, TEST_MEMBER_ID_2], copy: [] }],
      ['删除集合 gamma', { gamma: [TEST_MEMBER_ID, TEST_MEMBER_ID_2], copy: [] }],
      ['确认删除集合 gamma', { copy: [] }],
    ]) {
      const result = await send(ctx, command)
      const stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
      assertBidirectionalStore(stored)
      check(`indices remain consistent after ${command}`, JSON.stringify(stored.aliases) === JSON.stringify(expectedAliases), JSON.stringify({ sent: result.sent, aliases: stored.aliases }))
    }
  })

  section('explicit aggregate migration')
  await withIsolatedPlugin(async ({ ctx, dataFile }) => {
    const member = { userId: TEST_MEMBER_ID, displayName: 'legacy-user', createdBy: TEST_ADMIN_ID, createdAt: '2026-01-01T00:00:00.000Z' }
    const oldData = JSON.stringify({ scopes: {
      [TEST_GROUP_MAIN]: { aliases: { first: { members: [member] } } },
      [TEST_GROUP_OTHER]: { aliases: { second: { members: [member] }, empty: { members: [] } } },
    } })
    fs.writeFileSync(dataFile, oldData, 'utf8')
    let result = await send(ctx, `查看成员 ${TEST_MEMBER_ID}`)
    check('aggregate migration supports indexed member query', readNicknameRecordPages(result)[0].includes('first (1)'))
    let stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assertBidirectionalStore(stored.scopes[TEST_GROUP_MAIN])
    assertBidirectionalStore(stored.scopes[TEST_GROUP_OTHER])
    check('aggregate migration preserves other groups and empty collections', stored.scopes[TEST_GROUP_OTHER].aliases.second[0] === TEST_MEMBER_ID && stored.scopes[TEST_GROUP_OTHER].aliases.empty.length === 0)
    check('aggregate migration backs up the old file exactly', fs.readFileSync(`${dataFile}.v1.bak`, 'utf8') === oldData)
    const otherGroup = JSON.stringify(stored.scopes[TEST_GROUP_OTHER])
    result = await send(ctx, `昵称 third <at id="${TEST_MEMBER_ID_3}"/>`)
    stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assertBidirectionalStore(stored.scopes[TEST_GROUP_MAIN])
    check('updates after aggregate migration preserve other group data', JSON.stringify(stored.scopes[TEST_GROUP_OTHER]) === otherGroup && stored.scopes[TEST_GROUP_MAIN].users[TEST_MEMBER_ID_3][0] === 'third')
    delete require.cache[STORAGE_PATH]
    const reloaded = await require(STORAGE_PATH).loadScopeStore(TEST_GROUP_MAIN)
    check('aggregate new format reloads both indices and binding metadata', reloaded.users[TEST_MEMBER_ID][0] === 'first' && reloaded.aliases.first.members[0].createdAt === member.createdAt)
  }, { legacyStore: true })

  await withIsolatedPlugin(async ({ ctx, dataFile }) => {
    fs.writeFileSync(dataFile, JSON.stringify({ scopes: {
      [TEST_GROUP_MAIN]: { aliases: { existing: { members: [{ userId: TEST_MEMBER_ID, displayName: 'legacy-user' }] } } },
    } }), 'utf8')
    await Promise.all([
      send(ctx, `昵称 other-first <at id="${TEST_MEMBER_ID_2}"/>`, { guildId: TEST_GROUP_OTHER, channelId: TEST_GROUP_OTHER }),
      send(ctx, `昵称 main-second <at id="${TEST_MEMBER_ID_3}"/>`),
    ])
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    check('concurrent aggregate migration keeps newly created group', !!stored.scopes[TEST_GROUP_OTHER]?.users[TEST_MEMBER_ID_2])
    check('concurrent aggregate migration keeps existing group changes', !!stored.scopes[TEST_GROUP_MAIN]?.users[TEST_MEMBER_ID_3])
  }, { legacyStore: true })

  const schema = require(SCHEMA_PATH)
  check('unsupported schema version is rejected', (() => {
    try { schema.normalizeScopeStore(TEST_GROUP_MAIN, { version: 3, aliases: {} }); return false }
    catch (error) { return error.message.includes('unsupported nickname store version: 3') }
  })())

  section('concurrent bidirectional updates')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    await Promise.all([
      send(ctx, `昵称 simultaneous <at id="${TEST_MEMBER_ID}"/>`),
      send(ctx, `昵称 simultaneous <at id="${TEST_MEMBER_ID_2}"/>`),
    ])
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    let stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
    assertBidirectionalStore(stored)
    check('simultaneous first bindings keep both users', stored.aliases.simultaneous.length === 2)
    await Promise.all([
      send(ctx, `集合添加 simultaneous <at id="${TEST_MEMBER_ID_3}"/>`),
      send(ctx, `集合添加 simultaneous <at id="${TEST_ADMIN_ID}"/>`),
    ])
    stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
    assertBidirectionalStore(stored)
    check('simultaneous collection additions keep all users', stored.aliases.simultaneous.length === 4)
    await Promise.all([
      send(ctx, `昵称 duplicate <at id="${TEST_MEMBER_ID}"/>`),
      send(ctx, `昵称 duplicate <at id="${TEST_MEMBER_ID}"/>`),
    ])
    stored = JSON.parse(fs.readFileSync(scopeFile, 'utf8'))
    assertBidirectionalStore(stored)
    check('simultaneous duplicate bindings remain unique', stored.aliases.duplicate.length === 1)
  })

  section('invalid bidirectional index')
  await withIsolatedPlugin(async ({ ctx, scopeDataDir }) => {
    const scopeFile = getScopeFile(scopeDataDir, TEST_GROUP_MAIN)
    const raw = JSON.stringify({ version: 2, scopeId: TEST_GROUP_MAIN, aliases: { broken: [TEST_MEMBER_ID] }, users: {} })
    fs.mkdirSync(scopeDataDir, { recursive: true })
    fs.writeFileSync(scopeFile, raw, 'utf8')
    const result = await send(ctx, `查看成员 ${TEST_MEMBER_ID}`)
    check('inconsistent index reports read failure instead of an empty result', result.sent.some(item => item.includes('昵称数据读取失败')))
    check('inconsistent index is not overwritten', fs.readFileSync(scopeFile, 'utf8') === raw)
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
