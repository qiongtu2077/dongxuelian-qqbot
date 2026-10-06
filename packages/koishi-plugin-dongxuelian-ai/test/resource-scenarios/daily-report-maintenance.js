'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// 独立数据目录验证中午维护，包含超20000条活动任务的完整枚举。
function runDailyReportMaintenanceScenarios() {
  const dataDir = createTempDataDir('resource-regress-daily-maintenance-')
  try {
    const fixture = path.join(__dirname, '..', 'helpers', 'daily-report-maintenance-fixture.js')
    const result = runScenario('daily report raw source expiry and complete active protection', 'require(' + JSON.stringify(fixture) + ')', { DONGXUELIAN_AI_DATA_DIR: dataDir }, 60000)
    if (!result) return
    check('daily report mixed natural-day file keeps new four-hour window', result.mixed)
    check('daily report all active states and legacy queued window protect source', result.active)
    check('daily report terminal tasks release expired source next maintenance', result.terminal)
    check('daily report loss journal and aggregate integrity range remain protected', result.evidence)
    check('daily report malformed active task or source blocks deletion', result.failClosed)
    check('daily report asynchronous append and new task survive file maintenance', result.concurrent)
    check('daily report active protection has no 1000 or 20000 display limit', result.completeEnumeration)
    check('daily report startup catch-up noon schedule and disposal run without private messages', result.startup)
  } finally {
    const resolved = path.resolve(dataDir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('resource-regress-daily-maintenance-')) throw new Error('日报维护测试临时目录越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
module.exports = { runDailyReportMaintenanceScenarios }
