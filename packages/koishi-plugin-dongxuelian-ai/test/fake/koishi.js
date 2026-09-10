const realSetTimeout = global.setTimeout
const realClearTimeout = global.clearTimeout

function makeLogger(logs, name, echoLogs) {
  const push = (level, args) => {
    const msg = args.map(item => {
      if (item instanceof Error) return item.stack || item.message
      if (typeof item === 'string') return item
      try { return JSON.stringify(item) } catch { return String(item) }
    }).join(' ')
    logs.push({ level, name, msg })
    if (echoLogs) console[level === 'debug' ? 'log' : level](`[${name}] ${level}`, msg)
  }
  return {
    info: (...args) => push('info', args),
    warn: (...args) => push('warn', args),
    error: (...args) => push('error', args),
    debug: (...args) => push('debug', args),
  }
}

function makeCtx(options = {}) {
  const middlewareList = []
  const eventListeners = new Map()
  const logs = []
  const ctx = {
    middleware(fn) {
      middlewareList.push(fn)
      return fn
    },
    on(event, handler) {
      const list = eventListeners.get(event) || []
      list.push(handler)
      eventListeners.set(event, list)
      return handler
    },
    async emit(event, ...args) {
      const list = eventListeners.get(event) || []
      for (const handler of list) await handler(...args)
    },
    logger(name) {
      return makeLogger(logs, name, options.echoLogs)
    },
    setTimeout(fn, ms, ...args) {
      return setTimeout(fn, ms, ...args)
    },
    middlewareList,
    eventListeners,
    logs,
  }
  return { ctx, middlewareList, eventListeners, logs }
}

// 假 OneBot 内部通道。
// 刻意定义成类原型方法，而不是对象字面量上的自有箭头/普通函数：真实适配器的 Internal
// 方法内部依赖 `this._get`，调用方一旦解构再调用就会丢掉 this 并全部抛错。
// 保持同样的 this 约束，测试才不会比生产更宽容（线上曾因此每条定位都降级，测试却全绿）。
class FakeInternal {
  constructor(deps) {
    this.internalCalls = deps.internalCalls
    this.timeline = deps.timeline
    this.internalWaiters = deps.internalWaiters
    this.notifyWaiters = deps.notifyWaiters
    this.internalShouldFail = deps.internalShouldFail
    this.options = deps.internal
    this.messages = deps.internalMessages
    this.nextMessageId = deps.internalNextMessageId
    this.applyReplySeqResolution = deps.applyReplySeqResolution
  }

  async sendGroupMsg(groupId, message) {
    const call = { method: 'sendGroupMsg', groupId: String(groupId), message }
    this.internalCalls.push(call)
    this.timeline.push({ type: 'internal', method: 'sendGroupMsg', call })
    this.notifyWaiters(this.internalWaiters, call)
    if (this.internalShouldFail) throw new Error('internal send failed')
    if (typeof this.options.onSendGroupMsg === 'function') return this.options.onSendGroupMsg(call)
    const messageId = `group-msg-${this.nextMessageId()}`
    this.messages.set(messageId, { message_id: messageId, group_id: String(groupId), message: this.applyReplySeqResolution(message) })
    return { message_id: messageId }
  }

  async sendPrivateMsg(userId, message) {
    const call = { method: 'sendPrivateMsg', userId: String(userId), message }
    this.internalCalls.push(call)
    this.timeline.push({ type: 'internal', method: 'sendPrivateMsg', call })
    this.notifyWaiters(this.internalWaiters, call)
    if (this.internalShouldFail) throw new Error('internal send failed')
    return { message_id: 'private-msg' }
  }

  // 复刻 NapCat：读不到的消息按 retcode!==0 抛错，而不是返回失败对象。
  async getMsg(messageId) {
    const id = String(messageId)
    this.internalCalls.push({ method: 'getMsg', messageId: id })
    if (typeof this.options.onGetMsg === 'function') return this.options.onGetMsg(id)
    const found = this.messages.get(id)
    if (!found) throw new Error(`消息不存在: ${id}`)
    return found
  }

  async sendGroupForwardMsg(groupId, messages) {
    const call = { method: 'sendGroupForwardMsg', groupId: String(groupId), messages }
    this.internalCalls.push(call)
    this.timeline.push({ type: 'internal', method: 'sendGroupForwardMsg', call })
    if (this.options.forwardShouldFail) throw new Error('forward card failed')
    return { message_id: `forward-msg-${this.nextMessageId()}` }
  }
}

