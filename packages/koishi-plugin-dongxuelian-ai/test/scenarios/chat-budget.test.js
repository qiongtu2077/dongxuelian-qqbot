const { withScenario } = require('./_setup')
const { flushAsync } = require('../fake/koishi')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')
const { mockFetch } = require('../fake/fetch')
const { setTimeout: realSetTimeout } = require('node:timers')
const fs = require('node:fs')

// 只等真实异步初始化完成，不用虚拟时钟推进文件/网络准备。
async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return
    await flushAsync(5)
    await new Promise(resolve => realSetTimeout(resolve, 5))
  }
  throw new Error('budget fixture did not reach expected state')
}

// 模拟只在收到真实取消信号后退出的 HTTP 请求。
function abortableRequest(signal, record) {
  return new Promise((resolve, reject) => {
    const abort = () => { record.abortedAt = Date.now(); signal.removeEventListener('abort', abort); reject(new Error('fixture aborted')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

// 用虚拟时间量化满队共享检查并验证关群、维护和卸载仍撤销原任务。
async function testSharedQueueMonitor(t) {
  await withScenario({ fakeTimers: true, participationGroups: ['10001', '10002'] }, async ({ clock, data }) => {
    const { createChatTurn, submitChatTurn } = require('../../lib/lifecycle/chat-turn-execution')
    const { clearChannelQueues } = require('../../lib/lifecycle/channel-task-queue')
    const { PARTICIPATION_POLICY_FILE } = require('../../lib/core/participation-policy')
    const { MAINTENANCE_FILE } = require('../../lib/core/constants')
    const baseline = clock.pendingCount()
    const originals = { stat: fs.statSync, exists: fs.existsSync }
    const released = []
    const turns = []
    const started = []
    const logs = []
    let participationChecks = 0
    let maintenanceChecks = 0
    fs.statSync = function countPolicy(file, ...args) {
      if (file === PARTICIPATION_POLICY_FILE) participationChecks++
      return originals.stat.call(this, file, ...args)
    }
    fs.existsSync = function countMaintenance(file, ...args) {
      if (file === MAINTENANCE_FILE) maintenanceChecks++
      return originals.exists.call(this, file, ...args)
    }
    // 一条执行项占槽并可外部释放，其余消息在相同生产入口入队。
    function fill(groupId) {
      const ctx = { logger: () => ({ info: line => logs.push(line) }) }
      const options = { random: false, recordImages: false, isFresh: () => true }
      const entries = []
      for (let index = 0; index < 5; index++) {
        const messageId = `${groupId}-${index}`
        const session = { guildId: groupId, channelId: groupId, messageId, send: async () => {} }
        const turn = createChatTurn(groupId, session, ctx)
        const work = index ? () => { started.push(messageId) } : () => new Promise(resolve => released.push(resolve))
        t.check('monitor fixture queues ' + messageId, submitChatTurn(turn, session, work, 5, options))
        entries.push(turn)
        turns.push(turn)
      }
      return entries
    }
    // 仅记录计时器周期，排除入队、启动和结算使用的实时检查。
    async function checkTicks(ms, expected, label) {
      participationChecks = 0
      maintenanceChecks = 0
      await clock.tick(ms)
      t.check(label, participationChecks === expected && maintenanceChecks === expected,
        JSON.stringify({ participationChecks, maintenanceChecks, expected }))
    }
    try {
      const first = fill('10001')
      await flushAsync(10)
      await checkTicks(10000, 40, 'filled channel uses forty shared config checks per ten seconds')
      const second = fill('10002')
      await flushAsync(10)
      await checkTicks(10000, 40, 'two full channels still use forty shared config checks per ten seconds')

      // 首个所有者超时后继续持有频道，第二个频道通过维护撤销。
      await clock.tick(42000)
      t.check('timed-out owner is isolated while its explicit waiters remain', first[0].reason === 'run_timeout'
        && first.slice(1).every(turn => !turn.reason) && logs.some(line => line.includes('"event":"cleanup_failed"')))
      await checkTicks(1000, 4, 'active waiting turns share a single periodic policy read during isolation')
      data.writeJson('bot-participation.json', { version: 1, privateEnabled: true, groups: { 10001: false, 10002: true } })
      await clock.tick(250)
      t.check('closing one group revokes its waiters and leaves the other group', first.slice(1).every(turn => turn.reason === 'revoked')
        && second.slice(1).every(turn => !turn.reason))
      data.writeJson('bot-participation.json', { version: 1, privateEnabled: true, groups: { 10001: true, 10002: true } })
      released[0]()
      await flushAsync(20)
      t.check('reopening cannot revive revoked waiters', started.length === 0)

      data.writeText('ai-paused.txt', 'fixture maintenance')
      await clock.tick(250)
      t.check('externally enabled maintenance revokes running and waiting turns', second.every(turn => turn.reason === 'revoked'))
      released[1]()
      await flushAsync(20)
      await checkTicks(1000, 0, 'cancelled turns leave no periodic reads')
      fs.unlinkSync(MAINTENANCE_FILE)

      const final = fill('10001')
      await flushAsync(10)
      const disposal = clearChannelQueues()
      released[2]()
      await disposal
      t.check('unload releases shared monitor and revokes queued work', final.every(turn => turn.reason === 'disposed')
        && clock.pendingCount() === baseline && started.length === 0)
    } finally {
      fs.statSync = originals.stat
      fs.existsSync = originals.exists
      for (const turn of turns) turn.cancel('disposed')
      for (const release of released) release()
      await flushAsync(20)
      await clearChannelQueues()
    }
  })
}

// 验证真实队列计时器；虚拟时间仅在本场景显式开启。
async function run(t) {
  t.section('scenario: chat turn budget and queue ownership')
  await testSharedQueueMonitor(t)
  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const baseline = clock.pendingCount()
    const { enqueueForChannel } = require('../../lib/lifecycle/channel-task-queue')
    let release, running = 0, maxRunning = 0, secondStarted = false
    enqueueForChannel('budget-overlap', async () => {
      running++; maxRunning = Math.max(maxRunning, running)
      await new Promise(resolve => { release = resolve })
      running--
    }, 4)
    await flushAsync(10)
    await clock.tick(30000)
    enqueueForChannel('budget-overlap', async () => {
      secondStarted = true
      running++; maxRunning = Math.max(maxRunning, running); running--
    }, 4)
    await clock.tick(30001)
    await flushAsync(20)
    t.check('queue never starts next task while timed-out owner is still running', !secondStarted && maxRunning === 1, JSON.stringify({ secondStarted, maxRunning }))
    release()
    await flushAsync(20)
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const baseline = clock.pendingCount()
    const { ChatTurnBudget, CHAT_TURN_LIMITS } = require('../../lib/lifecycle/chat-turn-budget')
    const turn = new ChatTurnBudget({ channelKey: 'accounting' })
    await clock.tick(10000)
    turn.select(true); turn.enqueue()
    await clock.tick(45000)
    turn.start()
    t.check('preprocessing is charged while queue time is excluded', turn.preprocessMs === 10000 && turn.remaining() === 170000)
    const topic = turn.openStage('topic', CHAT_TURN_LIMITS.topic)
    await clock.tick(8000)
    topic.close()
    const vision = turn.openStage('vision', CHAT_TURN_LIMITS.vision, 75000)
    t.check('record vision shares remaining time and reserves seventy-five seconds', vision.deadline - Date.now() === 87000)
    vision.close(); turn.finish()
    const normal = new ChatTurnBudget({ channelKey: 'normal' }); normal.select(false); normal.enqueue(); normal.start()
    t.check('pure-text records keep sixty-second tier', normal.remaining() === 60000)
    normal.finish()
    const random = new ChatTurnBudget({ channelKey: 'random', random: true }); random.select(true); random.enqueue(); random.start()
    t.check('random image requests never upgrade to record tier', !random.recordImages && random.remaining() === 60000)
    random.finish()
    t.check('finished budget stages leave no timers', clock.pendingCount() === baseline, String(clock.pendingCount()))
    const queued = new ChatTurnBudget({ channelKey: 'ordinary-queue-accounting' })
    await clock.tick(20000); queued.enqueue(); await clock.tick(45000)
    t.check('ordinary explicit reply preserves the full run budget after preprocessing and waiting', queued.remaining() === 60000)
    queued.start()
    t.check('ordinary execution deadline starts at dispatch', queued.deadline - Date.now() === 60000)
    queued.finish()
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const baseline = clock.pendingCount()
    const { enqueueForChannel } = require('../../lib/lifecycle/channel-task-queue')
    const { ChatTurnBudget } = require('../../lib/lifecycle/chat-turn-budget')
    const first = new ChatTurnBudget({ channelKey: 'waiting' }); first.select(true)
    let release, starts = 0
    const results = []
    enqueueForChannel('waiting', () => new Promise(resolve => { release = resolve }), 4, { turn: first })
    await flushAsync(10)
    enqueueForChannel('waiting', () => { starts++ }, 4, { onSettled: reason => results.push(['explicit', reason, Date.now()]) })
    enqueueForChannel('waiting', () => { starts++ }, 4, { turn: new ChatTurnBudget({ channelKey: 'waiting', random: true }), onSettled: reason => results.push(['random', reason, Date.now()]) })
    const begin = Date.now()
    await clock.tick(20000)
    t.check('random waiter expires independently at twenty seconds', results.length === 1 && results[0][0] === 'random' && results[0][2] - begin === 20000)
    await clock.tick(25000)
    t.check('admitted explicit waiter survives forty-five seconds', results.length === 1 && starts === 0)
    release(); await flushAsync(30)
    t.check('explicit waiter runs after the predecessor while the expired random waiter stays removed', starts === 1 && results[0][1] === 'queue_timeout' && results[1]?.[0] === 'explicit' && results[1][1] === 'completed')
    t.check('queue wait expiry and release remove all timers', clock.pendingCount() === baseline, String(clock.pendingCount()))
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const baseline = clock.pendingCount()
    const { enqueueForChannel } = require('../../lib/lifecycle/channel-task-queue')
    const { ChatTurnBudget } = require('../../lib/lifecycle/chat-turn-budget')
    const events = [], settlements = []
    const turn = new ChatTurnBudget({ channelKey: 'isolation' }, event => events.push(event.event))
    let release, starts = 0
    enqueueForChannel('isolation', () => new Promise(resolve => { release = resolve }), 4, { turn, onSettled: reason => settlements.push(reason) })
    await flushAsync(10); await clock.tick(30000)
    enqueueForChannel('isolation', () => { starts++ }, 4, { onSettled: reason => settlements.push(reason) })
    let otherStarted = false
    enqueueForChannel('other-channel', () => { otherStarted = true }, 4)
    await flushAsync(20)
    await clock.tick(32000)
    const rejected = enqueueForChannel('isolation', () => { starts++ }, 4)
    t.check('uncooperative owner isolates the channel and holds already admitted work', turn.signal.aborted && !rejected && starts === 0 && settlements.join(',') === 'cleanup_failed')
    t.check('different channel runs while one owner is stuck', otherStarted)
    release(); await flushAsync(30)
    const recovered = enqueueForChannel('isolation', () => { starts++ }, 4)
    await flushAsync(30)
    t.check('late real exit resumes the admitted waiter and clears only its own isolation', recovered && starts === 2 && settlements.join(',') === 'cleanup_failed,completed')
    t.check('diagnostics preserve cancellation cleanup exit and release order', ['cancel', 'cleanup_start', 'cleanup_failed', 'request_exit', 'queue_release'].every((name, index, order) => events.indexOf(name) >= 0 && (!index || events.indexOf(name) > events.indexOf(order[index - 1]))), events.join(','))
    t.check('isolated channel recovery leaves no timers', clock.pendingCount() === baseline)
  })

  await withScenario({ fakeTimers: true }, async ({ clock }) => {
    const baseline = clock.pendingCount()
    const { enqueueForChannel, clearChannelQueues } = require('../../lib/lifecycle/channel-task-queue')
    const { currentChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    let exitAt = 0, nextAt = 0
    enqueueForChannel('cooperative', () => new Promise(resolve => {
      currentChatTurn().signal.addEventListener('abort', () => setTimeout(() => { exitAt = Date.now(); resolve() }, 1000), { once: true })
    }), 4)
    await flushAsync(10); await clock.tick(30000)
    enqueueForChannel('cooperative', () => { nextAt = Date.now() }, 4)
    await clock.tick(30000); await flushAsync(20)
    t.check('cancellation does not release before actual cleanup', nextAt === 0 && exitAt === 0)
    await clock.tick(1000); await flushAsync(30)
    t.check('next task starts only after cooperative cleanup completes', exitAt > 0 && nextAt >= exitAt)
    const releases = []
    for (const [channel, capacity] of [['group-capacity', 5], ['private-capacity', 2]]) {
      for (let index = 0; index < capacity; index++) t.check(`${channel} accepts slot ${index + 1}`, enqueueForChannel(channel, () => new Promise(resolve => releases.push(resolve)), capacity))
      t.check(`${channel} rejects overflow`, !enqueueForChannel(channel, () => {}, capacity))
    }
    await flushAsync(20)
    const clearing = clearChannelQueues()
    releases.forEach(release => release())
    await flushAsync(20); await clearing
    t.check('dispose cancels queued closures and clears timers', releases.length === 2 && clock.pendingCount() === baseline)
  })

  // 通过群聊消息入口重放十秒内的五问，首条在四个模型上耗尽延期预算。
  await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession, run, harness }) => {
    const models = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner', 'glm-4.7']
    seedCapabilityConfig(data, { text: models.map((model, index) => ({ provider: ['opencode', 'deepseek', 'deepseek', 'glm'][index], model })) })
    const { currentChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const sessions = Array.from({ length: 6 }, (_, index) => {
      const userId = String(200000001 + index)
      return makeSession({ userId, author: { id: userId, name: `群友${index + 1}` }, messageId: `queue-burst-${index + 1}`,
        content: `<at id="90000"/> 第${index + 1}个问题，水星离太阳有多远？` })
    })
    const origin = Date.now(), requests = [], originalFetch = global.fetch
    const success = { json: { choices: [{ message: { content: '水星距离太阳平均约五千八百万公里。' } }] } }
    global.fetch = (url, options) => {
      const messageId = currentChatTurn()?.identity.messageId
      const event = { at: Date.now(), body: JSON.parse(options.body), messageId }
      requests.push(event)
      return messageId === sessions[0].messageId ? abortableRequest(options.signal, event) : mockFetch([success]).fetch(url, options)
    }
    try {
      await run(sessions[0], { flush: false })
      await until(() => requests.length === 1)
      for (const session of sessions.slice(1)) {
        await clock.tick(1800)
        await run(session, { flush: false })
      }
      t.check('five group slots include the running question and the sixth receives the exact overflow notice',
        sessions.slice(0, 5).every(session => session.sent.length === 0) && sessions[5].sent.join('\n') === '消息回不过来了，等下再发吧' && requests.length === 1)

      await clock.tick(60000 - (Date.now() - origin))
      t.check('the running question crosses its original deadline while all admitted waiters remain queued',
        requests.length === 3 && requests.every(request => request.messageId === sessions[0].messageId) && sessions.slice(0, 5).every(session => session.sent.length === 0))

      await clock.tick(37000)
      await until(() => sessions.slice(0, 5).every(session => session.sent.length > 0))
      const events = harness.logs.filter(item => item.msg.startsWith('chat_turn ')).map(item => JSON.parse(item.msg.slice(10)))
      const started = events.filter(event => event.event === 'started')
      const firstRequests = requests.filter(request => request.messageId === sessions[0].messageId)
      const firstNotice = events.findIndex(event => event.event === 'send_result' && event.messageId === sessions[0].messageId)
      t.check('all four models get their time in order, with three seconds left to send the timeout',
        firstRequests.map(request => request.body.model).join(',') === models.join(',')
        && firstRequests.map(request => request.abortedAt - request.at).join(',') === '40000,19000,19000,19000'
        && firstRequests.at(-1).abortedAt - origin === 97000 && events.filter(event => event.event === 'text_fallback_extended').length === 1)
      t.check('first failure sends one notice before the next question starts', sessions[0].sent.join('\n') === `<quote id="${sessions[0].messageId}"/>请求超时了，一会再来`
        && firstNotice >= 0 && firstNotice < events.indexOf(started[1]), JSON.stringify({ sent: sessions[0].sent, firstNotice, nextStarted: events.indexOf(started[1]) }))
      t.check('five admitted questions run FIFO with a fresh sixty-second budget and the sixth never runs',
        started.map(event => event.messageId).join(',') === sessions.slice(0, 5).map(session => session.messageId).join(',')
        && started.every(event => event.remainingMs === 60000) && started.slice(1).every(event => event.queueMs > 45000)
        && sessions.slice(1, 5).every(session => session.sent.length === 1 && String(session.sent[0]).includes('五千八百万公里')))
    } finally { global.fetch = originalFetch }
  })

  // 同一轮的工具续问可再次走备用链，整轮仍只增加一次四十秒。
  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }, { provider: 'deepseek', model: 'deepseek-chat' }] })
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { requestChatCompletions } = require('../../lib/core/api')
    const { loadConfig } = require('../../lib/core/runtime-config')
    const config = await loadConfig(true), events = []
    const turn = new ChatTurnBudget({ channelKey: 'one-fallback-extension' }, event => events.push(event))
    turn.enqueue(); turn.start()
    const originalFetch = global.fetch
    const success = { json: { choices: [{ message: { content: '备用已回答' } }] } }
    global.fetch = mockFetch([{ status: 503 }, success, { status: 503 }, success]).fetch
    try {
      const messages = [{ role: 'user', content: '备用续问' }], options = { _extendTextFallback: true }
      const first = await runWithChatTurn(turn, () => requestChatCompletions(messages, config, options))
      await clock.tick(60000)
      const second = await runWithChatTurn(turn, () => requestChatCompletions(messages, config, options))
      t.check('a later tool request reuses the same extended deadline', first.content === '备用已回答' && second.content === '备用已回答'
        && events.filter(event => event.event === 'text_fallback_extended').length === 1 && turn.remaining() === 40000)
      await clock.tick(40000)
      t.check('the root timer still ends the extended turn at one hundred seconds', turn.signal.aborted && turn.reason === 'run_timeout')
    } finally { global.fetch = originalFetch; turn.finish() }
  })

  for (const record of [false, true]) await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }, { provider: 'deepseek', model: 'deepseek-chat' }] })
    const { ChatTurnBudget, runWithChatTurn } = require('../../lib/lifecycle/chat-turn-budget')
    const { requestChatCompletions } = require('../../lib/core/api')
    const { loadConfig } = require('../../lib/core/runtime-config')
    const config = await loadConfig(true)
    const turn = new ChatTurnBudget({ channelKey: 'model-budget' }); turn.select(record); turn.enqueue(); turn.start()
    await clock.tick(record ? 130000 : 35000)
    const events = [], originalFetch = global.fetch
    global.fetch = (url, options) => {
      const event = { at: Date.now(), body: JSON.parse(options.body), signal: options.signal }; events.push(event)
      return events.length === 1 ? abortableRequest(options.signal, event) : mockFetch([{ json: { choices: [{ message: { content: '备用成功' } }] } }]).fetch(url, options)
    }
    try {
      const started = Date.now()
      const result = runWithChatTurn(turn, () => requestChatCompletions([{ role: 'user', content: '预算回退' }], config))
      await until(() => events.length === 1)
      await clock.tick(record ? 15000 : 12000)
      const reply = await result
      t.check(`${record ? 'record' : 'normal'} reserves actual backup time`, events.length === 2 && events[0].abortedAt - started === (record ? 15000 : 12000) && reply.content === '备用成功')
      t.check('local scheduling fields never enter provider request body', events.every(event => !Object.keys(event.body).some(key => key.startsWith('_') || key === 'signal')))
    } finally { global.fetch = originalFetch; turn.finish() }
  })

  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }] })
    const { requestChatCompletions } = require('../../lib/core/api')
    const { loadConfig } = require('../../lib/core/runtime-config')
    const config = await loadConfig(true), calls = [], originalFetch = global.fetch
    global.fetch = (url, options) => { const item = { at: Date.now() }; calls.push(item); return abortableRequest(options.signal, item) }
    try {
      const start = Date.now()
      const result = requestChatCompletions([{ role: 'user', content: 'short remaining budget' }], config, {
        _timeBudget: { deadline: start + 500, primaryMs: 40000, fallbackMs: 30000, fallbackReserveMs: 30000 },
      }).catch(error => error)
      await until(() => calls.length === 1); await clock.tick(500); await result
      t.check('subsecond remaining budget is never clamped to one second or reserved for nonexistent backup', calls.length === 1 && calls[0].abortedAt - start === 500)
    } finally { global.fetch = originalFetch }
  })

  await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession }) => {
    seedCapabilityConfig(data, { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }, { provider: 'deepseek', model: 'deepseek-chat' }] })
    const { resolveTopicSwitch } = require('../../lib/chat/chat-topic-switch')
    const { saveConversationTurn, getConversationHistory } = require('../../lib/conversation')
    const session = makeSession(); await saveConversationTurn(session, '之前的话题', '已有回复')
    const originalFetch = global.fetch, calls = []
    global.fetch = (url, options) => { calls.push(options); return abortableRequest(options.signal, {}) }
    try {
      const began = Date.now()
      const result = resolveTopicSwitch({ topicKey: 'topic-cooperative', session, currentText: '新的话题' })
      await until(() => calls.length === 1); await clock.tick(8000)
      t.check('topic step shares eight seconds across all configured nodes', await result === null && Date.now() - began === 8000 && calls.length === 1 && calls[0].signal.aborted)
      t.check('unknown topic does not clear existing history', getConversationHistory(session).some(item => item.content.includes('之前的话题')))
      let release
      global.fetch = (url, options) => { calls.push(options); return new Promise(resolve => { release = () => resolve(mockFetch().fetch(url, options)) }) }
      const first = resolveTopicSwitch({ topicKey: 'topic-lock', session, currentText: '第一个' })
      await until(() => calls.length === 2); await clock.tick(1000)
      const expired = resolveTopicSwitch({ topicKey: 'topic-lock', session, currentText: '锁等待' })
      await clock.tick(8000)
      t.check('topic lock waiter settles at its deadline before uncooperative predecessor', await expired === null && calls.length === 2)
      release(); await first; await flushAsync(20)
      t.check('expired topic lock never submits a late request', calls.length === 2)
    } finally { global.fetch = originalFetch }
  })
}

module.exports = { run }
