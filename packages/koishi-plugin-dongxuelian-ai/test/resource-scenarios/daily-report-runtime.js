'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// 子进程隔离真实任务文件，验证根worker的硬截止、实际取消及最近诊断。
function runDailyReportRuntimeScenarios() {
  const dataDir = createTempDataDir('resource-regress-daily-runtime-')
  try {
    const fixture = path.join(__dirname, '..', 'helpers', 'daily-report-runtime-fixture.js')
    const result = runScenario('daily report root worker enforces one runtime deadline', 'require(' + JSON.stringify(fixture) + ')', { DONGXUELIAN_AI_DATA_DIR: dataDir }, 15000)
    if (!result) return
    for (const field of ['queueExcluded', 'fixedPeriod', 'noExpiredDispatch', 'actualAbort', 'diagnosticPreserved', 'nextTask']) check('daily report runtime ' + field, result[field])
  } finally {
    const resolved = path.resolve(dataDir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('resource-regress-daily-runtime-')) throw new Error('日报运行测试临时目录越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
module.exports = { runDailyReportRuntimeScenarios }
