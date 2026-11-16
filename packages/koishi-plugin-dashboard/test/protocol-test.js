'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { WebSocket } = require('ws')

// --- 隔离服务与协议传输 ---

/** 在独立数据目录加载生产模块，只替换真实 systemd 和 QQ 进程。 */
function loadModule(name, overrides = {}, globals = {}) {
  const filename = path.join(__dirname, '../lib', name + '.js')
  const nativeRequire = createRequire(filename)
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URL, setTimeout, clearTimeout,
    process: { platform: 'linux', pid: process.pid, env: {}, kill: pid => { if (pid !== process.pid) { const error = new Error('no such process'); error.code = 'ESRCH'; throw error } } },
    require: name => overrides[name] || nativeRequire(name), ...globals,
  }, { filename })
  return module.exports
}

/** 开启本机真实 HTTP/TCP 测试服务。 */
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** 等待网络资源退出，避免测试遗留连接。 */
async function close(server) { await new Promise(resolve => server.close(resolve)) }

/** 建立可注入启动/停止失败的 systemd 模型，拒绝两个协议同时存在。 */
function runtimeFixture(root, port, failure = '') {
  const commands = []
  const states = { 'lian-napcat.service': 'active', 'lian-snowluma.service': 'inactive', 'lian-koishi.service': 'active' }
  let failOnce = !!failure
  const runtime = loadModule('protocol-runtime', {
    './paths': { KOISHI_DIR: root, DATA_DIR: root },
    http: { get: (options, callback) => http.get({ ...options, port }, callback) },
    child_process: { execFile: (file, args, options, callback) => {
      assert.equal(file, 'systemctl')
      const [action, unit] = args
      commands.push([action, unit])
      if (action === 'show') return callback(null, `ActiveState=${states[unit]}\nMainPID=${states[unit] === 'active' ? 123 : 0}\nLoadState=loaded\n`, '')
      if (failOnce && action + ' ' + unit === failure) { failOnce = false; return callback(new Error(failure), '', failure) }
      if (action === 'start' && unit !== 'lian-koishi.service') {
        const other = unit === 'lian-napcat.service' ? 'lian-snowluma.service' : 'lian-napcat.service'
        assert.notEqual(states[other], 'active', 'must stop old protocol before starting another')
      }
      if (action === 'start') states[unit] = 'active'
      if (action === 'stop') states[unit] = 'inactive'
      setTimeout(() => callback(null, '', ''), 2)
    } },
  })
  return { runtime, states, commands }
}

// --- 切换行为与回滚 ---

/** 验证双向切换、并发拒绝、失败回滚、持久选择和旧入口互斥。 */
async function testSwitch(root) {
  const webui = http.createServer((req, res) => res.end('<html>ready</html>'))
  const port = await listen(webui)
  try {
    const fixture = runtimeFixture(root, port)
    const first = fixture.runtime.switchProtocol('sl')
    await assert.rejects(fixture.runtime.switchProtocol('napcat'), /正在切换/)
    const status = await first
    assert.equal(status.selected, 'sl')
    assert.equal(status.sl.state, 'active')
    assert.equal(status.napcat.pid, 0)
    assert.equal(status.conflict, false)
    assert.throws(() => fixture.runtime.assertNapcatSelected(), /先在顶部菜单切换/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'qq-protocol.json'))).provider, 'sl')
    await fixture.runtime.switchProtocol('napcat')
    assert.equal(fixture.states['lian-snowluma.service'], 'inactive')
    assert.equal(fixture.runtime.selectedProtocol(), 'napcat')
    fixture.runtime.assertNapcatSelected()
    assert(!fs.existsSync(path.join(root, 'qq-protocol-switch.lock')))

    const failed = runtimeFixture(root, port, 'start lian-snowluma.service')
    await assert.rejects(failed.runtime.switchProtocol('sl'), /start lian-snowluma/)
    assert.equal(failed.runtime.selectedProtocol(), 'napcat')
    assert.equal(failed.states['lian-napcat.service'], 'active')
    assert.equal(failed.states['lian-koishi.service'], 'active')
    assert.equal(failed.states['lian-snowluma.service'], 'inactive')

    const blocked = runtimeFixture(root, port, 'stop lian-napcat.service')
    await assert.rejects(blocked.runtime.switchProtocol('sl'), /stop lian-napcat/)
    assert(!blocked.commands.some(([action, unit]) => action === 'start' && unit === 'lian-snowluma.service'))
    assert(!fs.existsSync(path.join(root, 'qq-protocol-switch.lock')))

    fs.mkdirSync(path.join(root, 'qq-protocol-switch.lock'))
    fs.writeFileSync(path.join(root, 'qq-protocol-switch.lock', String(process.pid)), '')
    const before = blocked.commands.length
    await assert.rejects(blocked.runtime.switchProtocol('sl'), /锁已占用/)
    assert.equal(blocked.commands.length, before)
    fs.unlinkSync(path.join(root, 'qq-protocol-switch.lock', String(process.pid)))
    fs.writeFileSync(path.join(root, 'qq-protocol-switch.lock', '999999999'), '')
    await blocked.runtime.switchProtocol('sl')
    assert(!fs.existsSync(path.join(root, 'qq-protocol-switch.lock')), 'crashed process lock must be recovered')
  } finally { await close(webui) }
}

