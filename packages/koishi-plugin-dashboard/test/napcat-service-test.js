'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

// --- 隔离运行环境 ---

// 隔离 systemctl 调用，同时保留真实 HTTP 请求以复现空响应故障。
function loadService(execFile, readCmdline = fs.readFileSync) {
  const filename = path.join(__dirname, '../lib/napcat-service.js')
  const result = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: result, exports: result.exports, Buffer, setTimeout,
    require: name => name === 'child_process' ? { execFile } : name === 'fs' ? { readFileSync: readCmdline } : require(name),
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

// 验证网页恢复后必须重新建立实际的 Koishi 连接，且保留服务失败。
async function testServiceLifecycle() {
  let mode = 'empty', requests = 0, restarted = false, readyPageRead = false, botRestarted = false
  const koishiDir = path.resolve(__dirname, '../../..')
  const server = http.createServer((req, res) => {
    requests++
    assert.equal(req.url, '/webui/')
    if (mode === 'empty') return req.socket.destroy()
    if (mode === 'unavailable') { res.writeHead(503); return res.end('unavailable') }
    assert(restarted, 'health check must follow completed systemctl restart')
    readyPageRead = true
    res.end('<html>NapCat</html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const commands = []
  const service = loadService((file, args, options, callback) => {
    commands.push([file, Array.from(args)])
    if (file === 'systemctl' && args[0] === 'show') return callback(null, 'active\n')
    if (file === 'ss') {
      assert(botRestarted)
      return callback(null, 'ESTAB 0 0 127.0.0.1:40000 127.0.0.1:8080 users:(("node",pid=12345,fd=21))\n')
    }
    if (args[1] === 'lian-koishi.service') {
      assert(readyPageRead, 'Koishi restart must follow successful WebUI health check')
      botRestarted = true
      return callback(null, '')
    }
    setTimeout(() => { restarted = true; mode = 'ready'; callback(null, '') }, 20)
  }, file => {
    assert.equal(file, '/proc/12345/cmdline')
    return ['/usr/bin/node', path.join(koishiDir, 'node_modules/koishi/lib/worker'), ''].join('\0')
  })
  try {
    await assert.rejects(service.waitForNapcatWebui(port, 300), /健康检查失败/)
    mode = 'unavailable'
    await assert.rejects(service.waitForNapcatWebui(port, 300), /健康检查失败/)
    const result = await service.restartNapcatService('lian-napcat.service', port, koishiDir, 8080)
    assert.equal(result.botReconnected, true)
    assert.deepEqual(commands, [
      ['systemctl', ['show', 'lian-koishi.service', '--property=ActiveState', '--value']],
      ['systemctl', ['restart', 'lian-napcat.service']],
      ['systemctl', ['restart', 'lian-koishi.service']],
      ['ss', ['-Hntp', '( dst 127.0.0.1 and dport = :8080 )']],
    ])
    const before = requests
    const failed = loadService((file, args, options, callback) => {
      if (args[0] === 'show') return callback(null, 'active\n')
      callback(new Error('systemctl denied'))
    })
    await assert.rejects(failed.restartNapcatService('lian-napcat.service', port, koishiDir, 8080), /systemctl denied/)
    assert.equal(requests, before, 'failed restart must not probe an old healthy instance')
    const botFailed = loadService((file, args, options, callback) => {
      if (args[0] === 'show') return callback(null, 'active\n')
      if (args[1] === 'lian-koishi.service') return callback(new Error('Koishi restart failed'))
      callback(null, '')
    })
    await assert.rejects(botFailed.restartNapcatService('lian-napcat.service', port, koishiDir, 8080), /Koishi restart failed/)

    // 已监听端口、其他 Node 应用的连接，都不能替代当前 Koishi worker 的连接。
    const disconnected = loadService((file, args, options, callback) => callback(null, ''))
    await assert.rejects(disconnected.waitForKoishiOnebot(koishiDir, 8080, 300), /OneBot 连接未恢复/)
    const otherApp = loadService((file, args, options, callback) => callback(null,
      'ESTAB 0 0 127.0.0.1:40000 127.0.0.1:8080 users:(("node",pid=12345,fd=21))\n'), () => '/usr/bin/node\0/other/app.js\0')
    await assert.rejects(otherApp.waitForKoishiOnebot(koishiDir, 8080, 300), /OneBot 连接未恢复/)

    // 原本停止的机器人保持停止，不因重启 NapCat 被自动拉起。
    const stoppedCommands = []
    const stopped = loadService((file, args, options, callback) => {
      stoppedCommands.push([file, Array.from(args)])
      callback(null, args[0] === 'show' ? 'inactive\n' : '')
    })
    assert.equal((await stopped.restartNapcatService('lian-napcat.service', port, koishiDir, 8080)).botReconnected, false)
    assert.equal(stoppedCommands.length, 2)
    assert.deepEqual(stoppedCommands[1], ['systemctl', ['restart', 'lian-napcat.service']])
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
  finish({ botReconnected: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.status, 200)
  assert.equal(response.data.ok, true)
  assert.equal(response.data.botReconnected, true)
  assert.match(response.data.message, /OneBot 连接已恢复/)
  const stopped = loadRestartRoute(async () => ({ botReconnected: false }), true)
  stopped({}, { end: value => { response = value } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.data.botReconnected, false)
  assert.match(response.data.message, /机器人保持停止/)
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
