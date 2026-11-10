'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
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
        if (state.fail && stage === 'replacing' && name === 'bot-participation.json') throw new Error('injected policy write failure')
      } },
    }) },
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

// 验证默认关闭、首次启用原子初始化、热读取、鉴权及写入失败回滚。
function main() {
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
    assert.equal(fs.readdirSync(dataDir).length, 0)
    state.authorized = true
    assert.deepEqual(request(routes, 'GET').data.policy, { version: 1, privateEnabled: false, groups: {} })
    for (const body of ['{', {}, { kind: { toString: 1 }, enabled: true }, { kind: 'group', groupId: '01', enabled: true }, { kind: 'group', groupId: '1', enabled: 'true' }, { kind: 'group', groupId: '__proto__', enabled: true }]) assert.equal(request(routes, 'PUT', body).status, 400)
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
    assert.equal(request(routes, 'PUT', { kind: 'private', enabled: true }).data.policy.privateEnabled, true)
    assert.equal(policy.isSessionParticipationEnabled({ isDirect: true }), true)
    assert.equal(policy.isGroupParticipationEnabled('10002'), false)
    request(routes, 'PUT', { kind: 'private', enabled: false })
    assert.equal(policy.isSessionParticipationEnabled({ isDirect: true, guildId: '10001' }), false)
    delete require.cache[policyFile]
    assert.equal(require(policyFile).readParticipationPolicy().groups['10001'], true)
    console.log('participation route tests passed: defaults, authorization, atomic initialization, rollback, persistence')
  } finally {
    if (previous === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = previous
    delete require.cache[policyFile]
    delete require.cache[constantsFile]
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main()