// --- SnowLuma 登录与账号隔离 ---

/** 使用真实 HTTP 重现协议确认、接入、账号匹配、配置和实际连接验证。 */
async function testLogin(root) {
  const slRoot = path.join(root, 'sl')
  fs.mkdirSync(slRoot)
  fs.writeFileSync(path.join(slRoot, 'bootstrap-password'), 'test-private-bootstrap')
  fs.writeFileSync(path.join(slRoot, 'qq.pid'), '23456')
  fs.writeFileSync(path.join(root, 'koishi.yml'), "plugins:\n  group:basic:\n    adapter-onebot:test:\n      selfId: '532701045'\n      endpoint: ws://127.0.0.1:8080/onebot/v11/ws\n      token: private-onebot-token\n")
  let consent = false, online = false, owner = true, saved = null, verified = false
  const requests = []
  const api = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const data = body ? JSON.parse(body) : undefined
      requests.push(req.url)
      res.setHeader('Content-Type', 'application/json')
      if (req.url !== '/api/login') assert.equal(req.headers['x-snowluma-token'], 'private-sl-session')
      let result
      switch (req.url) {
        case '/api/login': assert.equal(data.password, 'test-private-bootstrap'); result = { success: true, token: 'private-sl-session', mustChangePassword: false }; break
        case '/api/agreements': result = { version: '1234567890abcdef', consentRequired: !consent, documents: [] }; break
        case '/api/agreements/record-consent': assert.equal(data.version, '1234567890abcdef'); consent = true; result = { success: true }; break
        case '/api/processes': result = { list: [{ pid: 23456, status: 'loaded' }, { pid: 111, status: 'loaded' }] }; break
        case '/api/processes/23456/load': assert(consent); result = { success: true }; break
        case '/api/qq-list': result = { list: online ? [{ uin: '532701045', nickname: 'Bot' }] : [] }; break
        case '/api/config/532701045':
          if (req.method === 'POST') { saved = data; result = { success: true, applied: true } }
          else result = { config: { networks: {}, historySync: { enabled: false } } }
          break
        default: assert.fail('unexpected API: ' + req.url)
      }
      res.end(JSON.stringify(result))
    })
  })
  const port = await listen(api)
  const client = loadModule('snowluma-client', {
    './protocol-runtime': { slRoot, koishiDir: root, selectedProtocol: () => 'sl', serviceState: async () => ({ state: 'active' }), systemctl: async (...args) => assert.equal(args.join(' '), 'restart lian-koishi.service') },
    './napcat-service': { waitForKoishiOnebot: async (dir, port) => { assert.equal(dir, root); assert.equal(port, 8080); verified = true } },
    fs: { ...fs, realpathSync: file => file.startsWith('/proc/') ? path.join(slRoot, 'qq/opt/QQ/qq') : fs.realpathSync(file),
      readFileSync: (file, encoding) => file === '/proc/23456/cgroup' ? (owner ? '0::/system.slice/lian-snowluma.service\n' : '0::/system.slice/other.service\n') : fs.readFileSync(file, encoding) },
    http: { request: (options, callback) => http.request({ ...options, port }, callback) },
  })
  try {
    const first = await client.slLoginState()
    assert.equal(first.agreements.consentRequired, true)
    assert(!requests.includes('/api/processes'))
    await client.acceptSlAgreements('1234567890abcdef')
    assert.equal((await client.slLoginState()).processes.length, 1)
    const waiting = await client.connectSlAccount()
    assert.equal(waiting.connected, false)
    assert.equal(saved, null)
    online = true
    assert.equal((await client.connectSlAccount()).connected, true)
    assert(verified)
    assert.equal(saved.networks.wsServers[0].path, '/onebot/v11/ws')
    assert.equal(saved.networks.wsServers[0].accessToken, 'private-onebot-token')
    assert.equal(saved.networks.wsServers[0].host, '127.0.0.1')
    assert.equal(saved.networks.httpServers.length, 0)
    assert(!JSON.stringify(first).includes('private-'))
    owner = false
    assert.throws(() => client.readSlQqPid(), /不在 SnowLuma 受管服务/)
  } finally { await close(api) }
}

