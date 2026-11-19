/** 普通请求、特定地址、代理与 SSH 私有监听的真实 HTTP 验证。 */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianboard-auth-'))
process.env.DONGXUELIAN_AI_DATA_DIR = root
process.env.GLOBAL_LOCAL_MODE = ''
const auth = require('../lib/auth')
const { routes, authMiddleware } = require('../lib/routes/auth')
const { TRUSTED_ACCESS_FILE, markSshRequest } = require('../lib/trusted-access')
const { startSshListener } = require('../lib/ssh-listener')
const host = '127.0.0.1:15150'
const origin = 'http://' + host

/** 模拟不同的 TCP/TLS 对端，业务层使用正式认证函数。 */
function probe(url, method = 'GET', headers = {}, peer = '127.0.0.1', encrypted = false, ssh = false) {
  const req = { url, method, headers: { host, ...headers }, socket: { localAddress: '127.0.0.1', remoteAddress: peer, encrypted } }
  if (ssh) markSshRequest(req)
  const res = { statusCode: 200, setHeader() {}, writeHead(code) { this.statusCode = code }, end(text) { this.body = JSON.parse(text) } }
  if (!auth.rejectCrossSiteRequest(req, res) && authMiddleware(req, res, url)) auth.requireAdmin(req, res)
  return res.statusCode
}
/** 以原子替换方式持久化本机测试许可。 */
function policy(data) {
  fs.writeFileSync(TRUSTED_ACCESS_FILE + '.new', JSON.stringify({ version: 1, enabled: true, ...data }), { mode: 0o600 })
  fs.renameSync(TRUSTED_ACCESS_FILE + '.new', TRUSTED_ACCESS_FILE)
}
/** 用实际 HTTP 套接字读取不包含可移用令牌的会话结果。 */
function session(options, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ ...options, path: '/dashboard/api/auth/session', headers: { host, ...headers } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => { try { assert.match(res.headers['cache-control'], /no-store/); resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).once('error', reject)
  })
}

