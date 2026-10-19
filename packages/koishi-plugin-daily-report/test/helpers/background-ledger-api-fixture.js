/** 隔离数据根的真实公共模型请求测试；模型fetch替身、通知关闭，不加载实际配置。 */
'use strict'
const assert = require('assert').strict, fs = require('fs')
process.env.DONGXUELIAN_AI_DATA_DIR = process.argv[2]
require('koishi-plugin-dongxuelian-ai/lib/core/capability-failure-notifier').notifyCapabilityStepFailure = async () => false
const api = require('koishi-plugin-dongxuelian-ai/lib/core/api')
const { PagedReportStore } = require('../../lib/report-storage')
const { ReportBackgroundLedger, provisionReportBackgroundLedger } = require('../../lib/report-background-ledger')
const { reportCacheDigest: digest } = require('../../lib/report-cache-provenance')

// 生产请求回调与HTTP提交保持真实顺序，预留失败不能触发内部主备切换。
async function main() {
  const now = Date.parse('2026-10-06T12:00:00+08:00'), store = new PagedReportStore({ taskId: 'isolated-public-api', channelKey: 'test-group',
    deadlineMs: now + 90000, now: () => now, assertActive() {}, assertLease() {} })
  provisionReportBackgroundLedger(store)
  const config = { apiKey: 'fake-isolated-key', provider: 'test-ledger', capability: 'text', model: 'fixture-model',
    baseURL: 'https://example.invalid/v1', chatProtocol: 'openai-chat', searchEnabled: false }
  const route = api.freezeChatRoute(config, [config]), node = { routeIdentity: route.identity, routeRevision: route.routeRevision,
    provider: config.provider, model: config.model, protocol: config.chatProtocol }
  const ledger = new ReportBackgroundLedger({ store, startedAtMs: now, unitIdentity: digest('unit'), policy: { identity: digest('policy'), first: node, recovery: node }, hasForegroundPending: () => false })
  const originalFetch = global.fetch, rename = fs.renameSync
  let fetchCalls = 0, reservedBeforeFetch = false, reservation
  global.fetch = async () => {
    fetchCalls++; reservedBeforeFetch = ledger.snapshot().groupUsed === 1
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"completed":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await api.requestChatCompletions([{ role: 'user', content: '虚构材料' }], config, { _frozenRoute: route, _timeoutMs: 45000,
      _onRequestAttempt(step) { reservation = ledger.reserve(1, digest('request-1'), step) },
      _onRequestExecution(execution) { ledger.settle(reservation, 'returned', execution.usage) } })
    assert(reservedBeforeFetch)
    fs.renameSync = (from, to) => { if (String(to).endsWith('day-2026-10-06.json')) throw new Error('模拟预留写入失败'); return rename(from, to) }
    await assert.rejects(api.requestChatCompletions([{ role: 'user', content: '虚构恢复材料' }], config, { _frozenRoute: route, _timeoutMs: 45000,
      _onRequestAttempt(step) { ledger.reserve(2, digest('request-2'), step) } }), /模拟预留写入失败/)
    assert.equal(fetchCalls, 1)
  } finally { fs.renameSync = rename; global.fetch = originalFetch; api.flushTokenUsage() }
  let facts
  global.fetch = async () => new Response('{"error":{"message":"not-retained-private-body"}}', { status: 403 })
  try {
    await assert.rejects(api.requestChatCompletions([{ role: 'user', content: '虚构失败材料' }], config, { _frozenRoute: route, _timeoutMs: 45000 }), error => {
      facts = api.getChatFailureMetadata(error)
      assert.deepEqual(facts, { code: 'HTTP_403', status: 403, retryable: true }); assert(!error.message.includes('not-retained-private-body'))
      return true
    })
    assert.equal(api.getChatFailureMetadata(Object.assign(new Error('假冒HTTP 403'), facts)), null)
  } finally { global.fetch = originalFetch; api.flushTokenUsage() }
  console.log(JSON.stringify({ fetchCalls, reservedBeforeFetch, persistedRequests: ledger.snapshot().globalUsed, facts }))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
