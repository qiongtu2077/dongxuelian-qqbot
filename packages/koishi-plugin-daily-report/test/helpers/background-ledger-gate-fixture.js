/** 隔离数据根的真实S0租约与多进程计额；不加载模型或调用网络。 */
'use strict'
const assert = require('assert').strict
process.env.DONGXUELIAN_AI_DATA_DIR = process.argv[2]
const { acquireResourceGate, getResourceGateStatus } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const { PagedReportStore } = require('../../lib/report-storage')
const { ReportBackgroundLedger, provisionReportBackgroundLedger } = require('../../lib/report-background-ledger')
const { reportCacheDigest: digest } = require('../../lib/report-cache-provenance')

// 每个进程读取真实ticket/owner证明租约，控制文件更新使用同一原S0，不加新锁。
async function main() {
  const mode = process.argv[3]
  if (!['initialize', 'worker-A', 'worker-B', 'inspect'].includes(mode)) throw new Error('未知S0固定场景')
  const taskId = 'ledger-gate-' + mode, channelKey = mode === 'worker-B' ? 'group-B' : 'group-A'
  const gate = await acquireResourceGate({ taskId, channelKey, kind: 'diagnostic_probe', owner: 'background-ledger-test', priority: 98,
    timeoutMs: 90000, waitTimeoutMs: 15000, pollMs: 20 })
  const startedAtMs = Date.now()
  const store = new PagedReportStore({ taskId, channelKey, deadlineMs: startedAtMs + 90000, assertActive() {}, assertLease() {
    const status = getResourceGateStatus()
    assert(status.locked && status.meta.ticketId === gate.ticketId && status.meta.taskId === taskId && status.meta.pid === process.pid, 'S0租约已失效')
  } })
  try {
    if (mode === 'initialize') { provisionReportBackgroundLedger(store); console.log(JSON.stringify({ initialized: true })); return }
    const node = { provider: 'test', model: 'fixture', protocol: 'openai-chat', routeIdentity: digest('gate-route'), routeRevision: digest('gate-revision') }
    const policy = { identity: digest('gate-policy'), first: node, recovery: node }
    const ledger = new ReportBackgroundLedger({ store, startedAtMs, unitIdentity: digest('unit-' + taskId), policy, hasForegroundPending: () => false })
    if (mode !== 'inspect') {
      // 两进程同时争取S0，让第二个进入真实等待；预留时始终只有当前owner写账。
      await new Promise(resolve => setTimeout(resolve, 50))
      const reservation = ledger.reserve(1, digest('request-' + taskId), { ...node, stepIndex: 0, priorityIndex: 0, configurationIdentity: digest('gate-config') })
      ledger.settle(reservation, 'returned', { readable: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    }
    console.log(JSON.stringify({ mode, usedGlobal: ledger.snapshot().globalUsed, usedGroup: ledger.snapshot().groupUsed }))
  } finally { gate.release('ledger_fixture_finished') }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
