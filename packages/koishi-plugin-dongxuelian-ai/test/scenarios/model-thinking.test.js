'use strict'

const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

const QWEN = { provider: 'dashscope', model: 'qwen3.6-35b-a3b', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-qwen', chatProtocol: 'openai-chat' }
const GLM = { provider: 'custom-thinking1', model: 'glm-5.3-flash', baseURL: 'https://llm.pko.svcfusion.com/v1', apiKey: 'test-glm', chatProtocol: 'openai-chat' }
const MESSAGES = [{ role: 'user', content: 'Reply OK.' }]

// 使用真实 API/配置模块及按请求体拒绝错误参数的模拟上游；不替换思考适配函数。
async function withThinkingApi(nodes, fn) {
  await withScenario({}, async scenario => {
    const config = seedCapabilityConfig(scenario.data, { text: [{ provider: 'dashscope', model: QWEN.model }] })
    const customNodes = [...new Map([GLM, ...nodes.filter(node => node.provider.startsWith('custom-'))].map(node => [node.provider, node])).values()]
    scenario.data.writeJson('ai-providers-custom.json', customNodes.map(node => ({
      id: node.provider, name: node.provider, baseURL: node.baseURL, keyFile: `ai-${node.provider}-key.txt`,
    })))
    for (const node of customNodes) {
      scenario.data.writeText(`ai-${node.provider}-key.txt`, node.apiKey)
      config.providers[node.provider] = { models: [{ id: node.model, name: node.model, capabilities: ['text', 'vision'] }] }
    }
    config.priorities.text = nodes.map(node => ({ provider: node.provider, model: node.model }))
    config.priorities.vision = [{ provider: GLM.provider, model: GLM.model }]
    scenario.data.writeJson('ai-capability-config.json', config)
    const runtime = require(path.join(AI_ROOT, 'lib/core/runtime-config'))
    runtime.resetConfigCache()
    runtime.setThinkingEnabled(false)
    const api = require(path.join(AI_ROOT, 'lib/core/api'))
    const calls = [], previousFetch = global.fetch, previousWarn = console.warn
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url: String(url), body })
      let status = 200, result = { choices: [{ finish_reason: 'stop', message: { content: body.response_format ? '{"ok":true}' : 'THINKING_OK' } }] }
      if (body.model === QWEN.model) {
        status = 403; result = { error: { code: 'insufficient_quota', message: 'Free quota exhausted' } }
      } else if (body.enable_thinking === false || body.thinking?.type === 'disabled') {
        status = 400; result = { error: { code: '1210', message: '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。' } }
      }
      return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })
    }
    console.warn = () => {}
    try { await fn({ api, runtime, calls, scenario }) }
    finally { global.fetch = previousFetch; console.warn = previousWarn }
  })
}

// 真实聊天入口复现额度耗尽后切换 GLM；再走带图片的识图入口，均必须有最终正文。
async function runChatFallback(t) {
  for (const vision of [false, true]) {
    await withThinkingApi([QWEN, GLM], async ({ calls }) => {
      const chat = require(path.join(AI_ROOT, 'lib/chat'))
      const input = vision ? [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }] : MESSAGES
      const result = await chat.callOpenAI(input, false)
      const label = vision ? 'vision entry' : 'chat fallback'
      t.checkEqual(label + (vision ? ' returns visible answer' : ' returns visible answer after quota failure'), result, 'THINKING_OK')
      t.checkEqual(label + ' attempts each configured node once', calls.length, vision ? 1 : 2)
      if (!vision) t.checkEqual(label + ' Qwen keeps supported disable switch', calls[0].body.enable_thinking, false)
      const body = calls.at(-1).body
      t.checkEqual(label + ' GLM enables thinking', body.thinking?.type, 'enabled')
      t.checkEqual(label + ' GLM defaults to low', body.reasoning_effort, 'low')
      t.check(label + ' GLM carries no foreign/internal fields', !Object.keys(body).some(key => key.startsWith('_') || key === 'enable_thinking'))
    })
  }
}

// 主模型、Agent/辅助判断直接调用、显式关闭与全局开启都服从同一强制思考规则。
async function runForcedThinkingEntrypoints(t) {
  const samples = [
    ['chat', {}], ['topic_switch', { _purpose: 'topic_switch' }],
    ['identity_judge', { _purpose: 'identity_judge' }], ['retaliation_score', { _purpose: 'retaliation_score' }],
    ['agent off', { _thinkingEnabled: false }], ['agent on', { _thinkingEnabled: true }],
    ['explicit disabled', { enable_thinking: false, thinking: { type: 'disabled' } }],
  ]
  for (const [label, extra] of samples) {
    await withThinkingApi([GLM], async ({ api, calls }) => {
      const result = await api.requestChatCompletions(MESSAGES, GLM, extra)
      t.checkEqual(label + ' GLM succeeds', result.content, 'THINKING_OK')
      t.checkEqual(label + ' forced enabled', calls[0].body.thinking?.type, 'enabled')
      t.checkEqual(label + ' forced low', calls[0].body.reasoning_effort, 'low')
      t.check(label + ' no disable alias', !Object.hasOwn(calls[0].body, 'enable_thinking'))
    })
  }
}

// 官方两个强制思考型号共用同一规则，未知型号仍跟随服务端默认。
async function runOfficialGlmCases(t) {
  for (const endpoint of ['https://api.z.ai/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4']) {
    for (const model of ['glm-5.3', 'glm-5.3-flash']) {
      await withThinkingApi([GLM], async ({ api, calls }) => {
        const result = await api.requestChatCompletions(MESSAGES, { ...GLM, model, baseURL: endpoint }, { _thinkingEnabled: false })
        t.checkEqual(endpoint + '/' + model + ' returns visible result', result.content, 'THINKING_OK')
        t.check('official forced thinking uses enabled low', calls[0].body.thinking?.type === 'enabled' && calls[0].body.reasoning_effort === 'low')
      })
    }
  }
}

