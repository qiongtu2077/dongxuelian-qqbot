'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// 真实任务落盘配合模拟发送，验证失败提示、完整正文及进程重启后的送达进度。
function runDailyReportDeliveryScenarios() {
  const dataDir = createTempDataDir('resource-regress-daily-delivery-')
  try {
    const fixture = path.join(__dirname, '..', 'helpers', 'daily-report-delivery-fixture.js')
    const script = 'require(' + JSON.stringify(fixture) + ')'
    const result = runScenario('daily report delivery persists complete segments and fixed failure replies', script, { DONGXUELIAN_AI_DATA_DIR: dataDir }, 30000)
    if (!result) return
    check('daily report full text has no tail or emoji truncation', result.fullText)
    check('daily report generation and runtime timeout have exact distinct fixed replies', result.failures)
    check('daily report historical failure, other failure and user cancellation stay silent', result.historicalIsolation)
    check('daily report new process resumes only unconfirmed segments', result.restart)
    check('daily report missing platform receipt is explicitly unknown', result.unknownReceipt)
    check('daily report confirmed delivery is not repeated before terminal notification persistence', result.finalize)
    check('daily report pending notification is not blocked behind completed history', result.backlog)
  } finally {
    const resolved = path.resolve(dataDir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('resource-regress-daily-delivery-')) throw new Error('日报通知测试临时目录越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

module.exports = { runDailyReportDeliveryScenarios }
