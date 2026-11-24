'use strict'

const assert = require('assert')
const discovery = require('../lib/core/model-discovery')

// 验证自定义地址候选、完整地址和版本段拼接规则。
function testUrlCandidates() {
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test'), ['https://example.test/v1/models', 'https://example.test/models'])
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test/v2/'), ['https://example.test/v2/models'])
  assert.deepStrictEqual(discovery.buildCustomDiscoveryUrls('https://example.test/api/models?x=1'), ['https://example.test/api/models?x=1'])
}

// 验证公网 HTTP 可用，私网、URL 凭据和非 HTTP 协议仍在请求前被拒绝。
async function testUrlSecurity() {
  const publicURL = await discovery.validateCustomDiscoveryUrl('http://121.40.181.95:3000/v1/models')
  assert.strictEqual(publicURL.toString(), 'http://121.40.181.95:3000/v1/models')
  await discovery.validateCustomDiscoveryUrl('http://relay.example/v1/models', async () => [{ address: '121.40.181.95', family: 4 }])
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('http://10.0.0.1'), error => error.code === 'DISCOVERY_SSRF_BLOCKED')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('http://169.254.169.254'), error => error.code === 'DISCOVERY_SSRF_BLOCKED')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('http://private.example', async () => [{ address: '192.168.1.5', family: 4 }]), error => error.code === 'DISCOVERY_SSRF_BLOCKED')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('ftp://relay.example'), error => error.code === 'DISCOVERY_URL_INVALID')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('https://user:pass@example.test'), error => error.code === 'DISCOVERY_URL_INVALID')
  await assert.rejects(() => discovery.validateCustomDiscoveryUrl('https://private.example', async () => [{ address: '192.168.1.5', family: 4 }]), error => error.code === 'DISCOVERY_SSRF_BLOCKED')
  await discovery.validateCustomDiscoveryUrl('http://127.0.0.1:9000', async () => [{ address: '127.0.0.1', family: 4 }])
}

// 验证候选回退、Bearer 认证、顺序去重和当前能力标签。
async function testDiscovery() {
  const requests = []
  const result = await discovery.discoverCustomProviderModels('http://121.40.181.95:3000', 'vision', 'sk-custom-secret', {
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/v1/models')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b' }] }) }
    },
  })
  assert.deepStrictEqual(requests.map(item => item.url), ['http://121.40.181.95:3000/v1/models', 'http://121.40.181.95:3000/models'])
  assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer sk-custom-secret')
  assert.deepStrictEqual(result.map(model => model.id), ['model-a', 'model-b'])
  assert.deepStrictEqual(result[0].capabilities, ['vision'])
  assert(!JSON.stringify(result).includes('sk-custom-secret'))
}

// 验证公网 HTTP 重定向仍不能访问私网，且不会向被拒绝的目标发送 Key。
async function testHttpRedirectSecurity() {
  const requests = []
  await assert.rejects(() => discovery.discoverCustomProviderModels('http://121.40.181.95:3000/v1', 'text', 'sk-redirect-secret', {
    fetchImpl: async (url) => {
      requests.push(url)
      return { ok: false, status: 302, headers: { get: () => 'http://169.254.169.254/latest/meta-data/' } }
    },
  }), error => error.code === 'DISCOVERY_SSRF_BLOCKED' && !error.message.includes('sk-redirect-secret'))
  assert.deepStrictEqual(requests, ['http://121.40.181.95:3000/v1/models'])
}

// 验证上游鉴权错误不回显密钥或原始敏感正文。
async function testSanitizedErrors() {
  await assert.rejects(() => discovery.discoverCustomProviderModels('http://localhost:9000', 'text', 'sk-secret', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'upstream-secret-body' }) }),
  }), error => error.code === 'DISCOVERY_AUTH_FAILED' && !error.message.includes('sk-secret') && !error.message.includes('upstream-secret-body'))
}

// 验证独立加载运行时主模块、状态探针或资源 worker 时同样生效，不依赖先加载模型发现模块。
function testRuntimeEntrypointsConnectTimeout() {
  const { spawnSync } = require('node:child_process')
  const path = require('node:path')
  const pkgRoot = path.resolve(__dirname, '..')
  for (const entry of ['lib/core/api.js', 'lib/diagnostics/model-connectivity.js', 'lib/resource-workers/worker-main.js', 'lib/index.js']) {
    const script = [
      'const net = require("node:net");',
      'const path = require("node:path");',
      'require(path.resolve(process.argv[1], process.argv[2]));',
      'const loadedDiscovery = Object.keys(require.cache).some(k => k.endsWith("model-discovery.js"));',
      'process.stdout.write(JSON.stringify({ timeout: net.getDefaultAutoSelectFamilyAttemptTimeout(), loadedDiscovery }));',
    ].join('')
    const res = spawnSync(process.execPath, ['-e', script, pkgRoot, entry], { encoding: 'utf8', timeout: 15000 })
    assert.strictEqual(res.status, 0, `${entry} 加载失败: ${res.stderr || res.stdout}`)
    const parsed = JSON.parse(res.stdout.trim())
    assert.strictEqual(parsed.timeout, 2000, `${entry} 应将单 IP 连接超时设为 2000ms`)
    assert.strictEqual(parsed.loadedDiscovery, false, `${entry} 不应依赖加载 model-discovery`)
  }
}

// 顺序执行模型发现测试并输出稳定结果。
async function main() {
  assert.strictEqual(require('node:net').getDefaultAutoSelectFamilyAttemptTimeout(), 2000, '模型请求应给每个 IP 两秒连接时间')
  testRuntimeEntrypointsConnectTimeout()
  testUrlCandidates()
  await testUrlSecurity()
  await testDiscovery()
  await testHttpRedirectSecurity()
  await testSanitizedErrors()
  console.log('custom model discovery tests: OK')
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
