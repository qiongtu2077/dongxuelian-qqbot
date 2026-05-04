/**
 * MODULE: API 健康检查。
 * 职责: 依次测试各已配置供应商的连通性，返回状态报告。
 * 边界: 不修改 conversation，不修改运行时配置。只读探测。
 */
const { PROVIDERS } = require('./constants')
const { loadConfig } = require('./runtime-config')
const { requestChatCompletions } = require('./api')

const HEALTH_CACHE_TTL = 60000
const PROBE_TIMEOUT = 5000
let healthCache = null
let healthCacheTs = 0

function buildProbeConfig(providerId, baseURL, model, apiKey) {
  return {
    provider: providerId,
    baseURL: baseURL.replace(/\/+$/, ''),
    model: model || Object.values(PROVIDERS).flatMap(p => p.models)[0]?.id || 'gpt-4o-mini',
    apiKey,
    searchEnabled: false,
  }
}

async function testProvider(providerId, providerDef, allKeys) {
  const keyField = providerId === 'deepseek' ? allKeys.deepseekKey
    : providerId === 'dashscope' ? allKeys.dashscopeKey
    : providerId === 'glm' ? allKeys.glmKey
    : providerId === 'mimorium' ? allKeys.mimoriumKey
    : allKeys.defaultKey

  if (!keyField || !keyField.trim()) {
    return { provider: providerDef?.name || providerId, status: 'skip', reason: 'key文件为空', latency: 0 }
  }

  const model = providerDef?.models[0]?.id
  if (!model) {
    return { provider: providerDef?.name || providerId, status: 'skip', reason: '无可用模型', latency: 0 }
  }

  const probeConfig = buildProbeConfig(providerId, providerDef.baseURL, model, keyField.trim())
  const start = Date.now()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
    const result = await requestChatCompletions(
      [{ role: 'user', content: 'hi' }],
      probeConfig,
      { max_tokens: 1, signal: controller.signal }
    )
    clearTimeout(timer)
    const latency = Date.now() - start
    if (result) {
      return { provider: providerDef.name, status: 'ok', latency }
    }
    return { provider: providerDef.name, status: 'fail', reason: '无返回值', latency }
  } catch (err) {
    const latency = Date.now() - start
    const msg = String(err.message || err)
    if (msg.includes('abort') || msg.includes('timeout')) {
      return { provider: providerDef.name, status: 'fail', reason: '超时', latency }
    }
    if (msg.includes('401')) return { provider: providerDef.name, status: 'fail', reason: '401 认证失败', latency }
    if (msg.includes('429')) return { provider: providerDef.name, status: 'fail', reason: '429 限流', latency }
    if (msg.includes('40')) return { provider: providerDef.name, status: 'fail', reason: `${msg.slice(0, 30)}`, latency }
    return { provider: providerDef.name, status: 'fail', reason: msg.slice(0, 40), latency }
  }
}

async function runHealthCheck(force = false) {
  const now = Date.now()
  if (!force && healthCache && now - healthCacheTs < HEALTH_CACHE_TTL) {
    return healthCache
  }

  const config = await loadConfig()
  const defaultKey = config.apiKey

  const deepseekKey = ''
  const dashscopeKey = ''
  const glmKey = ''
  const mimoriumKey = ''

  const results = []
  for (const [providerId, providerDef] of Object.entries(PROVIDERS)) {
    const r = await testProvider(providerId, providerDef, { defaultKey, deepseekKey, dashscopeKey, glmKey, mimoriumKey })
    results.push(r)
  }

  const report = {
    ts: now,
    activeProvider: config.provider,
    activeModel: config.model,
    results,
  }

  healthCache = report
  healthCacheTs = now
  return report
}

function formatHealthReport(report) {
  const lines = ['AI诊断', '─────────────────']
  for (const r of report.results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏸' : '❌'
    const detail = r.status === 'ok' ? `${r.latency}ms` : r.reason
    lines.push(`  ${icon} ${r.provider}　${detail}`)
  }
  lines.push('─────────────────')
  lines.push(`当前在用：${report.activeProvider} / ${report.activeModel}`)
  return lines.join('\n')
}

function resetHealthCache() {
  healthCache = null
  healthCacheTs = 0
}

module.exports = {
  runHealthCheck,
  formatHealthReport,
  resetHealthCache,
}
