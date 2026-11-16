const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { h, Universal } = require('koishi')
const { OneBotMessageEncoder } = require('koishi-plugin-adapter-onebot')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

const CHAIN = [{ provider: 'deepseek', model: 'deepseek-v4-flash' }, { provider: 'openai', model: 'gpt-4o-mini' }]
const CONFIG = { capability: 'text', provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test', baseURL: '' }
const OK = { json: { choices: [{ message: { content: '备用模型正常回复' } }] } }
const QUOTA = { status: 403, json: { error: { code: 'insufficient_quota', message: 'Free quota exhausted.' } } }
const BALANCE = { status: 402, json: { error: { code: 'insufficient_balance', message: 'Insufficient balance' } } }
const LIMITED = { status: 429, json: { error: { code: 'rate_limit', message: 'Too many requests' } } }
const DENIED = { status: 403, json: { error: { code: 'permission_denied', message: 'Permission denied' } } }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

// 使用独立队列和真实请求适配器，所有模型请求均由模拟上游提供。
async function withQueue(queue, fn) {
  await withScenario({}, async scenario => {
    seedCapabilityConfig(scenario.data, { text: CHAIN, vision: CHAIN })
    const mocked = mockFetch(queue), originalFetch = global.fetch
    global.fetch = mocked.fetch
    try { await fn({ ...scenario, mocked, api: require('../../lib/core/api'), diagnostics: require('../../lib/core/request-diagnostics') }) }
    finally { global.fetch = originalFetch }
  })
}

// 验证整队列失败、混合错误和备用成功，并通过真实中间件检查图片回复。
async function run(t) {
  t.section('scenario: exhausted model queue quota image')
  for (const [label, queue, expected] of [
    ['all quota', [QUOTA, BALANCE], true],
    ['quota then rate limit', [QUOTA, LIMITED], true],
    ['network then balance', [{ error: new TypeError('fetch failed') }, BALANCE], true],
    ['permission then quota', [DENIED, QUOTA], true],
    ['no quota', [DENIED, LIMITED], false],
    ['backup succeeds', [BALANCE, OK], false],
  ]) {
    await withQueue(queue, async ({ api, mocked }) => {
      let failure, result
      try { result = await api.requestChatCompletions([], CONFIG) } catch (error) { failure = error }
      t.check('quota classification: ' + label, (failure?.code === 'MODEL_QUEUE_QUOTA_EXHAUSTED') === expected, failure?.code)
      t.checkEqual('quota tries entire configured queue: ' + label, mocked.calls.length, 2)
      if (label === 'backup succeeds') t.checkEqual('quota never replaces successful backup', result?.content, '备用模型正常回复')
    })
  }
  await withQueue([BALANCE], async ({ api, diagnostics }) => {
    const route = api.freezeChatRoute(CONFIG, CHAIN.map(step => ({ ...CONFIG, ...step })))
    let failure
    try { await api.requestChatCompletions([], CONFIG, { _frozenRoute: route, _frozenRouteStartStepIndex: 1 }) } catch (error) { failure = error }
    t.check('resumed route does not invent failure evidence for skipped models', failure?.code === 'HTTP_402', failure?.code)
    t.check('unknown HTTP errors are not quota evidence', !diagnostics.isModelQuotaFailure(new diagnostics.ModelRequestError('quota', 'HTTP_429', true, 429)))
  })

  // --- 实际回复出口 --- //
  for (const vision of [false, true]) {
    await withQueue([QUOTA, LIMITED], async ({ run, makeSession, data, mocked }) => {
      let content = '<at id="90000"/> 请介绍一下自己'
      if (vision) {
        const imageFile = data.pathFor('quota-input.png')
        fs.writeFileSync(imageFile, PNG)
        content = `<at id="90000"/> 说说图片的内容 <img src="${pathToFileURL(imageFile).href}"/>`
      }
      const session = makeSession({ content })
      await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('model-quota-exhausted.png'))
      const elements = session.sent.flatMap(message => h.parse(message))
      const images = elements.filter(element => ['img', 'image'].includes(element.type))
      const expected = fs.readFileSync(path.resolve(__dirname, '../../assets/model-quota-exhausted.png'))
      t.check(`quota ${vision ? 'vision' : 'text'} sends one intact user supplied image`, images.length === 1 && fs.readFileSync(fileURLToPath(images[0].attrs.src)).equals(expected), session.sent.join(''))
      t.check(`quota ${vision ? 'vision' : 'text'} replaces generic error completely`, session.sent.length === 1 && !session.sent[0].includes('暂时无法连接') && !session.sent[0].includes('请求太勤'), session.sent.join(''))
      t.checkEqual(`quota ${vision ? 'vision' : 'text'} stops after both models fail`, mocked.calls.length, 2)
      const transported = []
      const bot = { selfId: '90000', internal: { async sendGroupMsg(groupId, segments) { transported.push(...segments); return 'quota-image' } },
        session() { return { event: { message: {} }, app: { emit() {} } } } }
      const encoder = new OneBotMessageEncoder(bot, '10001')
      encoder.session = { event: { channel: { type: Universal.Channel.Type.TEXT } }, channelId: '10001', guildId: '10001', isDirect: false }
      await encoder.render(h.normalize(session.sent[0]))
      await encoder.flush()
      t.check(`quota ${vision ? 'vision' : 'text'} reaches actual OneBot image segment`, transported.filter(segment => segment.type === 'image').length === 1 && transported.find(segment => segment.type === 'image').data.file === images[0].attrs.src, JSON.stringify(transported))
      if (vision) t.check('quota vision request really contains original image', mocked.calls.every(call => call.requestBody.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))))
    })
  }
  await withQueue([BALANCE, OK], async ({ run, makeSession }) => {
    const session = makeSession({ content: '<at id="90000"/> 请介绍一下自己' })
    await run(session, { flushTicks: 120 })
    await session.waitForSend(message => String(message).includes('备用模型正常回复'))
    t.check('middleware successful backup keeps normal answer', session.sent.every(message => !message.includes('model-quota-exhausted.png')))
  })
  await withQueue([DENIED, LIMITED], async ({ run, makeSession }) => {
    const session = makeSession({ content: '<at id="90000"/> 请介绍一下自己' })
    await run(session, { flushTicks: 120 })
    await session.waitForSend()
    t.check('middleware all failed without quota keeps ordinary error', session.sent.every(message => !message.includes('model-quota-exhausted.png')))
  })
}

module.exports = { run }
