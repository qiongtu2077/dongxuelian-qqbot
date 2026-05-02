const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')

async function withApi(t, queue, fn) {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  await withScenario({}, async () => {
    const mocked = mockFetch(queue)
    global.fetch = mocked.fetch
    console.warn = () => {}
    try {
      const api = require(path.join(AI_ROOT, 'lib', 'api.js'))
      const constants = require(path.join(AI_ROOT, 'lib', 'constants.js'))
      await fn(api, constants, mocked)
    } finally {
      global.fetch = originalFetch
      console.warn = originalWarn
    }
  })
}

async function run(t) {
  t.section('scenario: API fallback chain')

  await withApi(t, [
    { status: 429, text: 'rate limited' },
    { json: { choices: [{ message: { content: 'glm-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    })
    t.checkEqual('scenario 429 falls back to GLM result', result, 'glm-ok')
    t.checkEqual('scenario 429 fallback model is GLM', mocked.calls[1].requestBody.model, 'glm-4.6v-flash')
    t.check('scenario 429 fallback uses GLM baseURL', mocked.calls[1].url.startsWith(constants.PROVIDERS.glm.baseURL), mocked.calls[1].url)
  })

  await withApi(t, [
    { status: 400, text: 'bad request' },
    { status: 401, text: 'bad key' },
    { status: 429, text: 'rate limited' },
    { json: { choices: [{ message: { content: 'dashscope-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    }, { enable_thinking: false, _thinkingManaged: true, _thinkingEnabled: false, _explicitThinkingKeys: [] })
    t.checkEqual('scenario 400/401/429 chain reaches DashScope', result, 'dashscope-ok')
    t.checkEqual('scenario fallback step 3 model stable', mocked.calls[3].requestBody.model, 'qwen3.5-plus')
    t.check('scenario fallback step 3 baseURL stable', mocked.calls[3].url.startsWith(constants.PROVIDERS.dashscope.baseURL), mocked.calls[3].url)
    t.checkEqual('scenario fallback step 3 thinking disabled for DashScope', mocked.calls[3].requestBody.enable_thinking, false)
  })

  await withApi(t, [
    { error: new Error('network down') },
    { json: { choices: [{ message: { content: 'network-fallback-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    })
    t.checkEqual('scenario network error falls back', result, 'network-fallback-ok')
    t.checkEqual('scenario network fallback model is GLM', mocked.calls[1].requestBody.model, 'glm-4.6v-flash')
  })

  await withApi(t, [
    { abortError: true },
    { json: { choices: [{ message: { content: 'abort-fallback-ok' } }] } },
  ], async (api) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    })
    t.checkEqual('scenario AbortError falls back', result, 'abort-fallback-ok')
  })

  await withApi(t, [
    { invalidJson: true, text: '<html>bad gateway</html>' },
    { json: { choices: [{ message: { content: 'invalid-json-fallback-ok' } }] } },
  ], async (api) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    })
    t.checkEqual('scenario invalid JSON falls back', result, 'invalid-json-fallback-ok')
  })

  await withApi(t, [
    { json: { choices: [{ message: { content: '', reasoning_content: 'reasoning-secret' } }] } },
    { json: { choices: [{ message: { content: 'reasoning-fallback-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    }, { enable_thinking: false, _thinkingManaged: true, _thinkingEnabled: false, _explicitThinkingKeys: [] })
    t.checkEqual('scenario reasoning-only falls back', result, 'reasoning-fallback-ok')
    t.checkEqual('scenario reasoning-only fallback GLM thinking disabled', mocked.calls[1].requestBody.thinking.type, 'disabled')
  })

  await withApi(t, [
    { status: 500, text: 'server exploded' },
  ], async (api) => {
    try {
      await api.requestChatCompletions([], {
        model: 'deepseek-chat',
        baseURL: 'https://example.invalid/v1',
        apiKey: 'sk-current',
        provider: 'deepseek',
      })
      t.check('scenario HTTP 500 throws when not fallbackable', false, 'did not throw')
    } catch (error) {
      const msg = String(error && error.message || error)
      t.check('scenario HTTP 500 throws sanitized HTTP error', /HTTP 500/.test(msg) && !msg.includes('sk-current'), msg)
    }
  })

  await withApi(t, [
    { error: new Error('net1') },
    { error: new Error('net2') },
    { error: new Error('net3') },
    { error: new Error('net4') },
    { error: new Error('net5') },
  ], async (api) => {
    try {
      await api.requestChatCompletions([], {
        model: 'deepseek-chat',
        baseURL: 'https://example.invalid/v1',
        apiKey: 'sk-current',
        provider: 'deepseek',
      })
      t.check('scenario all fallbacks fail throws', false, 'did not throw')
    } catch (error) {
      const msg = String(error && error.message || error)
      t.check('scenario all fallbacks fail without key leak', !msg.includes('sk-current'), msg)
    }
  })
}

module.exports = { run }
