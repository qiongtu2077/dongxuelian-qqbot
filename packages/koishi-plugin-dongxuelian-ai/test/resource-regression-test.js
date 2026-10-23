/**
 * S0-S8 资源架构回归入口。
 * 职责: 顺序运行按领域拆分的资源场景并汇总共享断言。
 * 边界: 场景实现、子进程夹具和断言状态分别位于 resource-scenarios 与 helpers。
 */
'use strict'

const { resetSummary, getSummary } = require('./helpers/resource-harness')
const { runSchedulingAndDirectiveScenarios } = require('./resource-scenarios/scheduling-and-directives')
const { runTaskStateAndSupervisorScenarios } = require('./resource-scenarios/task-state-and-supervisor')
const { runAuditAndPerformanceScenarios } = require('./resource-scenarios/audit-and-performance')
const { runAdmissionAndLookupScenarios } = require('./resource-scenarios/admission-and-lookups')
const { runDailyReportDeliveryScenarios } = require('./resource-scenarios/daily-report-delivery')
const { runDailyReportMaintenanceScenarios } = require('./resource-scenarios/daily-report-maintenance')
const { runDailyReportRuntimeScenarios } = require('./resource-scenarios/daily-report-runtime')
const { runImageDemandAndCacheScenarios } = require('./resource-scenarios/image-demand-and-cache')

// 顺序运行全部资源回归组，保持旧入口的隔离子进程和汇总语义。
function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--media')) throw new Error('unknown resource regression argument')
  resetSummary()
  runSchedulingAndDirectiveScenarios()
  runTaskStateAndSupervisorScenarios()
  runAuditAndPerformanceScenarios()
  runAdmissionAndLookupScenarios()
  runImageDemandAndCacheScenarios()
  // 媒体模块验证仍覆盖共享资源调用链；默认入口保留全部日报专属夹具。
  if (!args.includes('--media')) {
    runDailyReportDeliveryScenarios()
    runDailyReportMaintenanceScenarios()
    runDailyReportRuntimeScenarios()
  }
  const summary = getSummary()
  console.log(`passed: ${summary.passed}`)
  console.log(`failed: ${summary.failed}`)
  process.exitCode = summary.failed === 0 ? 0 : 1
}

main()