function makeSession(overrides = {}) {
  const sent = Array.isArray(overrides.sent) ? overrides.sent : []
  const internalCalls = Array.isArray(overrides.internalCalls) ? overrides.internalCalls : []
  const timeline = Array.isArray(overrides.timeline) ? overrides.timeline : []
  const sendWaiters = []
  const internalWaiters = []
  const internalShouldFail = !!overrides.internalShouldFail
  const internal = overrides.internal || {}
  // OneBot 假内部通道：sendGroupMsg 按 message_id 存下实际发出的段，getMsg 再按同一个 ID 读回。
  // 这样测试能真实走完「预检 → 发送 → 读回核验」，也能用 onSendGroupMsg / onGetMsg 伪造引用被丢弃或短 ID 失效。
  const internalMessages = new Map()
  for (const seeded of Array.isArray(internal.seedMessages) ? internal.seedMessages : []) {
    if (seeded && seeded.message_id) internalMessages.set(String(seeded.message_id), seeded)
  }
  let internalMessageSeq = 0
  const internalNextMessageId = () => (internalMessageSeq += 1)
  // 复刻 NapCat 的 seq 路径：只带 seq 的 reply 段会被解析回目标短 ID 再写进实际消息。
  const applyReplySeqResolution = message => {
    if (!Array.isArray(message) || !internal.replySeqMap) return message
    return message.map(segment => {
      if (segment?.type !== 'reply' || segment.data?.id !== undefined) return segment
      const resolved = internal.replySeqMap[String(segment.data?.seq)]
      return resolved ? { ...segment, data: { ...segment.data, id: resolved } } : segment
    })
  }
  const selfId = String(overrides.selfId || overrides.bot?.selfId || '90000')

  const notifyWaiters = (waiters, value) => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]
      let matched = false
      try { matched = waiter.predicate(value) } catch (error) { waiter.reject(error); waiters.splice(i, 1); continue }
      if (matched) {
        realClearTimeout(waiter.timer)
        waiter.resolve(value)
        waiters.splice(i, 1)
      }
    }
  }

  const waitFor = (existing, waiters, predicate, timeoutMs, label) => {
    const test = typeof predicate === 'function' ? predicate : () => true
    const found = existing.find(item => test(item))
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: test,
        resolve,
        reject,
        timer: realSetTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs),
      }
      waiters.push(waiter)
    })
  }

  const session = {
    sent,
    internalCalls,
    timeline,
    userId: '100000000',
    author: { id: '100000000', name: 'tester', nick: 'tester' },
    username: 'tester',
    guildId: '10001',
    channelId: '10001',
    messageId: 'msg-1',
    isDirect: false,
    selfId,
    content: '',
    event: { sender: { role: 'member' }, message: [] },
    bot: {
      selfId,
      // 假内部通道做成原型方法（不是对象字面量上的自有函数），复刻适配器 Internal 的形态：
      // 真实方法内部依赖 this._get，调用方一旦解构就会丢 this 并全部抛错。
      // 线上曾因此每条定位都降级，而当时的假实现不依赖 this，测试全绿却掩盖了问题。
      internal: new FakeInternal({
        internalCalls,
        timeline,
        notifyWaiters,
        internalWaiters,
        internalShouldFail,
        internal,
        internalMessages,
        internalNextMessageId,
        applyReplySeqResolution,
      }),
    },
    async send(message) {
      const text = String(message)
      sent.push(text)
      timeline.push({ type: 'send', message: text })
      notifyWaiters(sendWaiters, text)
      return message
    },
    waitForSend(predicate, timeoutMs = 5000) {
      return waitFor(sent, sendWaiters, predicate, timeoutMs, 'session.send')
    },
    waitForInternalCall(predicate, timeoutMs = 5000) {
      return waitFor(internalCalls, internalWaiters, predicate, timeoutMs, 'bot.internal call')
    },
    ...overrides,
  }
  if (!session.event) session.event = { sender: { role: 'member' }, message: [] }
  if (!session.event.sender) session.event.sender = { role: 'member' }
  if (!Array.isArray(session.event.message)) session.event.message = []
  return session
}

async function flushAsync(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve()
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function runMiddleware(harness, session, options = {}) {
  const ctx = harness.ctx || harness
  const middlewareList = harness.middlewareList || ctx.middlewareList || []
  let nextCalled = false
  const next = () => {
    nextCalled = true
  }
  for (const mw of middlewareList) {
    const before = session.sent.length
    const result = await mw(session, next)
    if (result !== undefined && result !== null) session.sent.push(String(result))
    if (session.sent.length > before || nextCalled) break
  }
  if (options.flush !== false) await flushAsync(options.flushTicks || 8)
  return {
    sent: session.sent,
    internalCalls: session.internalCalls || [],
    nextCalled,
    logs: ctx.logs || harness.logs || [],
    timeline: session.timeline || [],
  }
}

function installFakeTimers(start = 1700000000000) {
  const originals = {
    DateNow: Date.now,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
  }
  let now = Number(start)
  let nextId = 1
  const timers = new Map()

  const addTimer = (fn, delay, args, interval) => {
    const id = nextId++
    timers.set(id, {
      fn,
      args,
      time: now + Math.max(0, Number(delay) || 0),
      interval: interval ? Math.max(1, Number(delay) || 1) : 0,
    })
    return id
  }

  Date.now = () => now
  global.setTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, 0)
  global.clearTimeout = id => { timers.delete(id) }
  global.setInterval = (fn, delay, ...args) => addTimer(fn, delay, args, 1)
  global.clearInterval = id => { timers.delete(id) }

  async function tick(ms) {
    const target = now + Math.max(0, Number(ms) || 0)
    while (true) {
      let dueId = null
      let dueTimer = null
      for (const [id, timer] of timers.entries()) {
        if (timer.time <= target && (!dueTimer || timer.time < dueTimer.time)) {
          dueId = id
          dueTimer = timer
        }
      }
      if (!dueTimer) break
      now = dueTimer.time
      if (!dueTimer.interval) timers.delete(dueId)
      try {
        dueTimer.fn(...dueTimer.args)
      } finally {
        if (dueTimer.interval && timers.has(dueId)) {
          dueTimer.time = now + dueTimer.interval
          timers.set(dueId, dueTimer)
        }
      }
      await flushAsync(1)
    }
    now = target
    await flushAsync(1)
  }

  function uninstall() {
    Date.now = originals.DateNow
    global.setTimeout = originals.setTimeout
    global.clearTimeout = originals.clearTimeout
    global.setInterval = originals.setInterval
    global.clearInterval = originals.clearInterval
    timers.clear()
  }

  return {
    tick,
    uninstall,
    get now() { return now },
    set now(value) { now = Number(value) },
    pendingCount() { return timers.size },
  }
}

module.exports = {
  makeCtx,
  makeSession,
  runMiddleware,
  flushAsync,
  installFakeTimers,
}
