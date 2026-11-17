'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { App } = require('koishi')
const { Bot, Session } = require('@satorijs/core')
const { Status } = require('@satorijs/protocol')
const onebot = require('koishi-plugin-adapter-onebot').default
const { WebSocketServer } = require('ws')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lian-sl-reconnect-'))
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
const { installSlOnebotReconnect } = require('../lib/lifecycle/sl-onebot-reconnect')
const { installSessionCompatibility } = require('../lib/lifecycle/session-compat')
installSessionCompatibility({ KoishiSession: Session, KoishiBot: Bot })
const RETRY_MS = 40

// --- 真实传输夹具 --- //

// 等待真实事件循环中的连接状态，超时保留具体失败阶段。
async function waitUntil(predicate, label) {
  const until = Date.now() + 5000
  while (!predicate()) {
    assert(Date.now() < until, `timeout: ${label}`)
    await delay(10)
  }
}

// 仅模拟 SL 的 OneBot 服务端；客户端使用真实 Koishi、适配器和 TCP/WebSocket。
async function createSlServer(state, port = 0) {
  const server = new WebSocketServer({ host: '127.0.0.1', port, path: '/onebot/v11/ws' })
  server.on('connection', socket => {
    state.connections++
    state.clients.add(socket)
    state.peakClients = Math.max(state.peakClients, state.clients.size)
    socket.on('close', () => state.clients.delete(socket))
    socket.on('message', bytes => {
      const request = JSON.parse(bytes.toString())
      state.requests.push(request)
      let data
      switch (request.action) {
        case 'get_login_info': data = { user_id: 10000, nickname: 'SL fixture' }; break
        case 'get_guild_service_profile': data = { tiny_id: '0' }; break
        case 'get_status': data = { online: true, good: true }; break
        case 'send_group_msg': data = { message_id: 456 }; break
        default: state.unexpected.push(request.action); data = null
      }
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
    })
  })
  await once(server, 'listening')
  return server
}

// 为每例启动独立真实 Bot；协议选择写入隔离临时目录，不访问生产数据。
async function withBot(provider, enabled, run) {
  const selection = path.join(dataDir, 'qq-protocol.json')
  if (provider) fs.writeFileSync(selection, JSON.stringify({ provider }))
  else fs.rmSync(selection, { force: true })
  const state = { clients: new Set(), connections: 0, peakClients: 0, requests: [], unexpected: [] }
  let server = await createSlServer(state)
  const port = server.address().port
  const app = new App()
  app.plugin(onebot, {
    protocol: 'ws', selfId: '10000', endpoint: `ws://127.0.0.1:${port}/onebot/v11/ws`,
    retryInterval: RETRY_MS, retryLazy: RETRY_MS * 2, retryTimes: 1, responseTimeout: 150,
  })
  const recovery = enabled ? app.plugin(installSlOnebotReconnect) : null
  const messages = []
  app.on('message', session => { messages.push(session.content) })
  try {
    await app.start()
    const bot = app.bots.find(value => value.platform === 'onebot')
    await waitUntil(() => bot.status === Status.ONLINE, 'initial login')
    await run({ app, bot, recovery, state, messages,
      // 临时关闭监听端口后按原端口重建，重现 SL 会话重建窗口。
      async stopServer() {
        for (const socket of state.clients) socket.terminate()
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        server = null
      },
      async restartServer() { server = await createSlServer(state, port) },
    })
    assert.deepEqual(state.unexpected, [])
  } finally {
    await app.stop()
    if (server) {
      for (const socket of state.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
    // OneBot 对成功请求保留短响应计时器，等待其退出，不强制终止测试进程。
    await delay(180)
  }
}

// --- 故障复现与修复验收 --- //

// 验证原适配器的重试确实被取消，防止测试夹具掩盖真实事故。
async function verifyOriginalFailure() {
  await withBot('sl', false, async ({ bot, state }) => {
    state.clients.values().next().value.close(1000, 'normal')
    await waitUntil(() => bot.status === Status.OFFLINE, 'original offline state')
    await delay(RETRY_MS * 3)
    assert.equal(state.connections, 1)
  })
  console.log('OK original SL close reproduces cancelled reconnect')
}

// 验证正常关闭、异常断开、连续重连和消息收发均沿用单一真实连接。
async function verifySessionRecovery() {
  await withBot('sl', true, async ({ bot, state, messages }) => {
    for (const code of [1000, 1011, null]) {
      const before = state.connections
      const socket = state.clients.values().next().value
      if (code) socket.close(code, 'SL session rebuild')
      else socket.terminate()
      await waitUntil(() => state.connections === before + 1 && bot.status === Status.ONLINE, 'session recovery')
      assert.deepEqual(await bot.internal.getStatus(), { online: true, good: true })
      await delay(RETRY_MS * 3)
      assert.equal(state.connections, before + 1, 'one reconnect must not create duplicate clients')
    }
    const socket = state.clients.values().next().value
    socket.send(JSON.stringify({ post_type: 'message', self_id: 10000, message_type: 'group', sub_type: 'normal',
      user_id: 10001, group_id: 10002, message_id: 123, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: 'SL recovered message' } }],
      sender: { user_id: 10001, nickname: 'fixture sender', role: 'member' },
    }))
    await waitUntil(() => messages.includes('SL recovered message'), 'real message dispatch after reconnect')
    assert.equal(await bot.internal.sendGroupMsg(10002, 'fixture reply'), 456)
    assert(state.requests.some(request => request.action === 'send_group_msg' && request.params.message === 'fixture reply'))
    assert.equal(state.peakClients, 1)
  })
  console.log('OK SL normal/abnormal closes recover one client and message transport')
}

