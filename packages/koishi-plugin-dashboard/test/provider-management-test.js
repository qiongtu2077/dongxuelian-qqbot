'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-management-'))
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
const auth = require('../lib/auth')
const { routes } = require('../lib/routes/ai-model-api')
const configFile = path.join(dataDir, 'ai-capability-config.json')
const capabilities = ['text', 'vision', 'voice-asr', 'voice-tts']
const secret = 'sk-management-private-secret'
let providerId, keyFile, maxActive = 0, active = 0

// 通过真实路由收集请求体，保留鉴权边界和事务写入行为。
function call(method, endpoint, body, authorized = true) {
  return new Promise(resolve => {
    const req = new PassThrough()
    req.method = method; req.url = '/dashboard/api/ai-model-api/' + endpoint
    req.headers = { host: '127.0.0.1:5150', 'content-type': 'application/json', 'x-admin-token': authorized ? auth.createAdminToken() : '', 'sec-fetch-site': authorized ? 'same-origin' : 'cross-site' }
    req.socket = { remoteAddress: '127.0.0.1' }; req.connection = req.socket
    const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status }, end(text) { resolve({ status: this.statusCode, text, data: JSON.parse(text) }) } }
    routes[method + ' ' + req.url](req, res, req.url, new URL('http://127.0.0.1:5150' + req.url))
    req.end(JSON.stringify(body))
  })
}

// 只返回协议明确的成功或失败响应，验证探测不按模型名称猜测能力。
async function mockFetch(url, init) {
  assert.equal(init.headers.Authorization, 'Bearer ' + secret)
  if (init.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'opaque-one' }, { id: 'opaque-two' }] }))
  active++; maxActive = Math.max(active, maxActive)
  await new Promise(resolve => setTimeout(resolve, 5)); active--
  const model = init.body instanceof FormData ? init.body.get('model') : JSON.parse(init.body).model
  if (String(url).endsWith('/chat/completions') && model === 'opaque-one') return new Response(JSON.stringify({ choices: [{ message: { content: '红色' } }] }))
  if (String(url).endsWith('/audio/transcriptions') && model === 'opaque-two') { assert(init.body.get('file').size > 44); return new Response(JSON.stringify({ text: '' })) }
  if (String(url).endsWith('/audio/speech') && model === 'opaque-two') return new Response(Buffer.from('RIFF1234WAVE-test-audio'), { headers: { 'content-type': 'audio/wav' } })
  return new Response('{}', { status: 404 })
}

// 验证统一导入、四能力自动检测、复用 Key 和更改地址后的密钥隔离。
async function testImportDetectReuse() {
  global.fetch = mockFetch
  const created = await call('POST', 'discover', { providerId: 'custom-new', name: '不透明模型供应商', baseURL: 'http://localhost:9989/v1', apiKey: secret, detectCapabilities: true })
  assert.equal(created.status, 200, created.text); providerId = created.data.providerId
  const custom = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-providers-custom.json')))[0]; keyFile = path.join(dataDir, custom.keyFile)
  assert.equal(fs.readFileSync(keyFile, 'utf8'), secret)
  assert(created.data.config.providers[providerId].models.every(model => model.capabilities.length === 0))
  assert(!created.text.includes(secret))
  for (const modelId of ['opaque-one', 'opaque-two']) {
    const detected = await call('POST', 'detect', { providerId, modelId })
    assert.equal(detected.status, 200, detected.text); assert(!detected.text.includes(secret))
  }
  assert(maxActive <= 2, 'global probe concurrency exceeded limit')
  const models = JSON.parse(fs.readFileSync(configFile)).providers[providerId].models
  assert.deepEqual(models[0].capabilities, ['text', 'vision'])
  assert.deepEqual(models[1].capabilities, ['voice-asr', 'voice-tts'])
  for (const capability of capabilities) {
    const result = await call('PUT', 'priority', { capability, steps: [{ provider: providerId, model: capability.startsWith('voice') ? 'opaque-two' : 'opaque-one' }] })
    assert.equal(result.status, 200, result.text)
  }
  const refreshed = await call('POST', 'discover', { providerId, detectCapabilities: true })
  assert.equal(refreshed.status, 200, refreshed.text)
  assert.deepEqual(refreshed.data.config.providers[providerId].models, models)
  const before = fs.readFileSync(configFile)
  const moved = await call('POST', 'discover', { providerId, baseURL: 'http://localhost:9990/v1', detectCapabilities: true })
  assert.equal(moved.status, 400); assert(moved.data.message.includes('重新输入'))
  assert.deepEqual(fs.readFileSync(configFile), before)
}

