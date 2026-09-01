'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ai-model-api-'))
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir

const auth = require('../lib/auth')
const aiModelApiRoutes = require('../lib/routes/ai-model-api')
const { createCapabilityConfig } = require('../../koishi-plugin-dongxuelian-ai/test/helpers/ai-capability-fixture')

const configFile = path.join(dataDir, 'ai-capability-config.json')
const openAiKeyFile = path.join(dataDir, 'ai-openai-official-key.txt')
const expectedProviders = ['anthropic', 'dashscope', 'deepseek', 'gemini', 'glm', 'mimorium', 'openai', 'opencode']

// 构造能够捕获状态码、响应头和正文的最小 HTTP 响应。
function makeResponse(resolve) {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(body = '') {
      this.body += String(body || '')
      resolve(this)
    },
  }
}

// 直接调用统一 AI 路由并等待异步 collectBody 处理完毕。
function callRoute(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const routePath = pathname.split('?')[0]
    const handler = aiModelApiRoutes.routes[`${method} ${routePath}`]
    if (!handler) return reject(new Error(`route not found: ${method} ${routePath}`))
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = new PassThrough()
    req.method = method
    req.url = pathname
    req.headers = {
      host: '127.0.0.1:5150',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'x-admin-token': auth.createAdminToken(),
    }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.connection = req.socket
    const res = makeResponse(resolve)
    try {
      handler(req, res, routePath, new URL(`http://127.0.0.1:5150${pathname}`))
      req.end(text)
    } catch (error) {
      reject(error)
    }
  })
}

// 解析路由 JSON，并在格式错误时保留原始正文便于定位。
function parseResponse(res) {
  try {
    return JSON.parse(res.body || '{}')
  } catch (error) {
    throw new Error(`invalid response JSON: ${res.body}; ${error.message}`)
  }
}

// 写入一份规范四能力配置供后续路由事务使用。
function writeConfig(priorities) {
  fs.writeFileSync(configFile, JSON.stringify(createCapabilityConfig(priorities)), 'utf8')
}

// 验证目录固定为八家且 GET 只返回脱敏配置。
async function testCatalogAndMaskedConfig() {
  const response = await callRoute('GET', '/dashboard/api/ai-model-api/config')
  assert.strictEqual(response.statusCode, 200)
  const payload = parseResponse(response)
  assert.strictEqual(payload.ok, true)
  assert.deepStrictEqual(payload.catalog.map(item => item.id).sort(), expectedProviders)
  assert.deepStrictEqual(payload.config.capabilities, ['text', 'vision', 'voice-asr', 'voice-tts'])
  assert.strictEqual(fs.existsSync(configFile), true, 'first GET should persist the idempotent migration result')
  assert(!JSON.stringify(payload).includes('keyFile'))
  assert(!JSON.stringify(payload).includes('baseURL'))
}

// 建立会同时触发模型池替换和跨能力悬空引用清理的旧状态。
function seedDiscoveryState() {
  writeConfig({
    text: [
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
    ],
    vision: [{ provider: 'openai', model: 'gpt-4o' }],
    'voice-asr': [{ provider: 'mimorium', model: 'mimo-v2.5-asr' }],
    'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
  })
  fs.writeFileSync(openAiKeyFile, 'sk-route-old-secret', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'ai-deepseek-key.txt'), 'sk-route-deepseek', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'ai-mimorium-key.txt'), 'sk-route-mimorium', 'utf8')
}

// 验证有效 Key 但无可导入模型时旧 Key、模型池和优先级均不落盘变化。
async function testEmptyDiscoveryDoesNotPersist() {
  seedDiscoveryState()
  const beforeConfig = fs.readFileSync(configFile)
  const beforeKey = fs.readFileSync(openAiKeyFile)
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'unverified-model' }] }) })
  const response = await callRoute('POST', '/dashboard/api/ai-model-api/discover', {
    providerId: 'openai',
    apiKey: 'sk-route-rejected-secret',
  })
  assert.strictEqual(response.statusCode, 422)
  const payload = parseResponse(response)
  assert.strictEqual(payload.code, 'DISCOVERY_EMPTY')
  assert.strictEqual(payload.message, '该密钥未返回可导入模型')
  assert.deepStrictEqual(fs.readFileSync(configFile), beforeConfig)
  assert.deepStrictEqual(fs.readFileSync(openAiKeyFile), beforeKey)
  assert(!JSON.stringify(payload).includes('sk-route-rejected-secret'))
}

