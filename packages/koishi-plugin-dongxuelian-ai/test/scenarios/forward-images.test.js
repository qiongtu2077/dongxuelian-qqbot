const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

// --- 转发输入夹具 --- //

// 构造协议实际提供的图片段，原图通过 get_image 获取。
function photo(index) { return { type: 'image', data: { file: `forward-image-${index}.png` } } }

// 两种协议提供相同消息段；SL 的 raw_message 保持线上观察到的空字符串。
function node(protocol, message) {
  return { sender: { nickname: '材料作者' }, raw_message: protocol === 'sl' ? '' : message.filter(item => item.type === 'text').map(item => item.data.text).join(''), message }
}

// --- 材料顺序、上限和身份 --- //

// 验证转发文字、图片收集及真正的首次视觉输入。
async function run(t) {
  t.section('scenario: forward images and ten image limit')
  for (const protocol of ['napcat', 'sl']) {
    await withScenario({}, async ({ harness, makeSession }) => {
      const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib/message/forward'))
      const { collectImageManifest } = require(path.join(AI_ROOT, 'lib/media/image/image-manifest'))
      const { imageTargetLabel } = require(path.join(AI_ROOT, 'lib/media/image/image-batch'))
      const session = makeSession({ content: '评价一下', quote: { content: '<forward id="root"/>' } })
      const calls = []
      const summary = await resolveForwardSummary(session, session.content, harness.ctx, { callGetForwardMsg: async id => {
        calls.push(id)
        return { messages: [node(protocol, [{ type: 'text', data: { text: '记录中的文字' } }, ...Array.from({ length: 12 }, (_, index) => photo(index))])] }
      } })
      const targets = collectImageManifest(session, '10001', '10001')
      t.check(`scenario forward ${protocol} caps record at first ten images`, targets.length === 10 && targets.map(item => item.file).join(',') === Array.from({ length: 10 }, (_, index) => photo(index).data.file).join(','), JSON.stringify(targets))
      t.check(`scenario forward ${protocol} preserves text with image limit note`, summary.includes('记录中的文字') && summary.includes('前10张'), summary)
      t.check(`scenario forward ${protocol} fetches material only once`, calls.join(',') === 'root', calls.join(','))
      t.check(`scenario forward ${protocol} numbers record images independently`, imageTargetLabel(targets[9]) === '消息记录第10张', imageTargetLabel(targets[9]))
      await resolveForwardSummary(session, '普通消息', harness.ctx)
      t.check(`scenario forward ${protocol} clears old record images`, collectImageManifest(session, '10001', '10001').length === 0)
    })
  }

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib/message/forward'))
    const { collectImageManifest } = require(path.join(AI_ROOT, 'lib/media/image/image-manifest'))
    const fixtures = {
      root: [node('sl', [photo(0), { type: 'forward', data: { id: 'nested/sl+id' } }])],
      'nested/sl+id': [node('sl', [photo(1), { type: 'forward', data: { content: [{ type: 'node', data: { nickname: '内层', content: [photo(2)] } }] } }])],
    }
    const calls = []
    const session = makeSession({ content: '<forward id="root"/>' })
    await resolveForwardSummary(session, session.content, harness.ctx, { callGetForwardMsg: async id => { calls.push(id); return fixtures[id] } })
    const targets = collectImageManifest(session, '10001', '10001')
    t.check('scenario nested forward images keep record order', targets.map(item => item.file).join(',') === [0, 1, 2].map(index => photo(index).data.file).join(','), JSON.stringify(targets))
    t.check('scenario nested forward text and images share response cache', calls.join(',') === 'root,nested/sl+id', calls.join(','))

    const cycle = makeSession({ content: '<forward id="cycle"/>' })
    let requests = 0
    await resolveForwardSummary(cycle, cycle.content, harness.ctx, { callGetForwardMsg: async () => { requests++; return [node('sl', [photo(3), { type: 'forward', data: { id: 'cycle' } }])] } })
    t.check('scenario cyclic forward is bounded and fetched once', requests === 1 && cycle._forwardImageMessages.length === 1, String(requests))
  })

  // --- 真实中间件与 OneBot 传输 --- //
  for (const protocol of ['napcat', 'sl']) {
    await withScenario({}, async ({ harness, makeSession, run, data }) => {
      const records = [node(protocol, [{ type: 'text', data: { text: '记录中的文字' } }]), node(protocol, Array.from({ length: 12 }, (_, index) => photo(index)))]
      const imageFiles = new Map()
      for (let index = 0; index < 12; index++) {
        const file = data.pathFor(`original-${index}.png`)
        fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from([index])]))
        imageFiles.set(photo(index).data.file, file)
      }
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await new Promise(resolve => server.once('listening', resolve))
      const previousEndpoint = process.env.DONGXUELIAN_ONEBOT_WS_URL
      process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}/onebot/v11/ws`
      const reads = []
      const forwards = []
      server.on('connection', socket => socket.on('message', raw => {
        const request = JSON.parse(String(raw))
        let payload
        if (request.action === 'get_forward_msg') { forwards.push(request.params.id); payload = { messages: records } }
        else if (request.action === 'get_image') { reads.push(request.params.file); payload = { file: imageFiles.get(request.params.file) } }
        else throw new Error('unexpected forward test action: ' + request.action)
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: payload, echo: request.echo }))
      }))
      const mocked = mockFetch([
        { json: { choices: [{ message: { content: '已读取消息记录前十张原图，各图内容均已确认。' } }] } },
        { json: { choices: [{ message: { content: '记录文字和前十张图均已读完。' } }] } },
      ])
      const originalFetch = global.fetch
      global.fetch = mocked.fetch
      try {
        const session = makeSession({ content: '<at id="90000"/> 总结消息记录里的文字和图片', quote: { messageId: 'record-source', content: '<forward id="root"/>' } })
        await run(session, { flushTicks: 120 })
        await session.waitForSend(message => String(message).includes('均已读完'))
        const vision = mocked.calls.filter(call => call.requestBody?.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')))
        const inputs = vision[0]?.requestBody.messages[0].content || []
        t.check(`scenario ${protocol} quoted forward middleware reads ten original images before answering`, vision.length === 1 && inputs.filter(item => item.type === 'image_url').length === 10, JSON.stringify({ calls: mocked.calls.length, visionCalls: vision.length }))
        t.check(`scenario ${protocol} never fetches record images eleven and twelve`, reads.length === 10 && !reads.includes(photo(10).data.file) && !reads.includes(photo(11).data.file), reads.join(','))
        t.check(`scenario ${protocol} middleware fetches quoted record once`, forwards.join(',') === 'root', forwards.join(','))
        const finalRequest = mocked.calls.at(-1)?.requestBody?.messages || []
        t.check(`scenario ${protocol} final answer receives record text and fresh vision evidence`, finalRequest.some(message => String(message.content).includes('记录中的文字')) && finalRequest.some(message => String(message.content).includes('视觉批次')), JSON.stringify(finalRequest))
      } finally {
        global.fetch = originalFetch
        if (previousEndpoint === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL
        else process.env.DONGXUELIAN_ONEBOT_WS_URL = previousEndpoint
        for (const socket of server.clients) socket.terminate()
        await new Promise(resolve => server.close(resolve))
      }
    })
  }
}

module.exports = { run }
