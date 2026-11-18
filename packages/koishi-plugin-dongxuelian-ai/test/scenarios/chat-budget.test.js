const { withScenario } = require('./_setup')
const { flushAsync } = require('../fake/koishi')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')
const { mockFetch } = require('../fake/fetch')
const { setTimeout: realSetTimeout } = require('node:timers')

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

// 验证真实队列计时器；虚拟时间仅在本场景显式开启。
async function run(t) {
  t.section('scenario: chat turn budget and queue ownership')
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
    t.check('queued validity checks exclude wait time from ordinary business budget', queued.remaining() === 40000)
    queued.start(); queued.finish()
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
    t.check('explicit waiter expires independently at forty-five seconds', results.length === 2 && results[1][0] === 'explicit' && results[1][2] - begin === 45000)
    release(); await flushAsync(30)
    t.check('expired closures never execute after predecessor exits', starts === 0 && results.every(item => item[1] === 'queue_timeout'))
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
    t.check('uncooperative owner isolates channel after cleanup grace', turn.signal.aborted && !rejected && starts === 0 && settlements.join(',') === 'cleanup_failed,cleanup_failed')
    t.check('different channel runs while one owner is stuck', otherStarted)
    release(); await flushAsync(30)
    const recovered = enqueueForChannel('isolation', () => { starts++ }, 4)
    await flushAsync(30)
    t.check('late real exit clears only its own isolation', recovered && starts === 1 && settlements.length === 2)
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
    for (const [channel, capacity] of [['group-capacity', 4], ['private-capacity', 2]]) {
      for (let index = 0; index < capacity; index++) t.check(`${channel} accepts slot ${index + 1}`, enqueueForChannel(channel, () => new Promise(resolve => releases.push(resolve)), capacity))
      t.check(`${channel} rejects overflow`, !enqueueForChannel(channel, () => {}, capacity))
    }
    await flushAsync(20)
    const clearing = clearChannelQueues()
    releases.forEach(release => release())
    await flushAsync(20); await clearing
    t.check('dispose cancels queued closures and clears timers', releases.length === 2 && clock.pendingCount() === baseline)
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
