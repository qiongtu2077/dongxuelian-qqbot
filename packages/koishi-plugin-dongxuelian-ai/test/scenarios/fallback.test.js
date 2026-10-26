'use strict'

const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

const TEXT_CHAIN = Object.freeze([
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
  { provider: 'openai', model: 'gpt-4o-mini' },
])

// 在独立数据目录中安装四能力配置，并用队列化 fetch 执行一次运行时测试。
async function withManagedApi(queue, priorities, fn) {
  await withScenario({}, async scenario => {
    seedCapabilityConfig(scenario.data, priorities)
    const runtime = require(path.join(AI_ROOT, 'lib', 'core', 'runtime-config.js'))
    runtime.resetConfigCache()
    const originalFetch = global.fetch
    const originalWarn = console.warn
    const mocked = mockFetch(queue)
    global.fetch = mocked.fetch
    console.warn = () => {}
    try {
      const api = require(path.join(AI_ROOT, 'lib', 'core', 'api.js'))
      await fn(api, mocked, scenario)
    } finally {
      global.fetch = originalFetch
      console.warn = originalWarn
    }
  })
}

// 以文字能力发起托管调用，传入的直连字段故意与能力链不同以验证链优先。
function requestManagedText(api, extraBody = {}, tools = null) {
  return api.requestChatCompletions([
    { role: 'user', content: 'test' },
  ], {
    capability: 'text',
    provider: 'glm',
    model: 'must-not-be-retried',
    baseURL: 'https://example.invalid/v1',
    apiKey: 'sk-current-secret',
  }, extraBody, tools)
}

// 读取文本结果，兼容运行时为了工具调用保留的结构化返回类型。
function readResultText(result) {
  return typeof result === 'string' ? result : result.content
}

// 验证一次 OpenAI 兼容请求严格匹配指定优先级步骤。
function checkOpenAiCall(t, label, call, step, expectedBaseURL) {
  t.check(`${label} exists`, !!call, JSON.stringify(call || null))
  if (!call) return
  t.checkEqual(`${label} model`, call.requestBody?.model, step.model)
  t.check(`${label} base URL`, call.url.startsWith(expectedBaseURL), call.url)
}

// 复现工具轮次耗尽，并确认最终禁用工具的收尾请求仍使用文字能力链。
async function runRoundExhaustionSynthesis(t) {
  const toolCallResponse = {
    json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-time', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] },
  }
  await withManagedApi([
    toolCallResponse,
    toolCallResponse,
    toolCallResponse,
    toolCallResponse,
    toolCallResponse,
    { json: { choices: [{ message: { content: '现在是中午12点整（基于已查询到的时间结果）。' } }] } },
  ], { text: [{ provider: 'opencode', model: 'deepseek-v4-flash' }] }, async (_api, mocked) => {
    const engine = require(path.join(AI_ROOT, 'lib', 'agent', 'engine.js'))
    const result = await engine.run({
      userMessage: '现在几点了',
      userName: '验证测试',
      userId: 'u-round-exhaust',
      channelKey: 'g-round-exhaust',
      channel: 'qq',
      agentMode: true,
    })
    t.check('round-exhaustion synthesis produces non-empty reply', typeof result.reply === 'string' && result.reply.trim().length > 0, JSON.stringify(result))
    t.check('round-exhaustion synthesis returns final text', result.reply.includes('现在是中午12点整') && !result.reply.includes('未获取到有效回复'), result.reply)
    t.checkEqual('round-exhaustion uses MAX_ROUNDS plus synthesis', mocked.calls.length, 6)
    t.check('round-exhaustion synthesis disables tools', !mocked.calls[5]?.requestBody?.tools?.length, JSON.stringify(mocked.calls[5]?.requestBody || null))
    t.check('round-exhaustion earlier rounds expose tools', mocked.calls[0]?.requestBody?.tools?.length > 0, JSON.stringify(mocked.calls[0]?.requestBody || null))
  })
}

// 验证所有被允许的失败类别都会按顺序进入下一模型，且不会重试调用方原模型。
async function runRetryableFailureCases(t) {
  const cases = [
    ['HTTP 401', { status: 401, text: 'secret auth body' }],
    ['HTTP 429', { status: 429, text: 'secret rate body' }],
    ['HTTP 500', { status: 500, text: 'secret server body' }],
    ['network', { error: new Error('network detail') }],
    ['network AbortError without aborted signal', { abortError: true }],
    ['invalid JSON', { invalidJson: true, text: '<html>secret</html>' }],
    ['empty result', { json: { choices: [{ message: { content: '', reasoning_content: 'private reasoning' } }] } }],
  ]
  for (const [label, failure] of cases) {
    await withManagedApi([
      failure,
      { json: { choices: [{ message: { content: `${label}-fallback-ok` } }] } },
    ], { text: TEXT_CHAIN }, async (api, mocked) => {
      const result = await requestManagedText(api)
      t.checkEqual(`${label} falls back`, readResultText(result), `${label}-fallback-ok`)
      t.checkEqual(`${label} makes exactly two managed calls`, mocked.calls.length, 2)
      checkOpenAiCall(t, `${label} first step`, mocked.calls[0], TEXT_CHAIN[0], 'https://api.deepseek.com')
      checkOpenAiCall(t, `${label} second step`, mocked.calls[1], TEXT_CHAIN[1], 'https://api.openai.com/v1')
      t.check(`${label} never retries caller model`, mocked.calls.every(call => call.requestBody?.model !== 'must-not-be-retried'), JSON.stringify(mocked.calls.map(call => call.requestBody?.model)))
    })
  }
}

