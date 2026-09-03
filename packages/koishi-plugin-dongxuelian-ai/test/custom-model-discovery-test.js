'use strict'

const assert = require('assert')
const discovery = require('../lib/core/model-discovery')

// 验证自定义地址候选、完整地址和版本段拼接规则。
function testUrlCandidates() {
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test'), ['https://example.test/v1/models', 'https://example.test/models'])
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test/v2/'), ['https://example.test/v2/models'])
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test/api/models?x=1'), ['https://example.test/api/models?x=1'])
}

// 验证私网、凭据和不安全 HTTP 地址在发请求前被拒绝。
async function testUrlSecurity() {
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('http://10.0.0.1'), error => error.code === 'DISCOVERY_URL_INSECURE')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('https://user:pass@example.test'), error => error.code === 'DISCOVERY_URL_INVALID')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('https://private.example', async () => [{ address: '192.168.1.5', family: 4 }]), error => error.code === 'DISCOVERY_SSRF_BLOCKED')
  await discovery.validateCustomDiscoveryUrl('http://127.0.0.1:9000', async () => [{ address: '127.0.0.1', family: 4 }])
}

// 验证候选回退、Bearer 认证、顺序去重和当前能力标签。
async function testDiscovery() {
  const requests = []
  const result = await discovery.discoverCustomProviderModels('http://localhost:9000', 'vision', 'sk-custom-secret', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/v1/models')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b' }] }) }
    },
  })
  assert.deepStrictEqual(requests.map(item => item.url), ['http://localhost:9000/v1/models', 'http://localhost:9000/models'])
  assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer sk-custom-secret')
  assert.deepStrictEqual(result.map(model => model.id), ['model-a', 'model-b'])
  assert.deepStrictEqual(result[0].capabilities, ['vision'])
  assert(!JSON.stringify(result).includes('sk-custom-secret'))
}

// 验证上游鉴权错误不回显密钥或原始敏感正文。
async function testSanitizedErrors() {
  await assert.rejects(() => discovery.discoverCustomProviderModels('http://localhost:9000', 'text', 'sk-secret', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'upstream-secret-body' }) }),
  }), error => error.code === 'DISCOVERY_AUTH_FAILED' && !error.message.includes('sk-secret') && !error.message.includes('upstream-secret-body'))
}

// 顺序执行模型发现测试并输出稳定结果。
async function main() {
  testUrlCandidates()
  await testUrlSecurity()
  await testDiscovery()
  await testSanitizedErrors()
  console.log('custom model discovery tests: OK')
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
