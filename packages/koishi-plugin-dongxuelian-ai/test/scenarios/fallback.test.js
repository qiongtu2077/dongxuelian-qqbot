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
    ['timeout', { abortError: true }],
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

// 运行四能力优先级场景测试。
async function run(t) {
  t.section('scenario: managed capability fallback')
  await runRoundExhaustionSynthesis(t)
  await runRetryableFailureCases(t)
  await runNonRetryableFailureCase(t)
  await runTerminalFailureCases(t)
  await runCapabilityIsolation(t)
}

module.exports = { run }