// --- 真实计时器超时与主动取消 ---

// 等待真实信号取消；指定成功延迟时及时解除监听，避免测试本身泄漏计时器。
function waitForFetchSignal(signal, completeAfterMs = 0) {
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (completeAfterMs > 0) {
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, completeAfterMs)
    }
  })
}

// 前几个请求仅在实际 AbortSignal 触发后失败，其余请求沿用现有响应队列。
function installSignalAwareFetch(mocked, timeoutCount, successDelayMs = 0) {
  let attempt = 0
  global.fetch = async (url, options) => {
    const current = attempt++
    if (current < timeoutCount) {
      mocked.calls.push({ url: String(url), options, requestBody: JSON.parse(options.body) })
      return waitForFetchSignal(options.signal)
    }
    if (successDelayMs > 0) await waitForFetchSignal(options.signal, successDelayMs)
    return mocked.fetch(url, options)
  }
}

// 真实节点超时后逐项回退，每项取得独立信号与完整时限，成功后清理最后的计时器。
async function runRealTimeoutFallbackCases(t) {
  await withManagedApi([
    { json: { choices: [{ message: { content: 'real-timeout-backup-ok' } }] } },
  ], { text: TEXT_CHAIN }, async (api, mocked) => {
    installSignalAwareFetch(mocked, 1)
    const result = await requestManagedText(api, { _timeoutMs: 1000 })
    t.checkEqual('real timer timeout reaches backup', readResultText(result), 'real-timeout-backup-ok')
    t.checkEqual('real timer timeout attempts exactly two nodes', mocked.calls.length, 2)
    t.check('timed-out primary signal is aborted', mocked.calls[0]?.options.signal.aborted)
    t.check('backup has a fresh active signal', mocked.calls[1]?.options.signal !== mocked.calls[0]?.options.signal && !mocked.calls[1]?.options.signal.aborted)
    checkOpenAiCall(t, 'real timeout first step', mocked.calls[0], TEXT_CHAIN[0], 'https://api.deepseek.com')
    checkOpenAiCall(t, 'real timeout second step', mocked.calls[1], TEXT_CHAIN[1], 'https://api.openai.com/v1')
  })

  const threeNodes = [...TEXT_CHAIN, { provider: 'glm', model: 'glm-5.3-flash' }]
  await withManagedApi([
    { json: { choices: [{ message: { content: 'third-node-ok' } }] } },
  ], { text: threeNodes }, async (api, mocked) => {
    installSignalAwareFetch(mocked, 2, 150)
    const startedAt = Date.now()
    const result = await requestManagedText(api, { _timeoutMs: 1000 })
    t.checkEqual('two real timeouts reach third node', readResultText(result), 'third-node-ok')
    t.checkEqual('three-node timeout chain calls every node once', mocked.calls.length, 3)
    t.checkEqual('three-node timeout chain preserves priority order', mocked.calls.map(call => call.requestBody.model).join(','), threeNodes.map(step => step.model).join(','))
    t.check('each node receives an independent signal', new Set(mocked.calls.map(call => call.options.signal)).size === 3)
    t.check('first two nodes consume separate real timeout periods', Date.now() - startedAt >= 1900)
    t.check('only timed-out node signals are aborted', mocked.calls[0]?.options.signal.aborted && mocked.calls[1]?.options.signal.aborted && !mocked.calls[2]?.options.signal.aborted)
    await new Promise(resolve => setTimeout(resolve, 1050))
    t.check('successful third node timeout is cleared', !mocked.calls[2]?.options.signal.aborted)
  })
}

// 全部节点实际超时后只返回最后的 TIMEOUT，不跳回已失败节点或调用方直连配置。
async function runRealTimeoutTerminalCase(t) {
  await withManagedApi([], { text: TEXT_CHAIN }, async (api, mocked) => {
    installSignalAwareFetch(mocked, TEXT_CHAIN.length)
    let error
    try { await requestManagedText(api, { _timeoutMs: 1000 }) } catch (caught) { error = caught }
    t.checkEqual('all real timeouts return TIMEOUT', error?.code, 'TIMEOUT')
    t.checkEqual('all real timeouts preserve sanitized message', error?.message, 'AI 上游请求超时')
    t.checkEqual('all real timeouts attempt each node once', mocked.calls.length, TEXT_CHAIN.length)
    t.check('all terminal timeout signals were actually aborted', mocked.calls.every(call => call.options.signal.aborted))
    t.check('terminal timeout never retries caller model', mocked.calls.every(call => call.requestBody.model !== 'must-not-be-retried'))
  })
}