// 验证接口短暂消失时持续重试，SL 原端口恢复后自动登录。
async function verifyUnavailableServer() {
  await withBot('sl', true, async ({ bot, state, stopServer, restartServer }) => {
    await stopServer()
    await delay(RETRY_MS * 5)
    assert.equal(bot.status, Status.RECONNECT)
    await restartServer()
    await waitUntil(() => state.connections === 2 && bot.status === Status.ONLINE, 'server restart recovery')
    assert.equal((await bot.internal.getLoginInfo()).user_id, 10000)
    assert.equal(state.peakClients, 1)
  })
  console.log('OK SL unavailable port keeps retrying and recovers without process restart')
}

// 验证手动停止及卸载不会被修复模块重新拉起，重新启动保持幂等。
async function verifyStopAndDispose() {
  await withBot('sl', true, async ({ bot, state, recovery }) => {
    const before = state.connections
    await bot.stop()
    await delay(RETRY_MS * 3)
    assert.equal(bot.status, Status.OFFLINE)
    assert.equal(state.connections, before)
    await bot.start()
    await waitUntil(() => bot.status === Status.ONLINE, 'manual restart')
    await bot.start()
    assert.equal(state.connections, before + 1)
    const guardedAccept = bot.adapter.accept
    await recovery.dispose()
    assert.notEqual(bot.adapter.accept, guardedAccept)
    state.clients.values().next().value.close(1000, 'after plugin disposal')
    await waitUntil(() => bot.status === Status.OFFLINE, 'disposed behavior')
    await delay(RETRY_MS * 3)
    assert.equal(state.connections, before + 1)
  })
  await withBot('sl', true, async ({ bot, state, stopServer, restartServer }) => {
    await stopServer()
    await waitUntil(() => bot.status === Status.RECONNECT, 'stop during retry')
    await bot.stop()
    await restartServer()
    await delay(RETRY_MS * 4)
    assert.equal(bot.status, Status.OFFLINE)
    assert.equal(state.connections, 1, 'a pending adapter timer must respect manual stop')
    await bot.start()
    await waitUntil(() => state.connections === 2 && bot.status === Status.ONLINE, 'start after cancelled retry')
  })
  console.log('OK manual stop, explicit restart and plugin disposal preserve lifecycle')
}

// 验证未选择 SL 时保持原行为，避免影响 NapCat 和既有默认安装。
async function verifyProtocolScope() {
  for (const provider of ['napcat', null]) {
    await withBot(provider, true, async ({ bot, state }) => {
      state.clients.values().next().value.close(1000, 'outside SL')
      await waitUntil(() => bot.status === Status.OFFLINE, 'non-SL behavior')
      await delay(RETRY_MS * 3)
      assert.equal(state.connections, 1)
    })
  }
  fs.writeFileSync(path.join(dataDir, 'qq-protocol.json'), JSON.stringify({ provider: 'sl' }))
  const excluded = [
    { platform: 'onebot', config: { protocol: 'ws-reverse' } },
    { platform: 'discord', config: { protocol: 'ws' } },
  ].map(value => ({ ...value, adapter: { accept() {} } }))
  const original = excluded.map(bot => bot.adapter.accept)
  installSlOnebotReconnect({ bots: excluded, on() {} })
  assert.deepEqual(excluded.map(bot => bot.adapter.accept), original)
  console.log('OK NapCat and missing selection remain unchanged')
}

// 按真实事故、恢复、故障窗口和退出边界依次运行，最后清理隔离数据。
async function main() {
  try {
    await verifyOriginalFailure()
    await verifySessionRecovery()
    await verifyUnavailableServer()
    await verifyStopAndDispose()
    await verifyProtocolScope()
    console.log('SL reconnect tests passed: 5; failed: 0')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
