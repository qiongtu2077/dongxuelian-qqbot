const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

const CHAIN = [
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'mimorium', model: 'mimo-v2.5-pro' },
  { provider: 'dashscope', model: 'qwen-turbo' },
]
const CONFIG = { capability: 'text', provider: 'ignored', model: 'ignored', apiKey: '', baseURL: '' }

// 构造事故的空正文、仅思考、长度截断响应，不包含真实用户原文。
function truncated(tokens = 1024) {
  return { json: { choices: [{ message: { content: '', reasoning_content: 'private-score-reasoning' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: 10 + tokens } } }
}

// 构造可观察的最终评分和实际用量。
function scored(content = '65') {
  return { json: { choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } }
}

// 隔离配置、诊断和通知，仅模拟外部 HTTP，保留真实评分及回退实现。
async function withScoring(queue, fn, chain = CHAIN.slice(0, 2)) {
  await withScenario({}, async scenario => {
    seedCapabilityConfig(scenario.data, { text: chain })
    const api = require('../../lib/core/api')
    const scoring = require('../../lib/behavior/retaliation')
    const diagnostic = require('../../lib/core/request-diagnostics')
    const notifier = require('../../lib/core/capability-failure-notifier')
    const mocked = mockFetch(queue), notifications = []
    const previousFetch = global.fetch, previousWarn = console.warn
    global.fetch = mocked.fetch
    console.warn = () => {}
    notifier.setCapabilityFailureSender(async (adminId, message) => { notifications.push({ adminId, message }) })
    try { await fn({ ...scenario, api, scoring, diagnostic, mocked, notifications }) }
    finally { global.fetch = previousFetch; console.warn = previousWarn; notifier.resetCapabilityFailureNotifier() }
  })
}

// 按实际落盘次序读取该场景的脱敏诊断。
function readEvents(data) {
  const root = path.join(data.dataDir, 'ai-call-diagnostics')
  return fs.readdirSync(root).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').map(JSON.parse))
}

// 事故响应形态回归：预算不足仅产生思考，足够时返回有效整数。
async function runIncidentCase(t) {
  await withScoring([], async ({ scoring, mocked }) => {
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body)
      mocked.push(body.max_tokens < 1024 ? truncated(body.max_tokens) : scored())
      return mocked.fetch(url, options)
    }
    const score = await scoring.calculateRetaliationScore('脱敏评分输入', 'user-score', new Map(), 'group-score')
    t.checkEqual('retaliation incident receives visible integer with sufficient budget', score, 65)
    t.checkEqual('retaliation actual first request uses 1024 instead of ten', mocked.calls[0].requestBody.max_tokens, 1024)
    t.checkEqual('retaliation initial success makes one request', mocked.calls.length, 1)
  })
}