// 请求中取消不记为上游故障；已有故障通知期间取消也不得再调用或告警后继模型。
async function runExternalCancellationCases(t) {
  for (const phase of ['request', 'notification']) {
    await withManagedApi([
      { status: 429, text: 'private first-node failure' },
      { json: { choices: [{ message: { content: 'must-not-run' } }] } },
    ], { text: TEXT_CHAIN }, async (api, mocked) => {
      const external = new AbortController()
      const notifier = require(path.join(AI_ROOT, 'lib', 'core', 'capability-failure-notifier.js'))
      const runtime = require(path.join(AI_ROOT, 'lib', 'core', 'runtime-config.js'))
      const notifications = []
      let cancelTimer, error
      notifier.setCapabilityFailureSender(async (adminId, message) => {
        notifications.push({ adminId, message })
        if (phase === 'notification') external.abort()
      })
      if (phase === 'request') {
        installSignalAwareFetch(mocked, 1)
        cancelTimer = setTimeout(() => external.abort(), 30)
      }
      try {
        await requestManagedText(api, { _timeoutMs: 1000, signal: external.signal })
      } catch (caught) {
        error = caught
      } finally {
        clearTimeout(cancelTimer)
        notifier.resetCapabilityFailureNotifier()
      }
      t.check(`${phase} cancellation rejects request`, !!error && external.signal.aborted, error?.message)
      t.checkEqual(`${phase} cancellation never starts backup`, mocked.calls.length, 1)
      t.checkEqual(`${phase} cancellation adds no extra failure notification`, notifications.length, phase === 'request' ? 0 : runtime.getAdminUserIds(true).size)
      t.check(`${phase} cancellation never notifies backup failure`, notifications.every(item => !item.message.includes(`模型：${TEXT_CHAIN[1].model}`)), JSON.stringify(notifications))
    })
  }
}

// 常规失败回退与成功返回后，先前节点的计时器均不得在请求结束后取消信号。
async function runAttemptTimerCleanup(t) {
  await withManagedApi([
    { status: 429, text: 'private first-node failure' },
    { json: { choices: [{ message: { content: 'timer-cleanup-ok' } }] } },
  ], { text: TEXT_CHAIN }, async (api, mocked) => {
    const result = await requestManagedText(api, { _timeoutMs: 1000 })
    t.checkEqual('non-timeout failure still reaches backup', readResultText(result), 'timer-cleanup-ok')
    await new Promise(resolve => setTimeout(resolve, 1050))
    t.check('failed and successful attempt timers are both cleared', mocked.calls.length === 2 && mocked.calls.every(call => !call.options.signal.aborted))
  })
}

// --- HTTP 策略与能力链边界 ---

// 验证非重试错误立即终止，并且异常不包含 Key 或上游正文。
async function runNonRetryableFailureCase(t) {
  await withManagedApi([
    { status: 400, text: 'sensitive bad request body' },
    { json: { choices: [{ message: { content: 'must-not-run' } }] } },
  ], { text: TEXT_CHAIN }, async (api, mocked) => {
    try {
      await requestManagedText(api)
      t.check('HTTP 400 stops fallback', false, 'did not throw')
    } catch (error) {
      const message = String(error?.message || error)
      t.check('HTTP 400 stops fallback', /HTTP 400/.test(message) && mocked.calls.length === 1, message)
      t.check('HTTP 400 error is sanitized', !message.includes('sensitive bad request body') && !message.includes('sk-current-secret'), message)
    }
  })
}

// 验证空优先级不会产生请求，且所有失败步骤都进入通知并保持错误脱敏。
async function runTerminalFailureCases(t) {
  await withManagedApi([], { text: [] }, async (api, mocked) => {
    try {
      await requestManagedText(api)
      t.check('empty text priority throws', false, 'did not throw')
    } catch (error) {
      t.checkEqual('empty text priority error', String(error?.message || error), '该能力未配置模型')
      t.checkEqual('empty text priority sends no upstream request', mocked.calls.length, 0)
    }
  })

  await withManagedApi([
    { status: 429, text: 'first sensitive body' },
    { error: new Error('second network secret') },
  ], { text: TEXT_CHAIN }, async (api, mocked) => {
    const notifier = require(path.join(AI_ROOT, 'lib', 'core', 'capability-failure-notifier.js'))
    const notifications = []
    notifier.resetCapabilityFailureNotifier()
    notifier.setCapabilityFailureSender(async (adminId, message) => notifications.push({ adminId, message }))
    try {
      await requestManagedText(api)
      t.check('all managed steps failing throws', false, 'did not throw')
    } catch (error) {
      const message = String(error?.message || error)
      t.check('all managed steps error is sanitized', !message.includes('secret') && !message.includes('sk-current-secret'), message)
      t.checkEqual('all managed steps are attempted once', mocked.calls.length, 2)
      const notifiedModels = new Set(notifications.map(item => item.message.match(/模型：(.+)$/m)?.[1]))
      t.check('every failed managed step notifies administrators', notifiedModels.has(TEXT_CHAIN[0].model) && notifiedModels.has(TEXT_CHAIN[1].model), JSON.stringify(notifications))
    } finally {
      notifier.resetCapabilityFailureNotifier()
    }
  })
}

