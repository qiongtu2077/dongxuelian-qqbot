const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { WebSocketServer } = require('ws')
const { setTimeout: realSetTimeout } = require('node:timers')
const { withScenario } = require('./_setup')
const { flushAsync } = require('../fake/koishi')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

// 只等待真实初始化，不额外消耗被测虚拟预算。
async function untilCancellation(predicate) {
  for (let index = 0; index < 400; index++) {
    if (predicate()) return
    await flushAsync(5); await new Promise(resolve => realSetTimeout(resolve, 5))
  }
  throw new Error('cancellation fixture did not reach expected state')
}

// 验证真实媒体引用、平台发送和取消边界，网络与平台使用本机/内存替身。
async function run(t) {
  t.section('scenario: chat cancellation and media ownership')
  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const { ChatTurnBudget } = require('../../lib/lifecycle/chat-turn-budget')
    const { enqueueForChannel } = require('../../lib/lifecycle/channel-task-queue')
    let release, enabled = true, started = 0
    const waiting = new ChatTurnBudget({ channelKey: 'waiting-revocation' })
    const failedGuard = new ChatTurnBudget({ channelKey: 'waiting-revocation' })
    enqueueForChannel('waiting-revocation', () => new Promise(resolve => { release = resolve }), 4)
    await flushAsync(20)
    enqueueForChannel('waiting-revocation', () => { started++ }, 4, { turn: waiting, isActive: () => enabled })
    enqueueForChannel('waiting-revocation', () => { started++ }, 4, { turn: failedGuard, isActive: () => { throw new Error('invalid participation data') } })
    enabled = false; await clock.tick(250)
    enabled = true; release(); await flushAsync(30)
    t.check('waiting authorization revocation is permanent even after reopening', waiting.reason === 'revoked' && waiting.finished && started === 0)
    t.check('invalid participation data cancels queued ownership instead of continuing', failedGuard.reason === 'revoked' && failedGuard.finished)
  })

  await withScenario({}, async ({ data }) => {
    const { storeImageUrl } = require('../../lib/media/image/image-store')
    const { readImageSourceResult } = require('../../lib/media/image/image-source')
    const file = data.pathFor('shared.png'); fs.writeFileSync(file, PNG)
    await storeImageUrl('10001', 'shared-a', '', 'same-source')
    await storeImageUrl('10001', 'shared-b', '', 'same-source')
    await storeImageUrl('10001', 'last-owner', '', 'last-source')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise(resolve => server.once('listening', resolve))
    const endpoint = process.env.DONGXUELIAN_ONEBOT_WS_URL, pending = []
    process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}`
    server.on('connection', socket => socket.on('message', raw => pending.push({ socket, request: JSON.parse(String(raw)) })))
    try {
      const a = new AbortController(), b = new AbortController()
      const first = readImageSourceResult('10001', 'shared-a', a.signal).catch(error => error)
      await untilCancellation(() => pending.length === 1)
      const second = readImageSourceResult('10001', 'shared-b', b.signal)
      await flushAsync(30); await new Promise(resolve => realSetTimeout(resolve, 30))
      a.abort(new Error('first user cancelled'))
      const firstResult = await first
      t.check('cancelling one image user does not close the shared live connection', firstResult.message === 'first user cancelled' && pending[0].socket.readyState === 1 && pending.length === 1)
      pending[0].socket.send(JSON.stringify({ echo: pending[0].request.echo, data: { file } }))
      const result = await second
      t.check('remaining image owner completes from the single shared download', !!result.dataUrl && result.bytes === PNG.length && pending.length === 1)
      await untilCancellation(() => server.clients.size === 0)
      const last = new AbortController()
      const request = readImageSourceResult('10001', 'last-owner', last.signal).catch(error => error)
      await untilCancellation(() => pending.length === 2)
      last.abort(new Error('last user cancelled'))
      await request; await untilCancellation(() => server.clients.size === 0)
      t.check('last image user cancellation closes actual source socket', server.clients.size === 0)
    } finally {
      if (endpoint === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL; else process.env.DONGXUELIAN_ONEBOT_WS_URL = endpoint
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
  })

  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    const { storeImageUrl } = require('../../lib/media/image/image-store')
    const { acquireImageRequest, hasActiveImageRequest } = require('../../lib/media/image/image-request')
    await storeImageUrl('10001', 'coordination', 'https://example.test/coordination.png', '')
    const first = await acquireImageRequest('10001', 'coordination', { source: 'explicit-image', force: true, question: 'shared' })
    const controller = new AbortController()
    const waiter = acquireImageRequest('10001', 'coordination', { source: 'explicit-image', force: true, question: 'shared', signal: controller.signal }).catch(error => error)
    await flushAsync(30)
    controller.abort(new Error('stop waiting'))
    const stopped = await waiter
    t.check('image coordination wait aborts without stealing live owner', stopped.message === 'stop waiting' && hasActiveImageRequest('10001', 'coordination'))
    await first.complete('合法持有者的结果'); await first.release()
    const reused = await acquireImageRequest('10001', 'coordination', { source: 'explicit-image', force: true, question: 'shared' })
    t.check('cancelled image waiter leaves successful owner result intact', reused.status === 'reused' && reused.analysis === '合法持有者的结果')
  })

  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }, { provider: 'deepseek', model: 'deepseek-chat' }], vision: [{ provider: 'glm', model: 'glm-4.6v-flash' }] })
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { collectImageManifest } = require('../../lib/media/image/image-manifest')
    const { readExplicitImageEvidence } = require('../../lib/media/image/image-batch')
    const { getImageEntry } = require('../../lib/media/image/image-store')
    const messages = []
    for (let index = 0; index < 10; index++) {
      const file = data.pathFor(`split-${index}.png`); fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from([index])]))
      messages.push({ messageId: `split-${index}`, message: [{ type: 'image', data: { file: pathToFileURL(file).href } }] })
    }
    const targets = collectImageManifest({ messageId: 'split-turn', _forwardImageMessages: messages }, '10001', '10001')
    const turn = new ChatTurnBudget({ channelKey: '10001' }); turn.select(true); turn.enqueue(); turn.start()
    const calls = [], originalFetch = global.fetch
    global.fetch = (url, options) => {
      const body = JSON.parse(options.body), count = body.messages[0].content.filter(item => item.type === 'image_url').length
      const call = { count, at: Date.now(), signal: options.signal }; calls.push(call)
      if (calls.length === 1) return mockFetch([{ status: 413, json: { error: { message: 'request too large' } } }]).fetch(url, options)
      return new Promise((resolve, reject) => {
        let timer
        const abort = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); call.abortedAt = Date.now(); reject(new Error('vision fixture aborted')) }
        options.signal.addEventListener('abort', abort, { once: true })
        if (calls.length === 2) timer = setTimeout(() => {
          options.signal.removeEventListener('abort', abort)
          resolve(mockFetch([{ json: { choices: [{ message: { content: '这五张图均已读取。' } }] } }]).fetch(url, options))
        }, 50000)
      })
    }
    try {
      const started = Date.now()
      const result = runWithChatTurn(turn, () => readExplicitImageEvidence(targets, '读取全部图片', { turn }))
      await untilCancellation(() => calls.length === 2)
      await clock.tick(50000); await untilCancellation(() => calls.length === 3)
      await clock.tick(40000)
      const proof = await result
      t.check('real capacity split shares one ninety-second vision stage', calls.map(item => item.count).join(',') === '10,5,5' && calls[2].abortedAt - started === 90000)
      t.check('completed split targets stay read while unfinished targets report cancellation', proof.results.filter(item => item.state === 'read').length === 5 && proof.results.filter(item => item.state === 'cancelled').length === 5 && proof.notice.includes('未能读取'))
      t.check('vision timeout keeps text and send reserve without claiming whole-turn cancellation', !turn.signal.aborted && turn.remaining() === 90000)
      const entries = await Promise.all(targets.map(target => getImageEntry('10001', target.id)))
      t.check('split timeout releases every active image reference', entries.every(entry => !entry || !Object.keys(entry.activeOwners || {}).length))
    } finally { global.fetch = originalFetch; turn.finish() }
  })

  await withScenario({ fakeTimers: true }, async ({ clock, makeSession, harness }) => {
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { sendReply } = require('../../lib/reply/reply')
    const { saveConversationTurn, getConversationHistory } = require('../../lib/conversation')
    const turn = new ChatTurnBudget({ channelKey: '10001' }); turn.enqueue(); turn.start()
    const session = makeSession(), submitted = []
    session.send = async message => { submitted.push(message); turn.cancel('revoked'); return ['submitted'] }
    const result = await runWithChatTurn(turn, () => sendReply(harness.ctx, session, '第一条气泡\n第二条气泡\n[图:搞笑]')).catch(error => error)
    t.check('cancellation between bubbles blocks later bubbles and stickers', result instanceof Error && submitted.length === 1 && !String(submitted[0]).includes('第二条'))
    let saveRejected = false
    await runWithChatTurn(turn, async () => saveConversationTurn(session, '迟到输入', '迟到回答')).catch(() => { saveRejected = true })
    t.check('cancelled turn cannot append late successful conversation', saveRejected && !getConversationHistory(session).some(item => item.content.includes('迟到')))
    turn.finish()
  })

  await withScenario({ fakeTimers: true }, async ({ clock, makeSession, harness }) => {
    const { ChatTurnBudget, sendWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { submitChatTurn } = require('../../lib/lifecycle/chat-turn-execution')
    const session = makeSession(), logs = [], turn = new ChatTurnBudget({ channelKey: '10001' }, event => logs.push(event.event))
    let resolveSend, submitted = 0
    session.send = () => { submitted++; return new Promise(resolve => { resolveSend = resolve }) }
    submitChatTurn(turn, session, () => sendWithChatTurn(() => session.send('一次发送')), 4, { random: false, recordImages: false, isFresh: () => true })
    await flushAsync(20); await clock.tick(62000)
    t.check('unacknowledged platform send is recorded unknown and never retried or replaced by notice', submitted === 1 && logs.includes('send_result_unknown') && logs.includes('cleanup_failed'))
    resolveSend(['late-receipt']); await flushAsync(30)
    t.check('late platform receipt does not trigger another send', submitted === 1 && logs.includes('queue_release'))
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { requestOpenAIResponsesWithSearch } = require('../../lib/core/api')
    const originalFetch = global.fetch, calls = []
    global.fetch = (url, options) => {
      calls.push({ url, options, at: Date.now() })
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('search aborted')), { once: true }))
    }
    const turn = new ChatTurnBudget({ channelKey: 'search' }); turn.enqueue(); turn.start()
    try {
      await clock.tick(54000)
      const result = runWithChatTurn(turn, () => requestOpenAIResponsesWithSearch([], { provider: 'openai', apiKey: 'test-key', baseURL: 'https://example.test', model: 'gpt-4o' })).catch(error => error)
      await untilCancellation(() => calls.length === 1)
      await clock.tick(3000)
      t.check('Responses search reserves send window and aborts actual request', await result instanceof Error && calls.length === 1 && calls[0].url.endsWith('/responses') && calls[0].options.signal.aborted && turn.remaining() === 3000)
      await turn.drain()
    } finally { turn.finish(); global.fetch = originalFetch }
  })

  await withScenario({}, async ({ data, makeSession }) => {
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { notifySensitiveHandlers } = require('../../lib/behavior/sensitive')
    const { POLITICAL_HANDLER_DIR } = require('../../lib/core/constants')
    fs.mkdirSync(POLITICAL_HANDLER_DIR, { recursive: true })
    fs.writeFileSync(require('node:path').join(POLITICAL_HANDLER_DIR, '10001.json'), '["12345"]')
    const turn = new ChatTurnBudget({ channelKey: '10001' }), session = makeSession()
    turn.enqueue(); turn.start(); turn.cancel('revoked')
    await runWithChatTurn(turn, () => notifySensitiveHandlers(session, '10001'))
    await turn.drain()
    t.check('cancelled chat cannot submit secondary handler notification', session.sent.length === 0)
    turn.finish()
  })

  for (const cancellation of ['group-close', 'dispose']) await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession, run, harness }) => {
    const originalFetch = global.fetch, calls = []
    global.fetch = (url, options) => {
      calls.push(options)
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled upstream')), { once: true }))
    }
    try {
      const session = makeSession({ content: '<at id="90000"/> 测试取消未完成回答' })
      await run(session, { flush: false }); await untilCancellation(() => calls.length === 1)
      if (cancellation === 'group-close') { data.writeJson('bot-participation.json', { version: 1, privateEnabled: true, groups: { 10001: false } }); await clock.tick(250) }
      else { const disposing = harness.ctx.emit('dispose'); await flushAsync(30); await clock.tick(2000); await disposing }
      await flushAsync(30)
      t.check(`${cancellation} cancels actual model and suppresses late sends and fallback`, calls.length === 1 && calls[0].signal.aborted && session.sent.length === 0)
    } finally { global.fetch = originalFetch }
  })

  await withScenario({ fakeTimers: true }, async ({ clock, makeSession, harness }) => {
    const { ChatTurnBudget } = require('../../lib/lifecycle/chat-turn-budget')
    const { resolveForwardSummary } = require('../../lib/message/forward')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise(resolve => server.once('listening', resolve))
    const endpoint = process.env.DONGXUELIAN_ONEBOT_WS_URL, calls = []
    process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}`
    server.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(String(raw)); calls.push({ request, socket })
      if (calls.length === 1) setTimeout(() => socket.send(JSON.stringify({ echo: request.echo, data: { messages: [
        { sender: { nickname: 'nested' }, raw_message: '', message: [{ type: 'forward', data: { id: 'slow-nested' } }] },
      ] } })), 9000)
    }))
    const turn = new ChatTurnBudget({ channelKey: '10001' }), session = makeSession({ content: '<forward id="root"/>' })
    try {
      const result = resolveForwardSummary(session, session.content, harness.ctx, { turn })
      await untilCancellation(() => calls.length === 1); await clock.tick(9000)
      await untilCancellation(() => calls.length === 2); await clock.tick(1000)
      t.check('nested forward retrieval shares one ten-second stage and reports unavailable', await result === '' && turn.forwardUnavailable && calls.length === 2)
      await untilCancellation(() => server.clients.size === 0)
      t.check('forward stage timeout closes the actual nested socket', server.clients.size === 0)
    } finally {
      turn.finish()
      if (endpoint === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL; else process.env.DONGXUELIAN_ONEBOT_WS_URL = endpoint
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
  })

  for (const cancellation of ['group-close', 'dispose']) await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession, run, harness }) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise(resolve => server.once('listening', resolve))
    const endpoint = process.env.DONGXUELIAN_ONEBOT_WS_URL, calls = []
    process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}`
    server.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(String(raw)))))
    const originalFetch = global.fetch
    let modelCalls = 0
    global.fetch = async () => { modelCalls++; throw new Error('cancelled preprocessing must not invoke model') }
    try {
      const session = makeSession({ content: '<at id="90000"/> <forward id="unload-before-queue"/>' })
      const result = run(session, { flush: false }).catch(error => error)
      await untilCancellation(() => calls.length === 1)
      if (cancellation === 'group-close') {
        data.writeJson('bot-participation.json', { version: 1, privateEnabled: true, groups: { 10001: false } })
        await clock.tick(250)
      } else {
        const disposing = harness.ctx.emit('dispose')
        await flushAsync(30); await clock.tick(2000); await disposing
      }
      const stopped = await result
      await untilCancellation(() => server.clients.size === 0)
      t.check(`${cancellation} during preprocessing closes forward socket and prevents queue submission`, stopped instanceof Error && modelCalls === 0 && session.sent.length === 0 && calls.length === 1)
    } finally {
      global.fetch = originalFetch
      if (endpoint === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL; else process.env.DONGXUELIAN_ONEBOT_WS_URL = endpoint
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    }
  })

  await withScenario({}, async () => {
    const { acquireResourceGate, getResourceGateStatus } = require('../../lib/resource-gate/gate')
    const first = await acquireResourceGate({ taskId: 'voice-owner', kind: 'voice_tts_generation', waitTimeoutMs: 0 })
    const controller = new AbortController()
    try {
      const waiting = acquireResourceGate({ taskId: 'voice-waiter', kind: 'voice_tts_generation', signal: controller.signal }).catch(error => error)
      await untilCancellation(() => getResourceGateStatus().tickets.length === 2)
      controller.abort(new Error('short voice cancelled'))
      const result = await waiting, status = getResourceGateStatus()
      t.check('cancelled short voice gate wait removes only its own ticket', result instanceof Error && status.locked && status.meta.taskId === 'voice-owner' && status.tickets.length === 1)
    } finally { first.release() }
  })

  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    seedCapabilityConfig(data, { 'voice-tts': [{ provider: 'openai', model: 'gpt-4o-mini-tts' }, { provider: 'mimorium', model: 'mimo-v2.5-tts' }] })
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { synthesizeSpeech } = require('../../lib/media/voice/tts')
    const originalFetch = global.fetch, calls = []
    global.fetch = (url, options) => {
      calls.push(options)
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('tts aborted')), { once: true }))
    }
    const turn = new ChatTurnBudget({ channelKey: '10001' }); turn.enqueue(); turn.start()
    try {
      await clock.tick(54000)
      const result = runWithChatTurn(turn, () => synthesizeSpeech('短语音取消验证', { voice: 'alloy' })).catch(error => error)
      await untilCancellation(() => calls.length === 1)
      turn.cancel('revoked')
      t.check('short voice cancellation aborts synthesis without submitting fallback', await result instanceof Error && calls.length === 1 && calls[0].signal.aborted)
    } finally { turn.finish(); global.fetch = originalFetch }
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const { ChatTurnBudget, runWithChatTurn, currentChatTurn, outsideChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { currentModelRequestContext } = require('../../lib/core/model-request-context')
    const { handleChatToolCalls } = require('../../lib/chat/chat-tools')
    const analyze = require('../../lib/agent/tools/analyze-file'), original = analyze.execute
    const turn = new ChatTurnBudget({ channelKey: 'tool' }); turn.enqueue(); turn.start()
    let signal, exited = false
    analyze.execute = (args, context) => {
      signal = context.signal
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { exited = true; reject(new Error('tool timeout')) }, { once: true }))
    }
    try {
      const result = runWithChatTurn(turn, () => handleChatToolCalls([{ id: 'analysis', function: { name: 'analyze_file', arguments: '{}' } }], { channel: 'qq' }))
      await untilCancellation(() => !!signal); await clock.tick(25000)
      const reply = await result
      t.check('tool stage abort reaches actual execution and waits for exit', exited && signal.aborted && reply.results.length === 1)
      let detached
      runWithChatTurn(turn, () => { turn.assertActive(); detached = outsideChatTurn(() => Promise.resolve().then(() => !currentChatTurn() && !currentModelRequestContext())) })
      turn.cancel('revoked')
      t.check('accepted independent work has no foreground chat or model scope', await detached === true)
    } finally { analyze.execute = original; turn.finish() }
  })
}

module.exports = { run }
