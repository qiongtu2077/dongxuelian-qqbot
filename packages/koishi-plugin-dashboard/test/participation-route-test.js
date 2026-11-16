'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { WebSocketServer } = require('ws')
const { executeConfigTransaction } = require('../lib/config-transaction')

// 加载真实路由、配置校验和事务，仅隔离 HTTP 外壳与管理员鉴权。
function loadRoutes(dataDir, policy, state) {
  const filename = path.join(__dirname, '../lib/routes/participation.js')
  const nativeRequire = createRequire(filename)
  const result = { exports: {} }
  const overrides = {
    '../paths': { DATA_DIR: dataDir },
    '../auth': { requireAdmin: (req, res) => {
      if (state.authorized) return true
      res.end({ status: 403 })
      return false
    } },
    '../utils': {
      getErrorMessage: error => error.message,
      collectBody: (req, res, callback) => callback(req.body),
      json: (res, data, status = 200) => res.end({ data, status }),
    },
    'koishi-plugin-dongxuelian-ai/lib/public/management-runtime': { loadManagementModule: () => policy },
    '../config-transaction': { executeConfigTransaction: options => executeConfigTransaction({
      ...options,
      hooks: { beforeStage(stage, name) {
        if (stage === 'replacing' && (state.fail && name === 'bot-participation.json' || state.failNames && name === 'dashboard-group-names.json')) throw new Error('injected config write failure')
      } },
    }) },
    '../group-directory': { readGroupNames: async () => {
      state.groupReads = (state.groupReads || 0) + 1
      if (state.groupWait) await state.groupWait
      if (state.groupError) throw new Error('QQ 离线')
      return { 10001: '东雪莲测试群' }
    } },
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: result, exports: result.exports, Buffer,
    require: name => overrides[name] || nativeRequire(name),
  }, { filename })
  return result.exports.routes
}

// 模拟路由调用，保留 JSON 反序列化错误与 HTTP 状态供断言。
function request(routes, method, body) {
  let result
  routes[`${method} /dashboard/api/participation`]({ body: typeof body === 'string' ? body : JSON.stringify(body) }, { end: value => { result = value } })
  return result
}

// 验证群名导入一次、手动修改持久化、鉴权、离线占位及事务失败回滚。
async function testGroupNamesRoute(routes, state) {
  // 捕获异步导入和同步读取、保存的最终响应。
  function call(method = 'GET', body = {}, suffix = '') {
    return new Promise(resolve => routes[`${method} /dashboard/api/groups${suffix}`]({ body: typeof body === 'string' ? body : JSON.stringify(body) }, { end: resolve }))
  }
  state.authorized = false
  assert.equal((await call()).status, 403)
  assert.equal((await call('POST', { groupIds: ['10001'] }, '/import')).status, 403)
  assert.equal((await call('PUT', { groupId: '10001', name: '备注' })).status, 403)
  assert.equal(state.groupReads || 0, 0)
  state.authorized = true
  assert.deepEqual({ ...(await call()).data.groups }, {})
  assert.equal(state.groupReads || 0, 0, '普通读取不能请求 QQ')
  for (const body of ['{', null, {}, { groupIds: ['01'] }, { groupIds: ['99999'] }]) assert.equal((await call('POST', body, '/import')).status, 400)
  assert.deepEqual({ ...(await call('POST', { groupIds: ['10001'] }, '/import')).data.groups }, { 10001: '东雪莲测试群' })
  assert.equal(state.groupReads, 1)
  const saved = await call('PUT', { groupId: '10001', name: ' 自定义群名 <名称> ' })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.groups['10001'], '自定义群名 <名称>')
  state.failNames = true
  assert.equal((await call('PUT', { groupId: '10001', name: '不能保存' })).status, 500)
  assert.equal((await call()).data.groups['10001'], '自定义群名 <名称>')
  state.failNames = false
  for (const body of ['{', null, { groupId: '99999', name: '未知群' }, { groupId: '__proto__', name: 'x' }, { groupId: '10001', name: '长'.repeat(129) }, { groupId: '10001', name: 1 }]) assert.equal((await call('PUT', body)).status, 400)
  const before = request(routes, 'GET').data.policy
  state.groupError = true
  assert.equal((await call()).data.groups['10001'], '自定义群名 <名称>')
  await call('POST', { groupIds: ['10001'] }, '/import')
  assert.equal(state.groupReads, 1, '刷新或重复导入不能覆盖手动名称')
  request(routes, 'PUT', { kind: 'group-abusive', groupId: '10002', enabled: false })
  const offline = await call('POST', { groupIds: ['10002'] }, '/import')
  assert.equal(offline.data.groups['10002'], '')
  assert.match(offline.data.message, /手动填写/)
  await call('POST', { groupIds: ['10002'] }, '/import')
  assert.equal(state.groupReads, 2, '离线导入后也不应反复请求 QQ')
  assert.equal((await call('PUT', { groupId: '10001', name: '' })).status, 200)
  await call('POST', { groupIds: ['10001'] }, '/import')
  assert.equal(state.groupReads, 2, '手动清空的名称不能自动恢复')
  request(routes, 'PUT', { kind: 'group-abusive', groupId: '10004', enabled: false })
  state.groupError = false
  let release
  state.groupWait = new Promise(resolve => { release = resolve })
  const inFlight = call('POST', { groupIds: ['10004'] }, '/import')
  const duplicate = call('POST', { groupIds: ['10004'] }, '/import')
  await Promise.resolve()
  await call('PUT', { groupId: '10004', name: '导入期间手动编辑' })
  release()
  await Promise.all([inFlight, duplicate])
  state.groupWait = null
  assert.equal((await call()).data.groups['10004'], '导入期间手动编辑')
  assert.equal(state.groupReads, 3, '并发导入同一群只能读取一次')
  // 名称操作独立于开关；只比较原有群，不包含测试中显式加入的群。
  const after = request(routes, 'GET').data.policy
  delete after.abusiveGroups['10002']; delete after.abusiveGroups['10004']
  assert.deepEqual(after, before)
}