// 验证发现成功会原子保存新 Key、唯一模型池并清理两条悬空优先级。
async function testSuccessfulDiscoveryAndPriorityIsolation() {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }) })
  const response = await callRoute('POST', '/dashboard/api/ai-model-api/discover', {
    providerId: 'openai',
    apiKey: 'sk-route-new-secret',
  })
  assert.strictEqual(response.statusCode, 200)
  const payload = parseResponse(response)
  assert.strictEqual(payload.ok, true)
  assert.strictEqual(payload.removedModels, 1)
  assert.strictEqual(payload.removedSteps, 2)
  assert.strictEqual(fs.readFileSync(openAiKeyFile, 'utf8'), 'sk-route-new-secret')
  assert.deepStrictEqual(payload.config.providers.openai.models.map(model => model.id), ['gpt-4o-mini'])
  assert.deepStrictEqual(payload.config.priorities.text, [{ provider: 'deepseek', model: 'deepseek-v4-flash' }])
  assert.deepStrictEqual(payload.config.priorities.vision, [])
  assert(!JSON.stringify(payload).includes('sk-route-new-secret'))

  const before = JSON.parse(fs.readFileSync(configFile, 'utf8')).priorities
  const priorityResponse = await callRoute('PUT', '/dashboard/api/ai-model-api/priority', {
    capability: 'text',
    steps: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  })
  assert.strictEqual(priorityResponse.statusCode, 200)
  const priorityPayload = parseResponse(priorityResponse)
  assert.deepStrictEqual(priorityPayload.config.priorities.text, [{ provider: 'openai', model: 'gpt-4o-mini' }])
  for (const capability of ['vision', 'voice-asr', 'voice-tts']) {
    assert.deepStrictEqual(priorityPayload.config.priorities[capability], before[capability], `${capability} changed while saving text`)
  }
}

// 写入能力隔离用量，包含一条必须被忽略的无能力历史记录。
function seedUsage() {
  fs.writeFileSync(path.join(dataDir, 'token-usage.json'), JSON.stringify({
    '2026-08-31': { total: 999, providers: { legacy: { total: 999, requests: 1 } } },
    '2026-09-01': {
      capabilities: {
        text: {
          total: 12, requests: 2, input: 7, output: 5, readableRequests: 2, unreadableRequests: 0,
          providers: { openai: { total: 12, requests: 2, readableRequests: 2 } },
          models: { 'openai/gpt-4o-mini': { provider: 'openai', total: 12, requests: 2, readableRequests: 2 } },
        },
        vision: {
          total: 7, requests: 1, input: 4, output: 3, readableRequests: 1, unreadableRequests: 0,
          providers: { gemini: { total: 7, requests: 1, readableRequests: 1 } },
          models: { 'gemini/gemini-3.7-flash': { provider: 'gemini', total: 7, requests: 1, readableRequests: 1 } },
        },
        'voice-asr': {
          total: 0, requests: 1, readableRequests: 0, unreadableRequests: 1,
          providers: { mimorium: { total: 0, requests: 1, unreadableRequests: 1 } },
          models: { 'mimorium/mimo-v2.5-asr': { provider: 'mimorium', total: 0, requests: 1, unreadableRequests: 1 } },
        },
      },
    },
  }), 'utf8')
}

// 验证每项能力只读取自身数据，无 Token 的语音请求返回不可读状态。
async function testCapabilityUsageIsolation() {
  seedUsage()
  const text = parseResponse(await callRoute('GET', '/dashboard/api/keys/usage?capability=text'))
  const vision = parseResponse(await callRoute('GET', '/dashboard/api/keys/usage?capability=vision'))
  const asr = parseResponse(await callRoute('GET', '/dashboard/api/keys/usage?capability=voice-asr'))
  assert.strictEqual(text.days.length, 1)
  assert.strictEqual(text.days[0].date, '2026-09-01')
  assert.strictEqual(text.days[0].total, 12)
  assert.deepStrictEqual(text.providers.map(item => item.key), ['openai'])
  assert.strictEqual(text.readable, true)
  assert.strictEqual(text.unavailable, false)
  assert.strictEqual(vision.days[0].total, 7)
  assert.deepStrictEqual(vision.providers.map(item => item.key), ['gemini'])
  assert.strictEqual(asr.readable, false)
  assert.strictEqual(asr.unavailable, true)
  assert.strictEqual(asr.days[0].unreadableRequests, 1)

  const invalid = await callRoute('GET', '/dashboard/api/keys/usage?capability=legacy')
  assert.strictEqual(invalid.statusCode, 400)
  assert.strictEqual(parseResponse(invalid).message, '未知能力')
}

// 顺序执行路由集成场景并始终清理临时目录。
async function main() {
  try {
    await testCatalogAndMaskedConfig()
    await testEmptyDiscoveryDoesNotPersist()
    await testSuccessfulDiscoveryAndPriorityIsolation()
    await testCapabilityUsageIsolation()
    console.log('ai-model-api route tests: OK')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
