const fs = require('node:fs')
const { WebSocketServer } = require('ws')
const { setTimeout: realSetTimeout } = require('node:timers')
const { withScenario } = require('./_setup')
const { flushAsync } = require('../fake/koishi')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

// 等待真实文件及本机 WebSocket 准备，不推进业务虚拟时间。
async function untilRecord(predicate) {
  for (let index = 0; index < 500; index++) {
    if (predicate()) return
    await flushAsync(5)
    await new Promise(resolve => realSetTimeout(resolve, 5))
  }
  throw new Error('record fixture did not reach expected stage')
}

// 外部模型按指定耗时完成，真实 AbortSignal 可终止等待并释放夹具资源。
function delayedModel(url, options, milliseconds, text, event, exit) {
  return new Promise((resolve, reject) => {
    let timer
    const clean = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); exit() }
    const abort = () => { event.abortedAt = Date.now(); clean(); reject(new Error('model fixture aborted')) }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) { abort(); return }
    if (milliseconds !== null) timer = setTimeout(() => { clean(); resolve(mockFetch([{ json: { choices: [{ message: { content: text } }] } }]).fetch(url, options)) }, milliseconds)
  })
}

// 重放事故原文与 SL 空 raw_message、十张原图结构，仅替换模型服务和 QQ 传输。
async function run(t) {
  t.section('scenario: original record timeout and queued second question')
  await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession, run, harness }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }, { provider: 'deepseek', model: 'deepseek-chat' }], vision: [{ provider: 'glm', model: 'glm-4.6v-flash' }] })
    data.writeJson('bot-participation.json', { version: 1, privateEnabled: true, groups: { 1072587329: true } })
    const photoFiles = new Map(), imageSegments = []
    for (let index = 0; index < 10; index++) {
      const file = data.pathFor(`incident-${index}.png`)
      fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from([index])]))
      photoFiles.set(`incident-${index}`, file)
      imageSegments.push({ type: 'image', data: { file: `incident-${index}` } })
    }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise(resolve => server.once('listening', resolve))
    const previousEndpoint = process.env.DONGXUELIAN_ONEBOT_WS_URL, originalFetch = global.fetch
    process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}/onebot/v11/ws`
    const reads = [], requests = []
    const { currentChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    let active = 0, maxActive = 0
    server.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(String(raw))
      const payload = request.action === 'get_forward_msg'
        ? { messages: [{ sender: { nickname: '记录作者' }, raw_message: '', message: [{ type: 'text', data: { text: '事故记录文字' } }, ...imageSegments] }] }
        : { file: photoFiles.get(request.params.file) }
      if (request.action === 'get_image') reads.push(request.params.file)
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: payload, echo: request.echo }))
    }))
    global.fetch = (url, options) => {
      const body = JSON.parse(options.body)
      const images = body.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'image_url') : [])
      const kind = String(body.messages[0]?.content).includes('判断用户是否切换了话题') ? 'topic' : images.length ? 'vision' : body.model === 'deepseek-chat' ? 'backup' : 'primary'
      const event = { kind, body, at: Date.now(), images: images.length, signal: options.signal, messageId: currentChatTurn()?.identity.messageId }
      requests.push(event); active++; maxActive = Math.max(maxActive, active)
      if (event.messageId === second.messageId) {
        active--
        return mockFetch([{ json: { choices: [{ message: { content: '也看到了你引用的记录。' } }] } }]).fetch(url, options)
      }
      const delay = kind === 'vision' ? 11600 : kind === 'backup' ? 9500 : null
      return delayedModel(url, options, delay, kind === 'vision' ? '十张原图都已读取，内容完整。' : '看到了，记录里的十张图我都读完啦。', event, () => active--)
    }
    const common = { guildId: '1072587329', channelId: '1072587329', quote: { messageId: '1810032132', content: '<forward id="incident-record"/>' } }
    const first = makeSession({ ...common, messageId: '-130135401', content: '<at id="90000"/> 你被看光光了' })
    const second = makeSession({ ...common, userId: '200000001', author: { id: '200000001', name: '另一位用户' }, messageId: '606626649', content: '<at id="90000"/> 宝宝你好可爱' })
    const { saveConversationTurn } = require('../../lib/conversation')
    await saveConversationTurn(first, '之前的聊天', '之前的回复')
    try {
      await run(first, { flush: false })
      await untilRecord(() => requests.some(item => item.kind === 'topic'))
      await clock.tick(8000)
      await untilRecord(() => requests.some(item => item.kind === 'vision'))
      await clock.tick(11600)
      await untilRecord(() => requests.some(item => item.kind === 'primary'))
      await clock.tick(3400)
      await run(second, { flush: false })
      const secondQueuedAt = Date.now()
      await clock.tick(36600)
      await untilRecord(() => requests.some(item => item.kind === 'backup'))
      await clock.tick(8400); await flushAsync(30)
      t.check('second original question stays queued after forty-five seconds', Date.now() - secondQueuedAt === 45000 && second.sent.length === 0, JSON.stringify(second.sent))
      t.check('second question waits for the first request to exit', requests.map(item => item.kind).join(',') === 'topic,vision,primary,backup')
      await clock.tick(1100)
      await untilRecord(() => first.sent.length > 0)
      await untilRecord(() => second.sent.length > 0)
      t.check('original first question receives valid backup answer after main timeout', first.sent.some(item => String(item).includes('十张图我都读完')) && !first.sent.some(item => /超时|无法连接|读取失败|fallback/.test(String(item))), JSON.stringify(first.sent))
      t.check('admitted record question receives its reply after the first question exits', second.sent.some(item => String(item).includes('也看到了你引用的记录')), JSON.stringify(second.sent))
      t.check('incident vision receives all ten originals in one real request', requests.find(item => item.kind === 'vision').images === 10 && new Set(reads).size === 10 && reads.length === 10)
      const primary = requests.find(item => item.kind === 'primary')
      t.check('incident primary is cancelled at forty seconds before ordered backup', primary.signal.aborted && primary.abortedAt - primary.at === 40000 && requests.find(item => item.kind === 'backup').at >= primary.abortedAt)
      t.check('no same-channel model overlap throughout original input replay', maxActive === 1 && active === 0)
      const events = harness.logs.filter(item => item.msg.startsWith('chat_turn ')).map(item => JSON.parse(item.msg.slice(10)))
      const started = events.find(item => item.event === 'started' && item.messageId === first.messageId)
      const completed = events.find(item => item.event === 'image_complete' && item.messageId === first.messageId)
      t.check('diagnostics associate the record tier and all read images, without a text fallback extension', started?.tier === 'record_images' && completed?.read === 10 && completed?.unread === 0 && completed?.batches === 1 && !events.some(item => item.event === 'text_fallback_extended'))
      t.check('internal deadline and cancellation fields remain local', requests.every(item => !Object.keys(item.body).some(key => key.startsWith('_') || key === 'signal')))
      const sentCount = first.sent.length + second.sent.length
      await clock.tick(120000); await flushAsync(30)
      t.check('both original questions settle without late extra replies', first.sent.length + second.sent.length === sentCount)
    } finally {
      global.fetch = originalFetch
      if (previousEndpoint === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL
      else process.env.DONGXUELIAN_ONEBOT_WS_URL = previousEndpoint
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

module.exports = { run }