// 用真实本机 WebSocket 验证 OneBot 请求、Token、echo 匹配、群名解析和连接释放。
async function testGroupDirectory() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const filename = path.join(__dirname, '../lib/group-directory.js')
  const nativeRequire = createRequire(filename)
  const module = { exports: {} }
  let malformed = false
  server.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer local-onebot-secret')
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString())
      assert.equal(request.action, 'get_group_list')
      assert.deepEqual(request.params, {})
      socket.send(JSON.stringify({ post_type: 'meta_event' }))
      socket.send(JSON.stringify({ echo: 'another-request', status: 'failed', retcode: 1 }))
      socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: malformed ? [{ group_id: 10001 }] : [
        { group_id: 10001, group_name: '东雪莲测试群' }, { group_id: 10002, group_name: '<群名> & 测试' },
      ] }))
    })
  })
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: name => name === './snowluma-client'
      ? { readOnebotTarget: () => ({ endpoint: new URL(`ws://127.0.0.1:${server.address().port}`), token: 'local-onebot-secret' }) }
      : nativeRequire(name),
  }, { filename })
  try {
    assert.deepEqual({ ...await module.exports.readGroupNames() }, { 10001: '东雪莲测试群', 10002: '<群名> & 测试' })
    malformed = true
    await assert.rejects(module.exports.readGroupNames(), /群名称读取失败/)
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

// 验证默认关闭、首次启用原子初始化、热读取、鉴权及写入失败回滚。
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'participation-route-'))
  const previous = process.env.DONGXUELIAN_AI_DATA_DIR
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  const policyFile = require.resolve('../../koishi-plugin-dongxuelian-ai/lib/core/participation-policy')
  const constantsFile = require.resolve('../../koishi-plugin-dongxuelian-ai/lib/core/constants')
  delete require.cache[policyFile]
  delete require.cache[constantsFile]
  const policy = require(policyFile)
  const state = { authorized: false, fail: false }
  const routes = loadRoutes(dataDir, policy, state)
  // 初始化并读取同一数据目录里的真实配置文件。
  const write = (name, value) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value))
  const read = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))
  try {
    assert.equal(request(routes, 'GET').status, 403)
    assert.equal(request(routes, 'PUT', { kind: 'private', enabled: true }).status, 403)
    assert.equal(request(routes, 'PUT', { kind: 'group-abusive', groupId: '10001', enabled: true }).status, 403)
    assert.equal(fs.readdirSync(dataDir).length, 0)
    state.authorized = true
    assert.deepEqual(request(routes, 'GET').data.policy, { version: 1, privateEnabled: false, groups: {}, abusiveGroups: {} })
    for (const body of ['{', {}, { kind: { toString: 1 }, enabled: true }, { kind: 'group', groupId: '01', enabled: true }, { kind: 'group', groupId: '1', enabled: 'true' }, { kind: 'group', groupId: '__proto__', enabled: true }]) assert.equal(request(routes, 'PUT', body).status, 400)
    for (const body of [{ kind: 'group-abusive', enabled: true }, { kind: 'group-abusive', groupId: '__proto__', enabled: true }, { kind: 'group-abusive', groupId: '10001', enabled: 'true' }]) assert.equal(request(routes, 'PUT', body).status, 400)
    // 旧配置明确迁移为嘴臭关闭，非法字段不被静默忽略。
    assert.deepEqual(policy.validateParticipationPolicy({ version: 1, privateEnabled: false, groups: { 10001: true } }).abusiveGroups, {})
    for (const abusiveGroups of [null, [], { 10001: 'true' }, { '__invalid__': true }]) assert.throws(() => policy.validateParticipationPolicy({ version: 1, privateEnabled: false, groups: {}, abusiveGroups }))
    write('ai-random-whitelist.json', ['10001', '10002'])
    write('ai-repeat-enabled.json', { 10001: false, 10002: false })
    write('video-blacklist.json', { groups: ['10001', '10002'], users: ['99'] })
    write('group-name-at-disabled-groups.json', { groups: ['10001', '10002'] })
    const names = ['ai-random-whitelist.json', 'ai-repeat-enabled.json', 'video-blacklist.json', 'group-name-at-disabled-groups.json']
    const before = names.map(name => fs.readFileSync(path.join(dataDir, name), 'utf8'))
    state.fail = true
    assert.equal(request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: true }).status, 500)
    assert.deepEqual(names.map(name => fs.readFileSync(path.join(dataDir, name), 'utf8')), before)
    assert.equal(policy.isGroupParticipationEnabled('10001'), false)
    state.fail = false
    assert.equal(request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: true }).status, 200)
    assert.equal(policy.isGroupParticipationEnabled('10001'), true)
    await testGroupNamesRoute(routes, state)
    await testGroupDirectory()
    assert.deepEqual(read('ai-random-whitelist.json'), ['10002'])
    assert.deepEqual(read('ai-repeat-enabled.json'), { 10001: true, 10002: false })
    assert.deepEqual(read('video-blacklist.json'), { groups: ['10002'], users: ['99'] })
    assert.deepEqual(read('group-name-at-disabled-groups.json'), { groups: ['10002'] })
    // 再开启不覆盖已调整的主动回复、复读等设置。
    write('ai-random-whitelist.json', ['10001', '10002'])
    write('ai-repeat-enabled.json', { 10001: false, 10002: false })
    request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: false })
    assert.equal(policy.isGroupParticipationEnabled('10001'), false)
    request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: true })
    assert.deepEqual(read('ai-random-whitelist.json'), ['10001', '10002'])
    assert.equal(read('ai-repeat-enabled.json')['10001'], false)
    const featureSnapshot = names.map(name => fs.readFileSync(path.join(dataDir, name), 'utf8'))
    const savedBeforeAbusive = fs.readFileSync(policy.PARTICIPATION_POLICY_FILE, 'utf8')
    state.fail = true
    assert.equal(request(routes, 'PUT', { kind: 'group-abusive', groupId: '10001', enabled: true }).status, 500)
    assert.equal(fs.readFileSync(policy.PARTICIPATION_POLICY_FILE, 'utf8'), savedBeforeAbusive)
    assert.equal(policy.isGroupAbusiveEnabled('10001'), false)
    state.fail = false
    assert.match(request(routes, 'PUT', { kind: 'group-abusive', groupId: '10001', enabled: true }).data.message, /嘴臭开关已开启/)
    assert.equal(policy.isGroupAbusiveEnabled('10001'), true)
    assert.equal(policy.isGroupAbusiveEnabled('10002'), false)
    assert.equal(policy.isGroupAbusiveEnabled('private:10001'), false)
    assert.deepEqual(names.map(name => fs.readFileSync(path.join(dataDir, name), 'utf8')), featureSnapshot)
    request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: false })
    assert.equal(policy.isGroupAbusiveEnabled('10001'), true)
    request(routes, 'PUT', { kind: 'group', groupId: '10001', enabled: true })
    // 未参与的群可以单独预设嘴臭，不能因此绕过总开关或跳过首次启用默认值。
    request(routes, 'PUT', { kind: 'group-abusive', groupId: '10003', enabled: true })
    assert.equal(policy.isGroupParticipationEnabled('10003'), false)
    assert.equal(policy.isGroupAbusiveEnabled('10003'), true)
    request(routes, 'PUT', { kind: 'group', groupId: '10003', enabled: true })
    assert.equal(read('ai-repeat-enabled.json')['10003'], true)
    assert.equal(policy.isGroupAbusiveEnabled('10003'), true)
    assert.equal(request(routes, 'GET').data.policy.abusiveGroups['10001'], true)
    const copy = policy.readParticipationPolicy()
    copy.abusiveGroups['10001'] = false
    assert.equal(policy.isGroupAbusiveEnabled('10001'), true)
    assert.equal(request(routes, 'PUT', { kind: 'private', enabled: true }).data.policy.privateEnabled, true)
    assert.equal(policy.isSessionParticipationEnabled({ isDirect: true }), true)
    assert.equal(policy.isGroupParticipationEnabled('10002'), false)
    request(routes, 'PUT', { kind: 'private', enabled: false })
    assert.equal(policy.isSessionParticipationEnabled({ isDirect: true, guildId: '10001' }), false)
    delete require.cache[policyFile]
    assert.equal(require(policyFile).readParticipationPolicy().groups['10001'], true)
    assert.equal(require(policyFile).isGroupAbusiveEnabled('10001'), true)
    request(routes, 'PUT', { kind: 'group-abusive', groupId: '10001', enabled: false })
    assert.equal(require(policyFile).isGroupAbusiveEnabled('10001'), false)
    assert.equal(policy.isGroupParticipationEnabled('10001'), true)
    console.log('participation route tests passed: defaults, authorization, atomic initialization, rollback, persistence')
  } finally {
    if (previous === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = previous
    delete require.cache[policyFile]
    delete require.cache[constantsFile]
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
