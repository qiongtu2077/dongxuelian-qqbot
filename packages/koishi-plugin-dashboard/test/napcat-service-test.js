'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

// --- 隔离运行环境 ---

// 隔离 systemctl 调用，同时保留真实 HTTP 请求以复现空响应故障。
function loadService(execFile) {
  const filename = path.join(__dirname, '../lib/napcat-service.js')
  const result = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: result, exports: result.exports, Buffer, setTimeout,
    require: name => name === 'child_process' ? { execFile } : require(name),
  }, { filename })
  return result.exports
}

// 注入受托管服务并保留真实路由分支，检查鉴权和异步响应时机。
function loadRestartRoute(restartNapcatService, authorized) {
  const filename = path.join(__dirname, '../lib/routes/bot.js')
  const nativeRequire = createRequire(filename)
  const result = { exports: {} }
  const overrides = {
    '../napcat-service': { restartNapcatService },
    '../auth': { requireAdmin: () => authorized },
    '../utils': { ...nativeRequire('../utils'), json: (res, data, status = 200) => res.end({ data, status }) },
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: result, exports: result.exports,
    process: { platform: process.platform, env: { ...process.env, DASHBOARD_QQ_NUMBER: '3098291287', NAPCAT_PORT: '6099', NAPCAT_SERVICE_NAME: 'lian-napcat.service' } },
    require: name => overrides[name] || nativeRequire(name),
  }, { filename })
  return result.exports.routes['POST /dashboard/api/napcat/restart']
}

// --- 服务与路由行为 ---

// 验证真实空响应、非成功状态、延迟就绪和 systemctl 失败不会被误报成功。
async function testServiceLifecycle() {
  let mode = 'empty', requests = 0, restarted = false
  const server = http.createServer((req, res) => {
    requests++
    assert.equal(req.url, '/webui/')
    if (mode === 'empty') return req.socket.destroy()
    if (mode === 'unavailable') { res.writeHead(503); return res.end('unavailable') }
    assert(restarted, 'health check must follow completed systemctl restart')
    res.end('<html>NapCat</html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const commands = []
  const service = loadService((file, args, options, callback) => {
    commands.push([file, Array.from(args)])
    setTimeout(() => { restarted = true; mode = 'ready'; callback(null) }, 20)
  })
  try {
    await assert.rejects(service.waitForNapcatWebui(port, 300), /健康检查失败/)
    mode = 'unavailable'
    await assert.rejects(service.waitForNapcatWebui(port, 300), /健康检查失败/)
    await service.restartNapcatService('lian-napcat.service', port)
    assert.deepEqual(commands, [['systemctl', ['restart', 'lian-napcat.service']]])
    const before = requests
    const failed = loadService((file, args, options, callback) => callback(new Error('systemctl denied')))
    await assert.rejects(failed.restartNapcatService('lian-napcat.service', port), /systemctl denied/)
    assert.equal(requests, before, 'failed restart must not probe an old healthy instance')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

// 验证未授权请求不重启、就绪前不回复成功，以及重启失败返回 HTTP 500。
async function testRestartRoute() {
  let calls = 0, finish
  const route = loadRestartRoute(() => { calls++; return new Promise(resolve => { finish = resolve }) }, true)
  let response
  route({}, { end: value => { response = value } })
  assert.equal(calls, 1)
  assert.equal(response, undefined)
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.status, 200)
  assert.equal(response.data.ok, true)
  const denied = loadRestartRoute(async () => { calls++ }, false)
  denied({}, { end: () => assert.fail('unauthorized request reached success response') })
  assert.equal(calls, 1)
  const failed = loadRestartRoute(async () => { throw new Error('service failed') }, true)
  failed({}, { end: value => { response = value } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.status, 500)
  assert.equal(response.data.code, 'NAPCAT_RESTART_FAILED')
}

// --- 测试入口 ---

// 执行受托管重启的服务和路由回归验证。
async function main() {
  await testServiceLifecycle()
  await testRestartRoute()
  console.log('napcat service lifecycle tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