// 未知型号与未登记的仅思考型号不按名称猜开关，也不继承前一节点的自动控制字段。
async function runUnknownModelDefaults(t) {
  const nodes = [
    { ...QWEN, model: 'qwen3.7-max-preview' },
    { ...QWEN, model: 'qwen3.8-2.4t-a95b' },
    { ...QWEN, model: 'MiniMax-M2.5' },
    { ...GLM, model: 'glm-unverified' },
    { ...GLM, model: 'deepseek-unverified' },
    { ...GLM, model: 'kimi-unverified' },
  ]
  for (const node of nodes) {
    await withThinkingApi([GLM], async ({ api, runtime, calls }) => {
      const result = await api.requestChatCompletions(MESSAGES, node, {
        _thinkingManaged: true, _thinkingEnabled: false, enable_thinking: false, thinking: { type: 'disabled' },
      })
      t.checkEqual(node.model + ' default response succeeds', result.content, 'THINKING_OK')
      t.check(node.model + ' default request omits all thinking controls',
        !['enable_thinking', 'thinking', 'reasoning_effort'].some(key => Object.hasOwn(calls[0].body, key)))
      t.checkEqual(node.model + ' runtime shares unknown default', JSON.stringify(runtime.getThinkingArgs(node)), '{}')
    })
  }
}

// 使用新供应商的真实配置解析与聊天入口，覆盖更换域名、路径和本地兼容接口。
async function runProviderPortability(t) {
  const endpoints = ['https://new-source.invalid/openai/v1', 'https://another-source.invalid/v1/', 'http://localhost:4000/v1']
  for (const [index, endpoint] of endpoints.entries()) {
    const node = { ...GLM, provider: `custom-portable${index}`, baseURL: endpoint }
    await withThinkingApi([QWEN, node], async ({ api, calls }) => {
      const chat = require(path.join(AI_ROOT, 'lib/chat'))
      const reply = await chat.callOpenAI(MESSAGES, false)
      t.checkEqual('new provider actual chat produces visible reply', reply, 'THINKING_OK')
      t.checkEqual('new provider uses configured address', calls[1].url, endpoint.replace(/\/+$/, '') + '/chat/completions')
      t.check('new provider keeps model thinking contract', calls[1].body.thinking?.type === 'enabled'
        && calls[1].body.reasoning_effort === 'low' && !Object.hasOwn(calls[1].body, 'enable_thinking'))
      await api.requestChatCompletions(MESSAGES, node, { reasoning_effort: 'high' })
      t.checkEqual('new provider accepts explicit supported reasoning depth', calls.at(-1).body.reasoning_effort, 'high')
      const result = await api.requestChatCompletions(MESSAGES, node, {
        _frozenRoute: api.freezeChatRoute(node, [node]), _structuredOutput: { version: 1, format: 'object' },
      })
      t.check('new provider JSON mode shares thinking policy', JSON.parse(result.content).ok === true
        && calls.at(-1).body.response_format.type === 'json_object' && calls.at(-1).body.reasoning_effort === 'low')
      const reportPath = require.resolve('koishi-plugin-daily-report/lib/report-model')
      const previousReport = require.cache[reportPath]
      delete require.cache[reportPath]
      try {
        const profile = await require(reportPath).createGroundedModelRequest({ configuredNode: { provider: node.provider, model: node.model } })
        const report = await profile.request('classification', 1, 'Return JSON.', '{}', 512, {})
        t.check('new provider real report entry shares model policy', JSON.parse(report).ok === true
          && calls.at(-1).body.thinking?.type === 'enabled' && calls.at(-1).body.reasoning_effort === 'low')
        t.checkEqual('new provider report keeps selected destination', calls.at(-1).url, endpoint.replace(/\/+$/, '') + '/chat/completions')
      } finally {
        if (previousReport) require.cache[reportPath] = previousReport
        else delete require.cache[reportPath]
      }
    })
  }
}

// 单次公共请求跨越 Qwen、GLM、未知节点，验证自动 low 也不会污染后续节点。
async function runCrossProviderIsolation(t) {
  await withThinkingApi([GLM], async ({ api, calls }) => {
    const unknown = { ...GLM, model: 'unknown-model', baseURL: 'https://unverified.invalid/v1' }
    const previousFetch = global.fetch
    global.fetch = async (url, options) => {
      const response = await previousFetch(url, options)
      return JSON.parse(options.body).model === GLM.model ? new Response('{}', { status: 503 }) : response
    }
    try {
      const result = await api.requestChatCompletions(MESSAGES, QWEN, {
        _frozenRoute: api.freezeChatRoute(QWEN, [QWEN, GLM, unknown]), _thinkingEnabled: false,
      })
      t.checkEqual('three-node chain returns final answer', result.content, 'THINKING_OK')
      t.checkEqual('three-node chain reaches every node', calls.length, 3)
      t.check('GLM automatic fields stay local to its node',
        calls[1].body.reasoning_effort === 'low' && !['thinking', 'reasoning_effort', 'enable_thinking'].some(key => Object.hasOwn(calls[2].body, key)))
    } finally { global.fetch = previousFetch }
  })
}

// 公共请求层及实际聊天入口回归；上游 HTTP 被模拟，QQ 和真实模型可用性需另行烟测。
async function run(t) {
  t.section('scenario: shared model thinking policy')
  await runChatFallback(t)
  await runForcedThinkingEntrypoints(t)
  await runOfficialGlmCases(t)
  await runProviderPortability(t)
  await runUnknownModelDefaults(t)
  await runCrossProviderIsolation(t)
}

module.exports = { run }
