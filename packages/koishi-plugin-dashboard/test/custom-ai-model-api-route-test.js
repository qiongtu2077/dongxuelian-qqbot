'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-custom-ai-api-'))
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
const auth = require('../lib/auth')
const routes = require('../lib/routes/ai-model-api').routes

// 调用模型配置路由并解析最小 HTTP 响应。
function callRoute(body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = new PassThrough()
    req.method = 'POST'
    req.url = '/dashboard/api/ai-model-api/discover'
    req.headers = { host: '127.0.0.1:5150', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-admin-token': auth.createAdminToken() }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.connection = req.socket
    const res = { statusCode: 0, body: '', setHeader() {}, writeHead(status) { this.statusCode = status }, end(payload = '') { this.body += String(payload); resolve({ statusCode: this.statusCode, body: JSON.parse(this.body) }) } }
    try {
      routes['POST /dashboard/api/ai-model-api/discover'](req, res, req.url, new URL(`http://${req.headers.host}${req.url}`))
      req.end(text)
    } catch (error) { reject(error) }
  })
}

// 验证新建供应商生成稳定标识、Key 文件名和完整模型列表。
async function testCreateAndUpdate() {
  let responseCount = 0
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: responseCount++ ? [{ id: 'shared-model' }, { id: 'vision-only' }] : [{ id: 'shared-model' }, { id: 'text-only' }] }) })
  const created = await callRoute({ providerId: 'custom-new', capability: 'text', name: '测试中转', note: '本地', baseURL: 'http://localhost:9988', apiKey: 'sk-create-secret' })
  assert.strictEqual(created.statusCode, 200)
  assert.match(created.body.providerId, /^custom-[a-z0-9]{24}$/)
  assert.strictEqual(created.body.config.providers[created.body.providerId].models.length, 2)
  assert(!JSON.stringify(created.body).includes('sk-create-secret'))
  const customFile = path.join(dataDir, 'ai-providers-custom.json')
  const custom = JSON.parse(fs.readFileSync(customFile, 'utf8'))[0]
  assert.match(custom.keyFile, /^ai-custom-[a-z0-9]{24}-key\.txt$/)
  assert.strictEqual(fs.readFileSync(path.join(dataDir, custom.keyFile), 'utf8'), 'sk-create-secret')

  const updated = await callRoute({ providerId: created.body.providerId, capability: 'vision', name: '测试中转更新', note: '', baseURL: 'http://localhost:9989', apiKey: 'sk-update-secret' })
  assert.strictEqual(updated.statusCode, 200)
  const models = updated.body.config.providers[created.body.providerId].models
  assert.deepStrictEqual(models.find(item => item.id === 'shared-model').capabilities.sort(), ['text', 'vision'])
  assert.strictEqual(models.some(item => item.id === 'text-only'), false)
  assert.strictEqual(JSON.parse(fs.readFileSync(customFile, 'utf8'))[0].name, '测试中转更新')
}

// 验证空模型数组不会覆盖既有配置或 Key。
async function testEmptyIsNoop() {
  const beforeConfig = fs.readFileSync(path.join(dataDir, 'ai-capability-config.json'))
  const custom = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-providers-custom.json',), 'utf8'))[0]
  const keyPath = path.join(dataDir, custom.keyFile)
  const beforeKey = fs.readFileSync(keyPath)
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [] }) })
  const result = await callRoute({ providerId: custom.id, capability: 'text', name: custom.name, baseURL: custom.baseURL, apiKey: 'sk-empty-secret' })
  assert.strictEqual(result.statusCode, 422)
  assert.strictEqual(result.body.code, 'DISCOVERY_EMPTY')
  assert.deepStrictEqual(fs.readFileSync(path.join(dataDir, 'ai-capability-config.json')), beforeConfig)
  assert.deepStrictEqual(fs.readFileSync(keyPath), beforeKey)
  assert(!JSON.stringify(result.body).includes('sk-empty-secret'))
}

// 顺序执行路由专项测试并清理临时目录。
async function main() {
  try {
    await testCreateAndUpdate()
    await testEmptyIsNoop()
    console.log('custom ai-model-api route tests: OK')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