// --- 桌面安全与资源回收 ---

/** 验证票据仅可用一次、错误来源拒绝及真实 TCP 双向转发。 */
async function testDesktop() {
  const desktop = loadModule('sl-desktop', {
    './protocol-runtime': { slRoot: '/unused', protocolStatus: async () => ({ selected: 'sl', sl: { state: 'active' }, switching: false }) },
    './auth': { isRequestSiteTrusted: req => req.headers.origin === 'http://localhost' },
    './utils': { getRemoteAddress: req => req.socket.remoteAddress },
  })
  let tcpClosed
  const closed = new Promise(resolve => { tcpClosed = resolve })
  const vnc = net.createServer(socket => {
    socket.write('RFB 003.008\n')
    socket.on('data', data => socket.write(data))
    socket.on('close', tcpClosed)
  })
  // The bridge's fixed loopback port is part of the deployment contract.
  await new Promise(resolve => vnc.listen(5909, '127.0.0.1', resolve))
  const server = http.createServer((req, res) => { desktop.serveSlDesktop(req, res, new URL(req.url, 'http://localhost').pathname) })
  desktop.installSlDesktop(server)
  const port = await listen(server)
  const ticket = desktop.desktopTicket({ socket: { remoteAddress: '127.0.0.1' } })
  let socket
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/dashboard/sl-desktop/socket?ticket=${ticket}`, { origin: 'http://localhost' })
    const message = await new Promise((resolve, reject) => { socket.once('message', data => resolve(String(data))); socket.once('error', reject) })
    assert.equal(message, 'RFB 003.008\n')
    const echoed = new Promise(resolve => socket.once('message', data => resolve(String(data))))
    socket.send(Buffer.from('input'))
    assert.equal(await echoed, 'input')
    const reused = new WebSocket(`ws://127.0.0.1:${port}/dashboard/sl-desktop/socket?ticket=${ticket}`, { origin: 'http://localhost' })
    await new Promise(resolve => reused.once('error', error => { assert.match(error.message, /403/); resolve() }))
    const stolen = desktop.desktopTicket({ socket: { remoteAddress: 'another-client' } })
    const denied = new WebSocket(`ws://127.0.0.1:${port}/dashboard/sl-desktop/socket?ticket=${stolen}`, { origin: 'http://localhost' })
    await new Promise(resolve => denied.once('error', error => { assert.match(error.message, /403/); resolve() }))
    socket.close()
    await closed
  } finally { socket?.terminate(); await close(server); await close(vnc) }
}

/** 执行协议切换、登录适配与桌面链路回归。 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lian-protocol-'))
  try { await testSwitch(root); await testLogin(root); await testDesktop(); console.log('protocol switch, SnowLuma login and desktop tests passed') }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
