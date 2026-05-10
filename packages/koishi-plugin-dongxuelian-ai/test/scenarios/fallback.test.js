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

function getFallbackStep(api, index) {
  const fb = api.getFallbackSteps()
  return (fb.chat || [])[index - 1]
}

function checkFallbackCallMatchesStep(t, label, call, step, constants) {
  t.check(`${label} call exists`, !!call, JSON.stringify(call || null))
  t.check(`${label} step exists`, !!step, JSON.stringify(step || null))
  if (!call || !step) return
  const provider = constants.PROVIDERS[step.provider]
  t.check(`${label} provider known`, !!provider, JSON.stringify(step))
  t.checkEqual(`${label} model follows fallback step`, call.requestBody && call.requestBody.model, step.model)
  if (provider) {
    t.check(`${label} baseURL follows fallback provider`, call.url.startsWith(provider.baseURL), call.url)
  }
}

function checkManagedThinkingDisabled(t, label, requestBody, step) {
  if (!requestBody || !step) {
    t.check(label, false, JSON.stringify({ requestBody, step }))
    return
  }
  const provider = String(step.provider || '').toLowerCase()
  const model = String(step.model || '').toLowerCase()
  if (provider === 'dashscope' || provider === 'deepseek' || model.includes('deepseek')) {
    t.checkEqual(label, requestBody.enable_thinking, false)
    return
  }
  if (provider === 'glm' || provider === 'kimi' || provider === 'mimorium' || /glm|kimi|mimo/.test(model)) {
    t.checkEqual(label, requestBody.thinking && requestBody.thinking.type, 'disabled')
    return
  }
  t.skip(label, `no disabled-thinking assertion for provider=${step.provider} model=${step.model}`)
}

async function run(t) {
  t.section('scenario: API fallback chain')

  await withApi(t, [
    { status: 429, text: 'rate limited' },
    { json: { choices: [{ message: { content: 'fallback-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    })
    t.checkEqual('scenario 429 falls back to next provider result', result, 'fallback-ok')
    checkFallbackCallMatchesStep(t, 'scenario 429 first fallback', mocked.calls[1], getFallbackStep(api, 1), constants)
  })

  await withApi(t, [
    { status: 400, text: 'bad request' },
    { status: 401, text: 'bad key' },
    { status: 429, text: 'rate limited' },
    { json: { choices: [{ message: { content: 'third-fallback-ok' } }] } },
  ], async (api, constants, mocked) => {
    const result = await api.requestChatCompletions([], {
      model: 'deepseek-chat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'sk-current',
      provider: 'deepseek',
    }, { enable_thinking: false, _thinkingManaged: true, _thinkingEnabled: false, _explicitThinkingKeys: [] })
    t.checkEqual('scenario 400/401/429 chain reaches third fallback response', result, 'third-fallback-ok')
    const thirdStep = getFallbackStep(api, 3)
    checkFallbackCallMatchesStep(t, 'scenario third fallback after 400/401/429', mocked.calls[3], thirdStep, constants)
    checkManagedThinkingDisabled(t, 'scenario third fallback thinking disabled by provider policy', mocked.calls[3] && mocked.calls[3].requestBody, thirdStep)
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
    checkFallbackCallMatchesStep(t, 'scenario network first fallback', mocked.calls[1], getFallbackStep(api, 1), constants)
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
    checkManagedThinkingDisabled(t, 'scenario reasoning-only fallback thinking disabled by provider policy', mocked.calls[1] && mocked.calls[1].requestBody, getFallbackStep(api, 1))
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
    { error: new Error('net6') },
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