// 验证限流、网络错误和成功但无有效结果不会错判为不支持或清空已有链。
async function testPendingAndAuth() {
  for (const endpoint of ['detect', 'key']) {
    const denied = await call(endpoint === 'detect' ? 'POST' : 'DELETE', endpoint, { providerId, modelId: 'opaque-one' }, false)
    assert.equal(denied.status, 403)
  }
  const before = JSON.parse(fs.readFileSync(configFile)).priorities
  global.fetch = async () => new Response('{}', { status: 429 })
  const limited = await call('POST', 'detect', { providerId, modelId: 'opaque-one' })
  assert.equal(limited.status, 200, limited.text)
  const model = limited.data.config.providers[providerId].models[0]
  assert(capabilities.every(capability => model.capabilityChecks[capability].status === 'pending'))
  assert.deepEqual(limited.data.config.priorities, before)
  const { inspectResponse } = require('../lib/model-capability-probe')
  assert.equal((await inspectResponse(new Response('{}'), 'text')).status, 'pending')
  assert.equal((await inspectResponse(new Response('{"error":"fake audio"}', { headers: { 'content-type': 'audio/wav' } }), 'voice-tts')).status, 'pending')
  assert.equal((await inspectResponse(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })), 'vision')).status, 'pending')
  for (const status of [401, 403, 429, 500]) assert.equal((await inspectResponse(new Response('{}', { status }), 'voice-tts')).status, 'pending')
  const missing = await call('POST', 'detect', { providerId, modelId: 'not-in-pool' }); assert.equal(missing.status, 400)
}

// 验证删除事务失败会恢复 Key 与引用；成功则四能力清空而保留历史文件。
async function testDeleteAndRollback() {
  const usageFile = path.join(dataDir, 'token-usage.json'); fs.writeFileSync(usageFile, '{"history":"retain"}')
  const configBefore = fs.readFileSync(configFile), keyBefore = fs.readFileSync(keyFile), rename = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => { if (to === keyFile && !injected) { injected = true; throw new Error('injected replace failure') } return rename(from, to) }
  try { const failed = await call('DELETE', 'key', { providerId }); assert.equal(failed.status, 400); assert.equal(failed.data.code, 'API_CONFIG_TRANSACTION_FAILED') }
  finally { fs.renameSync = rename }
  assert.deepEqual(fs.readFileSync(configFile), configBefore); assert.deepEqual(fs.readFileSync(keyFile), keyBefore)
  const deleted = await call('DELETE', 'key', { providerId }); assert.equal(deleted.status, 200, deleted.text)
  assert.equal(fs.readFileSync(keyFile, 'utf8'), '')
  assert.equal(deleted.data.config.providers[providerId].key.configured, false)
  assert.equal(deleted.data.config.providers[providerId].models.length, 0)
  assert(capabilities.every(capability => deleted.data.config.priorities[capability].length === 0))
  assert.equal(fs.readFileSync(usageFile, 'utf8'), '{"history":"retain"}')
  const detect = await call('POST', 'detect', { providerId, modelId: 'opaque-one' }); assert.equal(detect.status, 400)
  assert(!deleted.text.includes(secret))
}

// 顺序运行隔离场景并恢复全局网络桩，任何失败均清理测试目录。
async function main() {
  const original = global.fetch
  try { await testImportDetectReuse(); await testPendingAndAuth(); await testDeleteAndRollback(); console.log('provider management tests: OK') }
  finally { global.fetch = original; fs.rmSync(dataDir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
