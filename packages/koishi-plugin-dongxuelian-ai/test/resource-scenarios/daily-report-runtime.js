'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// 子进程隔离真实任务文件，验证根worker的硬截止、实际取消及最近诊断。
function runDailyReportRuntimeScenarios() {
  const fixtures = [
    ['daily-report-storage-lease-fixture.js', ['actualS0TicketGuard', 'sameTaskNewTicketRejected', 'noLateSuccessOrDiagnostic', 'noMoreModelCalls']],
    ['daily-preanalysis-scheduler-fixture.js', ['defaultOff', 'zeroWaitGate', 'missingLedgerStops', 'plannerZeroCalls', 'candidateOnly', 'activeDedupe', 'durableScheduleCooldown', 'workerRevalidates', 'completedCacheSkipped', 'foregroundPriority', 'disposedNoSubmission', 'existingTimerDispose', 'onlyConfiguredDeepseek']],
    ['daily-preanalysis-worker-fixture.js', ['defaultOff', 'missingLedgerNoCall', 'actualGateAndWorker', 'durableBatch', 'repeatedCacheNoCall', 'fullWindowSeparateFromSelection', 'foregroundPriority', 'activeSourceProtection', 'noNotification', 'onlyConfiguredDeepseek']],
    ['daily-report-runtime-fixture.js', ['queueExcluded', 'fixedPeriod', 'noExpiredDispatch', 'actualAbort', 'diagnosticPreserved', 'nextTask', 'activeGuardForwarded']],
    ['daily-report-lifecycle-fixture.js', ['gateWaitExcluded', 'gateFailureUnstarted', 'cancelledBeforeRun', 'duplicateClaimRejected', 'retryPreservesDeadline', 'expiredDoesNotDispatch', 'otherKindUnchanged', 'restartCancelsWaitingExecution', 'lateResultsRejected', 'freshTaskIndependent', 'activeClaimValidated', 'cancelledClaimRejected', 'staleTransitionsRejected']],
    ['daily-report-restart-fixture.js', ['realPipelineRestartAt590', 'secondProcessCleanup', 'lateModelRejected', 'lateImageRejected', 'trustedArtifactsUnchanged', 'staleCompletionRejected', 'freshPipelineIndependent', 'durableBeforeLedgerInterrupted', 'cancelledReportsNeverNotified', 'freshNotificationOnce']],
  ]
  for (const [name, fields] of fixtures) {
    const dataDir = createTempDataDir('resource-regress-daily-runtime-')
    try {
      const fixture = path.join(__dirname, '..', 'helpers', name)
      // 预分析用真实S0/文件存储连续跑两个窗口；父进程只放宽夹具观测期限，生产90秒规则不变。
      const result = runScenario(name, 'require(' + JSON.stringify(fixture) + ')', { DONGXUELIAN_AI_DATA_DIR: dataDir }, name.startsWith('daily-preanalysis-') ? 45000 : 15000)
      if (!result) continue
      for (const field of fields) check('daily report runtime ' + field, result[field])
    } finally {
      const resolved = path.resolve(dataDir)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('resource-regress-daily-runtime-')) throw new Error('日报运行测试临时目录越界')
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  }
  const dataDir = createTempDataDir('resource-regress-daily-runtime-')
  try {
    const result = runScenario('preanalysis lifecycle', 'require(' + JSON.stringify(path.join(__dirname, '../helpers/daily-report-lifecycle-fixture.js')) + ')',
      { DONGXUELIAN_AI_DATA_DIR: dataDir, REPORT_LIFECYCLE_KIND: 'daily_report_preanalysis' }, 15000)
    if (result) for (const field of fixtures.find(([name]) => name === 'daily-report-lifecycle-fixture.js')[1]) check('preanalysis runtime ' + field, result[field])
    if (result) check('preanalysis timeout waits for execution drain', result.timeoutDrained)
  } finally {
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('resource-regress-daily-runtime-')) throw new Error('预分析临时目录越界')
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}
module.exports = { runDailyReportRuntimeScenarios }