/** 通过真实回环反代验证只采信固定代理报告的实际对端。 */
async function verifyProxy() {
  const handler = routes['GET /dashboard/api/auth/session']
  const backend = http.createServer((req, res) => handler(req, res))
  const proxy = http.createServer((req, res) => {
    const upstream = http.get({ hostname: '127.0.0.1', port: backend.address().port, path: req.url,
      headers: { host: 'console.example.test', 'x-forwarded-proto': 'https', 'x-real-ip': req.socket.remoteAddress } }, reply => {
      res.writeHead(reply.statusCode, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end() })
  })
  try {
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    policy({ mode: 'proxy', address: '127.0.0.2', proxy: '127.0.0.1', origin: 'https://console.example.test' })
    const options = { hostname: '127.0.0.1', port: proxy.address().port }
    assert.equal((await session({ ...options, localAddress: '127.0.0.2' })).mode, 'source')
    assert.equal((await session(options, { 'x-real-ip': '127.0.0.2' })).mode, 'anonymous')
  } finally {
    await Promise.all([proxy, backend].map(server => new Promise(resolve => server.close(resolve))))
  }
}

/** 验证正常口令和来源权限的范围、热撤销及错误回退。 */
async function run() {
  const target = '/dashboard/api/agent/config'
  assert.equal(probe(target), 401)
  const ordinary = { authorization: 'Bearer ' + auth.createToken() }
  assert.equal(probe(target, 'GET', ordinary), 403)
  assert.equal(probe(target, 'GET', { ...ordinary, 'x-admin-token': auth.createAdminToken() }), 200)
  await verifyProxy()
  const fields = { mode: 'direct', address: '2001:db8::1', origin: 'https://console.example.test' }
  const site = { host: 'console.example.test' }
  policy(fields)
  assert.equal(probe(target, 'GET', site, '2001:0db8:0:0:0:0:0:1', true), 200)
  assert.equal(probe(target, 'GET', site, '2001:db8::2', true), 401)
  assert.equal(probe(target, 'GET', site, '2001:db8::1'), 401)
  assert.equal(probe(target, 'POST', site, '2001:db8::1', true), 401)
  assert.equal(probe(target, 'POST', { ...site, origin: fields.origin }, '2001:db8::1', true), 200)
  assert.equal(probe(target, 'GET', { ...site, 'sec-fetch-site': 'cross-site' }, '2001:db8::1', true), 403)
  policy({ mode:'proxy', address:'192.0.2.7', proxy:'127.0.0.1', origin:fields.origin })
  const forwarded = { ...site, 'x-real-ip':'::ffff:192.0.2.7', 'x-forwarded-proto':'https', origin:fields.origin }
  assert.equal(probe(target, 'POST', forwarded), 200)
  for (const extra of [{ 'x-forwarded-for':'192.0.2.7' }, { forwarded:'for=192.0.2.7' }, { 'x-real-ip':'192.0.2.7, 192.0.2.8' }, { 'x-real-ip':'' }, { 'x-forwarded-proto':'http' }]) {
    assert.notEqual(probe(target, 'POST', { ...forwarded, ...extra }), 200)
  }
  assert.notEqual(probe(target, 'POST', forwarded, '192.0.2.9'), 200)
  assert.equal(probe(target, 'POST', { ...forwarded, 'x-real-ip':'192.0.2.8', ...ordinary }), 403)
  assert.equal(probe(target, 'GET', { ...site, 'x-real-ip':'192.0.2.7', 'x-forwarded-proto':'https', 'x-dashboard-password-only':'1' }), 401)
  policy({ mode:'ssh', address:'127.0.0.1', origin })
  assert.equal(probe(target), 401)
  assert.equal(probe(target, 'GET', {}, '127.0.0.1', false, true), 200)
  for (const url of ['/dashboard/api/auth/password', '/dashboard/api/admin/verify', '/dashboard/api/protocol/sl/desktop', '/api/test', '/webui/']) {
    assert.notEqual(probe(url, 'POST', {origin}, '127.0.0.1', false, true), 200)
  }
  const handler = (req, res) => routes['GET /dashboard/api/auth/session'](req, res)
  const normal = http.createServer(handler)
  await new Promise(resolve => normal.listen(0, '127.0.0.1', resolve))
  let tunnel
  try {
    const external = await session({ host:'127.0.0.1', port:normal.address().port })
    assert.deepEqual(external, { ok:true, mode:'anonymous', access:false, admin:false })
    if (process.platform !== 'win32') {
      const directory = path.join(root, 'dashboard-tunnel')
      fs.mkdirSync(directory, { mode: 0o700 })
      fs.chmodSync(directory, 0o755)
      assert.equal(startSshListener(handler), undefined)
      assert.equal((await session({ host: '127.0.0.1', port: normal.address().port })).access, false)
      fs.chmodSync(directory, 0o700)
      tunnel = startSshListener(handler)
      await once(tunnel, 'listening')
      const socketPath = path.join(root, 'dashboard-tunnel', 'console.sock')
      assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600)
      assert.deepEqual(await session({socketPath}), {ok:true, access:true, admin:true, mode:'source'})
      assert.equal((await session({socketPath}, {'x-dashboard-password-only':'1'})).access, false)
      policy({enabled:false})
      assert.equal((await session({socketPath})).admin, false)
    }
    policy({ ...fields, address:'0.0.0.0/0' })
    assert.equal(probe(target, 'GET', site, '192.0.2.7', true), 401)
    fs.writeFileSync(TRUSTED_ACCESS_FILE, '{broken')
    assert.equal(probe(target, 'GET', {}, '127.0.0.1', false, true), 401)
    fs.unlinkSync(TRUSTED_ACCESS_FILE)
    assert.equal(probe(target), 401)
  } finally {
    if (tunnel) await new Promise(resolve => tunnel.close(resolve))
    await new Promise(resolve => normal.close(resolve))
  }
}
run().then(() => console.log('Trusted source, scoped access, independent transport and revocation tests passed'))
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('lianboard-auth-')) fs.rmSync(root, {recursive:true, force:true}) })