// 验证公开回退视图只含四能力，返回副本且能力间完全隔离。
async function runCapabilityIsolation(t) {
  const priorities = {
    text: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
    vision: [{ provider: 'openai', model: 'gpt-4o' }],
    'voice-asr': [{ provider: 'openai', model: 'gpt-4o-transcribe' }],
    'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
  }
  await withManagedApi([], priorities, async api => {
    const steps = api.getFallbackSteps()
    t.checkEqual('fallback view exposes four capabilities', Object.keys(steps).sort().join(','), 'text,vision,voice-asr,voice-tts')
    t.checkEqual('text chain remains isolated', steps.text[0]?.model, 'deepseek-v4-flash')
    t.checkEqual('vision chain remains isolated', steps.vision[0]?.model, 'gpt-4o')
    t.checkEqual('ASR chain remains isolated', steps['voice-asr'][0]?.model, 'gpt-4o-transcribe')
    t.checkEqual('TTS chain remains isolated', steps['voice-tts'][0]?.model, 'mimo-v2.5-tts')
    t.check('fallback view does not expose key material', !JSON.stringify(steps).includes('apiKey') && !JSON.stringify(steps).includes('keyFile'), JSON.stringify(steps))
    steps.text[0].model = 'mutated'
    t.checkEqual('fallback view returns copies', api.getFallbackSteps().text[0]?.model, 'deepseek-v4-flash')
  })
}

// 复现同一模型先后在文字与识图链失败，确认能力提示和通知冷却相互隔离。
async function runFailureCapabilityNotifications(t) {
  const step = { provider: 'openai', model: 'gpt-4o' }
  await withManagedApi(Array.from({ length: 3 }, () => ({ status: 400, text: 'private upstream body' })), { text: [step], vision: [step] }, async (api) => {
    const notifier = require(path.join(AI_ROOT, 'lib', 'core', 'capability-failure-notifier.js'))
    const notifications = []
    notifier.resetCapabilityFailureNotifier()
    notifier.setCapabilityFailureSender(async (adminId, message) => notifications.push({ adminId, message }))
    try {
      for (const capability of ['text', 'text', 'vision']) {
        let failure
        try {
          await api.requestChatCompletions([{ role: 'user', content: 'test' }], {
            capability, provider: 'glm', model: 'ignored', baseURL: 'https://example.invalid/v1', apiKey: 'sk-current-secret',
          })
        } catch (error) { failure = error }
        t.check(`${capability} failure retains HTTP 400`, /HTTP 400/.test(failure?.message), failure?.message)
      }
      const text = notifications.filter(item => item.message.startsWith('文字模型调用失败'))
      const vision = notifications.filter(item => item.message.startsWith('识图模型调用失败'))
      t.check('each repeated text failure reaches every admin', text.length > 0 && new Set(text.map(item => item.adminId)).size * 2 === text.length, JSON.stringify(text))
      t.check('same-model vision failure is independent', vision.length * 2 === text.length && vision.length > 0, JSON.stringify(vision))
      t.check('capability notifications preserve supplier model and sanitization', notifications.every(item => item.message.includes('供应商：GPT') && item.message.includes('模型：gpt-4o') && !item.message.includes('private upstream body') && !item.message.includes('sk-current-secret')), JSON.stringify(notifications))
      for (const [capability, label] of [['voice-asr', '语音识别'], ['voice-tts', '语音合成']]) {
        const before = notifications.length
        await notifier.notifyCapabilityStepFailure('openai', 'gpt-4o', capability)
        t.check(`${capability} notification displays its capability`, notifications.length > before && notifications.slice(before).every(item => item.message.startsWith(label + '模型调用失败')), JSON.stringify(notifications.slice(before)))
      }
    } finally { notifier.resetCapabilityFailureNotifier() }
  })
}