// 覆盖恢复次数、节点预算、真实用量、用途和评分失败后的正文调用。
async function runBudgetCases(t) {
  await withScoring([truncated(), scored()], async ({ scoring, mocked, notifications, diagnostic, data, api }) => {
    const score = await scoring.calculateRetaliationScore('private-score-input', 'u', new Map(), 'g')
    const events = readEvents(data)
    t.checkEqual('retaliation recovery produces score', score, 65)
    t.checkEqual('retaliation one recovery expands actual output budget', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,2048')
    t.check('retaliation recovery keeps actual model and logical request', mocked.calls.every(call => call.requestBody.model === CHAIN[0].model)
      && new Set(events.map(event => event.requestId)).size === 1 && events.every(event => !event.fallback))
    t.checkEqual('retaliation diagnostic records actual budgets and sequence', events.map(event => event.maxTokens + ':' + event.attempt).join(','), '1024:1,2048:2')
    t.check('retaliation purpose labels node failure and recent result', notifications.length === 2
      && notifications.every(item => item.message.startsWith('敌意评分节点调用失败') && item.message.includes('用途：敌意评分'))
      && diagnostic.formatRecentModelDiagnostic().includes('用途：敌意评分'))
    t.check('retaliation internal metadata never enters upstream body', mocked.calls.every(call => !Object.keys(call.requestBody).some(key => key.startsWith('_')) && !('signal' in call.requestBody)))
    t.check('retaliation diagnostics do not leak input reasoning or credential', !JSON.stringify({ events, notifications }).includes('private-score-input')
      && !JSON.stringify({ events, notifications }).includes('private-score-reasoning') && !JSON.stringify({ events, notifications }).includes('test-deepseek-key'))
    api.flushTokenUsage()
    const day = Object.values(data.readJson('token-usage.json')).find(item => item.capabilities?.text)
    t.checkEqual('retaliation counts actual failed and successful usage rather than reserved maximum', day.capabilities.text.models[CHAIN[0].model].total, 1046)
  })
  await withScoring([truncated(), truncated(2048), scored()], async ({ scoring, mocked, diagnostic, data }) => {
    t.checkEqual('retaliation backup succeeds after one recovery', await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), 65)
    t.checkEqual('retaliation new model resets initial output budget', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,2048,1024')
    t.checkEqual('retaliation one recovery stays on the same model before fallback', mocked.calls.map(call => call.requestBody.model).join(','), [CHAIN[0].model, CHAIN[0].model, CHAIN[1].model].join(','))
    t.check('retaliation recent result identifies backup success', diagnostic.formatRecentModelDiagnostic().includes('备用接手成功'))
    t.checkEqual('retaliation diagnostic fallback identity follows actual node', readEvents(data).map(event => event.fallback).join(','), 'false,false,true')
  })
  await withScoring([...Array.from({ length: 6 }, (_, index) => truncated(index % 2 ? 2048 : 1024)), scored('75')], async ({ scoring, mocked, data }) => {
    t.checkEqual('retaliation reaches fourth model after three failed nodes and recoveries', await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), 75)
    t.checkEqual('retaliation every node owns a bounded output budget', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,2048,1024,2048,1024,2048,1024')
    t.checkEqual('retaliation no available priority is skipped', mocked.calls.map(call => call.requestBody.model).join(','), [...CHAIN.slice(0, 3).flatMap(step => [step.model, step.model]), CHAIN[3].model].join(','))
    t.check('retaliation all seven requests share scoring purpose and request id', readEvents(data).every(event => event.purpose === 'retaliation_score')
      && new Set(readEvents(data).map(event => event.requestId)).size === 1)
  }, CHAIN)
  await withScoring([truncated(), truncated(2048), truncated(), truncated(2048), scored('正文继续')], async ({ scoring, mocked, api, data }) => {
    t.checkEqual('retaliation all nodes exhausted returns zero', await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), 0)
    const answer = await api.requestChatCompletions([{ role: 'user', content: '正文输入' }], CONFIG)
    t.checkEqual('retaliation failure leaves main chat functional', answer.content, '正文继续')
    t.checkEqual('retaliation exhausted chain makes no third recovery and main budget stays independent', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,2048,1024,2048,1500')
    const events = readEvents(data)
    t.check('retaliation main answer has separate request identity and purpose', events[4].purpose === 'chat' && events[4].requestId !== events[0].requestId)
  })
}

// 验证真实取消、恢复剩余期限与新节点重新计时，所有全局替换最终恢复。
async function runTimeoutCases(t) {
  await withScoring([scored(), scored()], async ({ api, mocked, notifications }) => {
    global.fetch = async (...args) => {
      const response = await mocked.fetch(...args)
      if (mocked.calls.length !== 1) return response
      return new Promise((_resolve, reject) => args[1].signal.addEventListener('abort', () => reject(args[1].signal.reason), { once: true }))
    }
    const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', _timeoutMs: 1000 })
    const [first, second] = mocked.calls.map(call => call.options.signal)
    t.check('retaliation real timer timeout switches model and refreshes controller', result.content === '65' && first.aborted && !second.aborted && first !== second)
    t.checkEqual('retaliation timeout skips same-node expansion', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,1024')
    t.check('retaliation timeout notification retains scoring purpose and code', notifications.every(item => item.message.includes('用途：敌意评分') && item.message.includes('TIMEOUT')))
  })
  await withScoring([truncated(), scored(), scored()], async ({ api, mocked }) => {
    const now = Date.now, start = now(), setTimer = global.setTimeout, clearTimer = global.clearTimeout
    let elapsed = 0
    const scheduled = [], active = new Set()
    Date.now = () => start + elapsed
    global.setTimeout = (callback, timeout, ...args) => {
      const timer = setTimer(callback, timeout, ...args)
      if ([8000, 500].includes(timeout)) { scheduled.push(timeout); active.add(timer) }
      return timer
    }
    global.clearTimeout = timer => { active.delete(timer); return clearTimer(timer) }
    global.fetch = async (...args) => {
      const response = await mocked.fetch(...args)
      if (mocked.calls.length === 1) elapsed = 7500
      if (mocked.calls.length === 2) return new Promise((_resolve, reject) => args[1].signal.addEventListener('abort', () => reject(args[1].signal.reason), { once: true }))
      return response
    }
    try {
      const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score' })
      t.checkEqual('retaliation recovery timeout still permits backup', result.content, '65')
      t.checkEqual('retaliation recovery shares deadline and next node refreshes eight seconds', scheduled.join(','), '8000,500,8000')
      t.checkEqual('retaliation recovery timeout preserves budget sequence', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,2048,1024')
      t.checkEqual('retaliation success failure and timeout clear all request timers', active.size, 0)
    } finally { Date.now = now; global.setTimeout = setTimer; global.clearTimeout = clearTimer }
  })
  await withScoring([truncated(), scored()], async ({ api, mocked }) => {
    const now = Date.now, start = now()
    Date.now = () => start
    global.fetch = async (...args) => { const response = await mocked.fetch(...args); Date.now = () => start + 8001; return response }
    try {
      const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score' })
      t.checkEqual('retaliation expired node goes straight to next model', result.content, '65')
      t.checkEqual('retaliation expired node submits no recovery', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '1024,1024')
    } finally { Date.now = now }
  })
  await withScoring([truncated()], async ({ api, mocked }) => {
    const now = Date.now, start = now(), controller = new AbortController()
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    let elapsed = 0, failure
    Date.now = () => start + elapsed
    // 恢复已被选择，但上一轮清理完成时恰好过期，不能提交或误报未配置模型。
    controller.signal.removeEventListener = (...args) => { elapsed = 8001; return remove(...args) }
    try {
      try { await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', signal: controller.signal }) }
      catch (error) { failure = error }
      t.check('retaliation expiry before recovery submission retains last upstream failure', failure?.code === 'OUTPUT_TRUNCATED' && mocked.calls.length === 1)
    } finally { Date.now = now }
  }, CHAIN.slice(0, 1))
}

// 保持主动取消、本地回调与不可重试错误的边界，不把它们当成截断恢复。
async function runBoundaryCases(t) {
  await withScoring([scored()], async ({ api, mocked, notifications }) => {
    const controller = new AbortController(), counts = { add: 0, remove: 0 }
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = (...args) => { counts.add++; return add(...args) }
    controller.signal.removeEventListener = (...args) => { counts.remove++; return remove(...args) }
    await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', signal: controller.signal })
    t.check('retaliation successful call releases external abort listener', counts.add === 1 && counts.remove === 1)
    controller.abort()
    try { await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', signal: controller.signal }) } catch { /* 主动取消。 */ }
    t.check('retaliation pre-cancel makes no additional request or alert', mocked.calls.length === 1 && notifications.length === 0)
    const inFlight = new AbortController()
    global.fetch = async (...args) => { await mocked.fetch(...args); inFlight.abort(); throw new Error('cancelled') }
    try { await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', signal: inFlight.signal }) } catch { /* 在途取消。 */ }
    t.check('retaliation in-flight cancel stops backup without upstream alert', mocked.calls.length === 2 && notifications.length === 0)
  })
  for (const hook of ['_onRequestAttempt', '_onRequestExecution']) {
    await withScoring([scored()], async ({ api, mocked, notifications }) => {
      let caught
      try { await api.requestChatCompletions([], CONFIG, { _purpose: 'retaliation_score', [hook]: () => { throw new Error('local scoring hook') } }) }
      catch (error) { caught = error }
      t.check('retaliation local callback stops without fallback or alert ' + hook, caught?.message === 'local scoring hook'
        && mocked.calls.length === (hook === '_onRequestAttempt' ? 0 : 1) && notifications.length === 0)
    })
  }
  await withScoring([{ status: 402, json: { error: { message: 'insufficient balance' } } }, scored()], async ({ scoring, mocked }) => {
    t.checkEqual('retaliation permanent rejection safely returns zero', await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), 0)
    t.checkEqual('retaliation permanent rejection does not expand or fall back', mocked.calls.length, 1)
  })
  await withScoring([{ status: 429 }, scored()], async ({ scoring, mocked }) => {
    t.checkEqual('retaliation retryable non-truncation goes to next node', await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), 65)
    t.checkEqual('retaliation rate limit never causes same-node expansion', mocked.calls.map(call => call.requestBody.model).join(','), CHAIN.slice(0, 2).map(step => step.model).join(','))
  })
}

// 维持原评分解析、用户历史和零值降级约定。
async function runParsingCases(t) {
  for (const [content, expected] of [['0', 0], ['100', 100], ['-5', 0], ['150', 100], ['not-a-score', 0]]) {
    await withScoring([scored(content)], async ({ scoring }) => {
      t.checkEqual('retaliation preserves parsing for ' + content, await scoring.calculateRetaliationScore('输入', 'u', new Map(), 'g'), expected)
    })
  }
  await withScoring([scored()], async ({ scoring, mocked }) => {
    const entries = Array.from({ length: 11 }, (_, index) => ({ role: 'user', userId: 'u', content: 'history-' + index + '-end' }))
    entries.push({ role: 'user', userId: 'u', content: 'current-input' }, { role: 'assistant', userId: 'u', content: 'bot-history-secret' }, { role: 'user', userId: 'other', content: 'other-user-secret' })
    await scoring.calculateRetaliationScore('current-input', 'u', new Map([['g', entries]]), 'g')
    const input = mocked.calls[0].requestBody.messages[1].content
    t.check('retaliation preserves last ten messages of current user only', input.includes('history-2-end') && input.includes('history-10-end')
      && !input.includes('history-1-end') && !input.includes('bot-history-secret') && !input.includes('other-user-secret') && input.split('current-input').length === 2)
  })
}

// 运行敌意评分预算与降级场景。
async function run(t) {
  t.section('scenario: retaliation output budget and fallback')
  await runIncidentCase(t)
  await runBudgetCases(t)
  await runTimeoutCases(t)
  await runBoundaryCases(t)
  await runParsingCases(t)
}

module.exports = { run }