// 运行四能力优先级场景测试。
// 复现执行中路由修改与主备切换，实际成功来源只指向完成该请求的节点。
async function runFrozenRouteCases(t) {
  await withManagedApi([{ json: { choices: [{ message: { content: 'recovery-backup-ok' } }] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
    const route = api.freezeChatRoute({ capability: 'text', apiKey: '', provider: 'glm', model: 'ignored', baseURL: 'https://example.invalid' })
    let execution
    const result = await requestManagedText(api, { _frozenRoute: route, _frozenRouteStartStepIndex: 1, _onRequestExecution: value => { execution = value } })
    t.checkEqual('explicit frozen recovery uses next node once', mocked.calls.length, 1)
    t.checkEqual('explicit frozen recovery produces valid result', readResultText(result), 'recovery-backup-ok')
    t.check('explicit frozen backup is visible in recent status', require('../../lib/core/request-diagnostics').formatRecentModelDiagnostic().includes('备用接手成功'))
    t.checkEqual('recovery keeps original route identity', execution?.routeIdentity, route.identity)
    t.checkEqual('recovery keeps actual full-chain step index', execution?.stepIndex, 1)
    checkOpenAiCall(t, 'explicit frozen recovery node', mocked.calls[0], TEXT_CHAIN[1], 'https://api.openai.com/v1')
    for (const index of [-1, 2, 0.5]) {
      let error
      try { await requestManagedText(api, { _frozenRoute: route, _frozenRouteStartStepIndex: index }) } catch (caught) { error = caught }
      t.check('invalid frozen recovery index rejected: ' + index, /起始节点无效/.test(error?.message))
    }
    let error
    try { await requestManagedText(api, { _frozenRouteStartStepIndex: 1 }) } catch (caught) { error = caught }
    t.check('live callers cannot skip a priority node', /起始节点无效/.test(error?.message))
    t.checkEqual('invalid recovery indexes submit no requests', mocked.calls.length, 1)
  })
  await withManagedApi([
    { status: 429, text: 'upstream private detail' },
    { json: { choices: [{ message: { content: 'frozen-fallback-ok' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } } },
    { json: { choices: [{ message: { content: 'next-config-ok' } }] } },
  ], { text: TEXT_CHAIN }, async (api, mocked, scenario) => {
    const config = { capability: 'text', apiKey: 'caller-secret', provider: 'glm', model: 'ignored', baseURL: 'https://example.invalid' }
    const frozen = api.freezeChatRoute(config)
    seedCapabilityConfig(scenario.data, { text: [...TEXT_CHAIN].reverse() })
    const executions = [], attempted = []
    const result = await requestManagedText(api, { _frozenRoute: frozen, _onRequestAttempt: step => attempted.push(step), _onRequestExecution: step => executions.push(step) })
    t.checkEqual('frozen route survives live configuration edit', readResultText(result), 'frozen-fallback-ok')
    t.check('frozen route and steps are immutable', Object.isFrozen(frozen) && Object.isFrozen(frozen.steps) && frozen.steps.every(Object.isFrozen))
    checkOpenAiCall(t, 'frozen first step', mocked.calls[0], TEXT_CHAIN[0], 'https://api.deepseek.com')
    checkOpenAiCall(t, 'frozen backup step', mocked.calls[1], TEXT_CHAIN[1], 'https://api.openai.com/v1')
    t.checkEqual('every actual frozen attempt records its own node', attempted.map(step => step.provider).join(','), 'deepseek,openai')
    t.checkEqual('successful frozen source records actual backup', executions[0]?.provider, 'openai')
    t.checkEqual('successful frozen source records backup model', executions[0]?.model, 'gpt-4o-mini')
    t.checkEqual('successful frozen source records route identity', executions[0]?.routeIdentity, frozen.identity)
    t.checkEqual('successful frozen source records actual step', executions[0]?.stepIndex, 1)
    t.checkEqual('successful frozen source records actual readable usage', executions[0]?.usage.totalTokens, 20)
    t.checkEqual('unverified weights version remains unreadable', executions[0]?.modelVersion, null)
    t.check('execution metadata never includes credentials', !JSON.stringify(executions).includes('apiKey') && !JSON.stringify(executions).includes('test-openai-key'))
    t.check('frozen controls never enter upstream JSON', mocked.calls.every(call => !JSON.stringify(call.requestBody).includes('_frozenRoute')))
    t.check('next task uses new route identity', api.freezeChatRoute(config).identity !== frozen.identity)
    await requestManagedText(api)
    checkOpenAiCall(t, 'default caller keeps live route behavior', mocked.calls[2], TEXT_CHAIN[1], 'https://api.openai.com/v1')
  })
  await withManagedApi([], { text: TEXT_CHAIN }, async (api, mocked) => {
    let error
    try { await requestManagedText(api, { _onRequestAttempt() { throw new Error('actual call budget exhausted') } }) } catch (caught) { error = caught }
    t.checkEqual('exhausted callback prevents first actual request', mocked.calls.length, 0)
    t.checkEqual('budget failure is not an upstream fallback', error?.message, 'actual call budget exhausted')
  })
}

// 明确任务节点不读取全局路由，原配置变化不影响已经冻结的实际备用来源。
async function runExplicitFrozenRouteCases(t) {
  await withManagedApi([{ status: 429, text: 'private first error' },
    { json: { choices: [{ message: { content: 'explicit-backup-ok' } }] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
    const nodes = [{ provider: 'openai', model: 'explicit-fast', baseURL: 'https://explicit-first.invalid/v1', apiKey: 'first-private-key' },
      { provider: 'openai', model: 'explicit-backup', baseURL: 'https://explicit-backup.invalid/v1', apiKey: 'backup-private-key' }]
    const config = { ...nodes[0], capability: 'text' }
    const frozen = api.freezeChatRoute(config, nodes)
    const reverse = api.freezeChatRoute(config, [...nodes].reverse())
    nodes[0].model = 'mutated-later'
    let execution
    const result = await api.requestChatCompletions([{ role: 'user', content: '虚构节点回放' }], config,
      { _frozenRoute: frozen, _onRequestExecution: value => { execution = value } })
    t.checkEqual('explicit frozen route keeps original primary', mocked.calls[0]?.requestBody?.model, 'explicit-fast')
    t.checkEqual('explicit frozen route uses its own backup', mocked.calls[1]?.requestBody?.model, 'explicit-backup')
    t.checkEqual('explicit frozen backup produces result', readResultText(result), 'explicit-backup-ok')
    t.checkEqual('explicit actual backup step retained', execution?.stepIndex, 1)
    t.checkEqual('explicit actual source identity retained', execution?.routeIdentity, frozen.identity)
    t.check('explicit order changes route identity', reverse.identity !== frozen.identity)
    t.check('explicit frozen input changes cannot mutate steps', Object.isFrozen(frozen.steps) && Object.isFrozen(frozen.steps[0]) && frozen.steps[0].model === 'explicit-fast')
    t.checkEqual('explicit route leaves global capability unchanged', api.getFallbackSteps().text[0]?.model, TEXT_CHAIN[0].model)
    let emptyError
    try { api.freezeChatRoute(config, []) } catch (error) { emptyError = error }
    t.checkEqual('empty explicit route rejected', emptyError?.message, '该能力未配置模型')
    t.checkEqual('empty explicit route adds no request', mocked.calls.length, 2)
  })
}

// 公共成功元数据读取实际结束原因；长度截断不被伪装成stop或推断版本。
async function runFinishReasonCases(t) {
  for (const reason of ['stop', 'length', undefined]) {
    const choice = { message: { content: '{"completed":true}' }, ...(reason ? { finish_reason: reason } : {}) }
    await withManagedApi([{ json: { choices: [choice] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
      let execution
      const result = await requestManagedText(api, { _onRequestExecution: value => { execution = value } })
      t.checkEqual('finish metadata preserves ordinary text result: ' + reason, readResultText(result), '{"completed":true}')
      t.checkEqual('finish metadata reads actual first choice: ' + reason, execution?.finishReason, reason ?? null)
      t.checkEqual('missing finish metadata explicitly unreadable: ' + reason, execution?.finishReasonReadable, reason !== undefined)
      t.checkEqual('finish metadata does not retry successful HTTP: ' + reason, mocked.calls.length, 1)
    })
  }
}

// 通过真实公共请求入口验证两节点原生参数和JSON原话；只有HTTP返回由mock提供。
async function runStructuredOutputCases(t) {
  const nodes = ['qwen3.7-flash', 'qwen3.7-plus'].map(model => ({ provider: 'dashscope', model,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-daily-native-key' }))
  const raw = JSON.stringify({ excerpt: '前文  <think>原话标签</think>  后文', completed: true })
  await withManagedApi([{ status: 429, text: 'private first error' },
    { json: { choices: [{ message: { content: raw }, finish_reason: 'stop' }] } },
    { json: { choices: [{ message: { content: '前文  <think>思考</think>  后文' } }] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
    const route = api.freezeChatRoute(nodes[0], nodes)
    const schema = { type: 'object', properties: { excerpt: { type: 'string' } }, required: ['excerpt'], additionalProperties: false }
    const frozenSchema = JSON.stringify(schema)
    let execution
    const result = await api.requestChatCompletions([{ role: 'user', content: 'JSON原话' }], nodes[0], {
      _frozenRoute: route, max_tokens: 9, thinking: { type: 'enabled' }, _thinkingEnabled: true,
      _structuredOutput: { version: 1, format: 'schema', schema, thinkingBudget: 0 },
      _onRequestAttempt() { schema.properties.excerpt.type = 'integer' },
      _onRequestExecution(value) { execution = value },
    })
    t.checkEqual('native JSON preserves original whitespace and think tags', readResultText(result), raw)
    t.checkEqual('native backup records actual node', execution?.model, nodes[1].model)
    t.checkEqual('native backup retains frozen route identity', execution?.routeIdentity, route.identity)
    t.checkEqual('native primary and backup each submit once', mocked.calls.length, 2)
    for (const [index, call] of mocked.calls.entries()) {
      t.checkEqual('native actual node ' + index, call.requestBody.model, nodes[index].model)
      t.checkEqual('native format ' + index, call.requestBody.response_format?.type, 'json_schema')
      t.checkEqual('native strict schema ' + index, call.requestBody.response_format?.json_schema?.strict, true)
      t.checkEqual('native schema snapshots before first submission ' + index, JSON.stringify(call.requestBody.response_format?.json_schema?.schema), frozenSchema)
      t.checkEqual('native disables inherited thinking ' + index, call.requestBody.enable_thinking, false)
      t.check('native omits tokens and thinking budget ' + index, !('max_tokens' in call.requestBody) && !('thinking_budget' in call.requestBody) && !('thinking' in call.requestBody))
      t.check('native internal controls do not enter wire ' + index, !JSON.stringify(call.requestBody).includes('_structuredOutput') && !JSON.stringify(call.requestBody).includes('_nativeStructuredOutput'))
    }
    const ordinary = await api.requestChatCompletions([{ role: 'user', content: '普通聊天' }], nodes[0], { _frozenRoute: route })
    t.checkEqual('ordinary caller keeps response cleanup', readResultText(ordinary), '前文 后文')
    t.checkEqual('ordinary caller keeps default token limit', mocked.calls[2]?.requestBody.max_tokens, 1500)
    t.check('ordinary caller has no native format', !('response_format' in mocked.calls[2].requestBody))
  })
  await withManagedApi([{ json: { choices: [{ message: { content: '{"completed":true}' } }] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
    await api.requestChatCompletions([{ role: 'user', content: 'JSON object' }], nodes[0], {
      _frozenRoute: api.freezeChatRoute(nodes[0], nodes), _frozenRouteStartStepIndex: 1,
      _structuredOutput: { version: 1, format: 'object', thinkingBudget: 1024 },
    })
    t.checkEqual('native object starts at explicit backup', mocked.calls[0]?.requestBody.model, nodes[1].model)
    t.checkEqual('native object format preserved', mocked.calls[0]?.requestBody.response_format?.type, 'json_object')
    t.checkEqual('native explicit thinking enabled', mocked.calls[0]?.requestBody.enable_thinking, true)
    t.checkEqual('native explicit thinking budget preserved', mocked.calls[0]?.requestBody.thinking_budget, 1024)
    t.check('native object omits token limit', !('max_tokens' in mocked.calls[0].requestBody))
  })
}

// 未核实节点、选项及工具组合在任何实际请求之前拒绝，不能消费主节点后再猜备用能力。
async function runStructuredOutputRejections(t) {
  const node = { provider: 'dashscope', model: 'qwen3.7-flash', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-native-key' }
  await withManagedApi([], { text: TEXT_CHAIN }, async (api, mocked) => {
    const schema = { type: 'object', properties: {}, additionalProperties: false }
    const valid = { version: 1, format: 'schema', schema, thinkingBudget: 0 }
    const route = api.freezeChatRoute(node, [node])
    const cases = [
      { label: 'unknown backup', route: api.freezeChatRoute(node, [node, { ...node, model: 'unknown-model' }]) },
      { label: 'unknown endpoint', route: api.freezeChatRoute(node, [{ ...node, baseURL: 'https://other.invalid/v1' }]) },
      { label: 'unknown protocol', route: api.freezeChatRoute(node, [{ ...node, chatProtocol: 'gemini-content' }]) },
      { label: 'missing frozen route', route: undefined },
      { label: 'unknown version', option: { ...valid, version: 2 } },
      { label: 'unknown format', option: { ...valid, format: 'text' } },
      { label: 'unknown thinking budget', option: { ...valid, thinkingBudget: 1 } },
      { label: 'null option', option: null },
      { label: 'missing schema', option: { version: 1, format: 'schema', thinkingBudget: 0 } },
      { label: 'unknown option key', option: { ...valid, extra: true } },
      { label: 'object with schema', option: { ...valid, format: 'object' } },
      { label: 'object without JSON instruction', option: { version: 1, format: 'object', thinkingBudget: 0 }, content: '普通原话' },
      { label: 'unverified tools', tools: [{ type: 'function', function: { name: 'test', parameters: schema } }] },
    ]
    for (const sample of cases) {
      let error, attempted = 0
      try {
        await api.requestChatCompletions([{ role: 'user', content: sample.content || 'JSON' }], node, {
          _frozenRoute: Object.hasOwn(sample, 'route') ? sample.route : route,
          _structuredOutput: Object.hasOwn(sample, 'option') ? sample.option : valid,
          _onRequestAttempt() { attempted++ },
        }, sample.tools || null)
      } catch (caught) { error = caught }
      t.check('native rejects ' + sample.label, /原生|JSON Object/.test(error?.message), error?.message)
      t.checkEqual('native preflight consumes no attempt: ' + sample.label, attempted, 0)
    }
    t.checkEqual('native invalid requests submit no HTTP', mocked.calls.length, 0)
  })
}

// 已核实GLM推理深度逐字进入实际请求，主备切换与普通调用的默认边界保持。
async function runGlmReasoningEffortCases(t) {
  const node = { provider: 'glm', model: 'glm-5.3-flash', baseURL: 'https://llm.pko.svcfusion.com/v1', apiKey: 'fake-glm-key', chatProtocol: 'openai-chat' }
  const success = { json: { choices: [{ finish_reason: 'stop', message: { content: 'GLM_OK' } }] } }
  await withManagedApi([success, success, success, success], { text: TEXT_CHAIN }, async (api, mocked) => {
    const route = api.freezeChatRoute(node, [node])
    for (const effort of ['low', 'high', 'max']) {
      await api.requestChatCompletions([{ role: 'user', content: 'test' }], node, { _frozenRoute: route, reasoning_effort: effort, thinking: { type: 'enabled' }, max_tokens: 4096, temperature: 0.2 })
      const body = mocked.calls.at(-1).requestBody
      t.checkEqual('GLM wire reasoning effort ' + effort, body.reasoning_effort, effort)
      t.checkEqual('GLM keeps enabled thinking ' + effort, body.thinking.type, 'enabled')
      t.checkEqual('GLM keeps token budget ' + effort, body.max_tokens, 4096)
      t.checkEqual('GLM keeps temperature ' + effort, body.temperature, 0.2)
    }
    await api.requestChatCompletions([{ role: 'user', content: 'ordinary' }], node, { _frozenRoute: route })
    t.check('ordinary GLM does not acquire implicit effort', !Object.hasOwn(mocked.calls.at(-1).requestBody, 'reasoning_effort'))
  })
  await withManagedApi([{ status: 500, text: 'upstream failed' }, success], { text: TEXT_CHAIN }, async (api, mocked) => {
    const route = api.freezeChatRoute(node, [node, { ...node, apiKey: 'fake-glm-backup' }])
    await api.requestChatCompletions([{ role: 'user', content: 'test' }], node, { _frozenRoute: route, reasoning_effort: 'low' })
    t.checkEqual('GLM explicit effort makes only primary and backup calls', mocked.calls.length, 2)
    t.check('GLM explicit effort survives backup', mocked.calls.every(call => call.requestBody.reasoning_effort === 'low'))
  })
}

// GLM对象模式保留输出限额与原文空白，未核实Schema/思考组合及备用在发请求前拒绝。
async function runGlmObjectModeCases(t) {
  const node = { provider: 'glm', model: 'glm-5.3-flash', baseURL: 'https://llm.pko.svcfusion.com/v1', apiKey: 'fake-key', chatProtocol: 'openai-chat' }
  const content = '{"text":"原话  空白\\n<think>原文标签</think>"}'
  const valid = { version: 1, format: 'object' }
  const parameters = { reasoning_effort: 'low', thinking: { type: 'enabled' }, max_tokens: 4096, temperature: 0.2 }
  await withManagedApi([{ json: { choices: [{ finish_reason: 'stop', message: { content } }] } }], { text: TEXT_CHAIN }, async (api, mocked) => {
    const result = await api.requestChatCompletions([{ role: 'user', content: '只返回{"text":"原话"}' }], node, {
      ...parameters, _frozenRoute: api.freezeChatRoute(node, [node]), _structuredOutput: valid,
    })
    const body = mocked.calls[0].requestBody
    t.checkEqual('GLM object preserves exact response text', result.content, content)
    t.checkEqual('GLM object sends response format', body.response_format.type, 'json_object')
    t.checkEqual('GLM object retains token limit', body.max_tokens, 4096)
    t.checkEqual('GLM object retains thinking', body.thinking.type, 'enabled')
    t.checkEqual('GLM object retains effort', body.reasoning_effort, 'low')
    t.checkEqual('GLM object retains temperature', body.temperature, 0.2)
    t.check('GLM object omits foreign/internal controls', !['enable_thinking', 'thinking_budget', '_structuredOutput', '_nativeStructuredOutput'].some(key => Object.hasOwn(body, key)))
  })
  await withManagedApi([], { text: TEXT_CHAIN }, async (api, mocked) => {
    const cases = [
      { label: 'schema', option: { ...valid, format: 'schema', schema: { type: 'object' } } },
      { label: 'foreign thinking budget', option: { ...valid, thinkingBudget: 0 } },
      { label: 'disabled thinking', parameters: { thinking: { type: 'disabled' } } },
      { label: 'different effort', parameters: { reasoning_effort: 'high' } },
      { label: 'unknown backup', nodes: [node, { ...node, model: 'unknown' }] },
    ]
    for (const sample of cases) {
      let error, attempts = 0
      try {
        await api.requestChatCompletions([{ role: 'user', content: sample.content || 'JSON' }], node, {
          ...parameters, ...sample.parameters, _frozenRoute: api.freezeChatRoute(node, sample.nodes || [node]),
          _structuredOutput: sample.option || valid, _onRequestAttempt() { attempts++ },
        })
      } catch (caught) { error = caught }
      t.check('GLM object rejects ' + sample.label, /原生|推理深度/.test(error?.message), error?.message)
      t.checkEqual('GLM object no attempt ' + sample.label, attempts, 0)
    }
    t.checkEqual('GLM object invalid options no network', mocked.calls.length, 0)
  })
}

// 未核实型号、端点、协议或备用在任何实际请求前拒绝，不静默吞掉已请求的推理参数。
async function runGlmReasoningEffortRejections(t) {
  const node = { provider: 'glm', model: 'glm-5.3-flash', baseURL: 'https://llm.pko.svcfusion.com/v1', apiKey: 'fake-glm-key', chatProtocol: 'openai-chat' }
  await withManagedApi([], { text: TEXT_CHAIN }, async (api, mocked) => {
    const cases = [
      { label: 'unknown effort', effort: 'medium', nodes: [node] },
      { label: 'disabled effort', effort: 'none', nodes: [node] },
      { label: 'unknown model', effort: 'low', nodes: [{ ...node, model: 'glm-unverified' }] },
      { label: 'unknown endpoint', effort: 'low', nodes: [{ ...node, baseURL: 'https://other.invalid/v1' }] },
      { label: 'unknown protocol', effort: 'low', nodes: [{ ...node, chatProtocol: 'anthropic-messages' }] },
      { label: 'unknown backup', effort: 'low', nodes: [node, { ...node, model: 'glm-unverified' }] },
    ]
    for (const sample of cases) {
      let error, attempted = 0
      try {
        await api.requestChatCompletions([{ role: 'user', content: 'test' }], node, {
          _frozenRoute: api.freezeChatRoute(node, sample.nodes), reasoning_effort: sample.effort,
          _onRequestAttempt() { attempted++ },
        })
      } catch (caught) { error = caught }
      t.check('GLM effort rejects ' + sample.label, /推理深度/.test(error?.message), error?.message)
      t.checkEqual('GLM invalid effort consumes no attempt ' + sample.label, attempted, 0)
    }
    t.checkEqual('GLM invalid effort submits no HTTP', mocked.calls.length, 0)
  })
}

// 运行四能力优先级与日报冻结路由场景测试。
async function run(t) {
  t.section('scenario: managed capability fallback')
  await runRoundExhaustionSynthesis(t)
  await runRetryableFailureCases(t)
  await runRealTimeoutFallbackCases(t)
  await runRealTimeoutTerminalCase(t)
  await runExternalCancellationCases(t)
  await runAttemptTimerCleanup(t)
  await runNonRetryableFailureCase(t)
  await runTerminalFailureCases(t)
  await runCapabilityIsolation(t)
  await runFrozenRouteCases(t)
  await runExplicitFrozenRouteCases(t)
  await runFinishReasonCases(t)
  await runStructuredOutputCases(t)
  await runStructuredOutputRejections(t)
  await runGlmReasoningEffortCases(t)
  await runGlmObjectModeCases(t)
  await runGlmReasoningEffortRejections(t)
  await runFailureCapabilityNotifications(t)
}

module.exports = { run }
