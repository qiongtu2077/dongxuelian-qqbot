'use strict'

const assert = require('assert').strict
const fs = require('fs')
const { spawnSync } = require('child_process')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const paths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const notifier = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const { ReportRuntimeTimeoutError, REPORT_FAILURE_TEXT, REPORT_TIMEOUT_TEXT } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis')

// 创建有发送目标的任务，生成与通知结果分别断言。
function pending(id, kind = 'daily_report') {
  return store.submitResourceTask({ id, kind, channelKey: 'fixture-group', notify: { target: 'qq-group', channelKey: 'fixture-group', status: 'pending' } })
}

// 模拟平台异步回执，保留实际发送边界。
function waitForReceipt() {
  return new Promise(resolve => setTimeout(resolve, 12))
}

// 验证完整文字与失败通知的实际落盘状态。
async function run() {
  const sent = []
  const bot = { internal: { async sendGroupMsg(target, segments) { await waitForReceipt(); sent.push(segments[0].data.text); return sent.length } } }
  const sender = notifier.createDailyReportSender({ bot })
  const text = '\n' + '话题一：早间。'.repeat(300) + '\n\n' + '话题二：午间。'.repeat(380) + '\n\n' + '长段😊尾部主题'.repeat(1500) + '\n结尾画像与锐评\n'
  const pieces = notifier.splitDailyReportText(text)
  assert.equal(pieces.join(''), text)
  assert(pieces.every(piece => piece.length <= 3900 && !/[\uD800-\uDBFF]$/.test(piece)))
  assert(pieces.length > 4)
  const basic = store.completeTask(pending('full-text'), { mode: 'text', reason: 'render_failed', text })
  const first = await notifier.notifyCompletedTasks({ sender, limit: 50 })
  assert.equal(first.sent, 1)
  assert(sent.every(piece => piece.length <= 4000))
  assert.equal(sent.map(piece => piece.replace(/^日报文字版（第 \d+\/\d+ 段）\n\n/, '')).join(''), '图片生成失败，已发送文字版日报。\n\n' + text)
  assert.equal(store.getResourceTaskById(basic.id).notify.dailyReportDelivery.confirmedSegments, sent.length)
  const beforeRepeat = sent.length
  await notifier.notifyCompletedTasks({ sender, limit: 50 })
  assert.equal(sent.length, beforeRepeat)

  store.failTask(pending('failed-new'), new Error('single request timeout, not total deadline'))
  await waitForReceipt()
  store.failTask(pending('timeout-new'), new ReportRuntimeTimeoutError())
  await waitForReceipt()
  const old = store.failTask(pending('failed-old'), new Error('old failure'))
  const oldFile = paths.getTaskFile(old.status, old.kind, old.id)
  delete old.notify.failureNotificationVersion
  fs.writeFileSync(oldFile, JSON.stringify(old))
  await waitForReceipt()
  store.failTask(pending('failed-other', 'agent_task'), new Error('other failure'))
  const cancelled = pending('cancelled-daily')
  assert.equal(store.cancelTask(cancelled.id, 'fixture-user'), true)
  const failureResult = await notifier.notifyCompletedTasks({ sender, limit: 50 })
  assert.equal(failureResult.sent, 2)
  assert.equal(sent.filter(message => message === REPORT_FAILURE_TEXT).length, 1)
  assert.equal(sent.filter(message => message === REPORT_TIMEOUT_TEXT).length, 1)
  assert.equal(store.getResourceTaskById(old.id).notify.status, 'pending')
  assert.equal(store.getResourceTaskById('failed-other').notify.status, 'pending')
  assert.equal(store.getResourceTaskById('cancelled-daily').notify.status, 'pending')
  await notifier.notifyCompletedTasks({ sender, limit: 50 })
  assert.equal(sent.filter(message => message === REPORT_FAILURE_TEXT || message === REPORT_TIMEOUT_TEXT).length, 2)

  const resumeText = '完整前段'.repeat(700) + '\n\n' + '失败中段'.repeat(900) + '\n\n' + '末尾独立话题'.repeat(700)
  store.completeTask(pending('restart-partial'), { mode: 'text', reason: 'render_failed', text: resumeText })
  let calls = 0
  const partialMessages = []
  const partialSender = notifier.createDailyReportSender({ bot: { internal: { async sendGroupMsg(_target, segments) {
    await waitForReceipt()
    calls++
    if (calls === 2) throw new Error('transport closed after submission')
    partialMessages.push(segments[0].data.text)
    return 700 + calls
  } } } })
  const partial = await notifier.notifyCompletedTasks({ sender: partialSender, limit: 50 })
  assert.equal(partial.failed, 1)
  const partialTask = store.getResourceTaskById('restart-partial')
  assert.equal(partialTask.status, 'done')
  assert.equal(partialTask.notify.status, 'failed')
  assert.match(partialTask.notify.error, /发送结果未知/)
  assert.equal(partialTask.notify.dailyReportDelivery.confirmedSegments, 1)
  assert.equal(partialTask.notify.dailyReportDelivery.pendingSegment, 1)
  assert.equal(partialTask.notify.dailyReportDelivery.state, 'unknown')
  await notifier.notifyCompletedTasks({ sender: partialSender, limit: 50 })
  assert.equal(calls, 2)
  // 新的 Node 进程只读已有进度，绝不重新发送已经确认的第1段。
  const resumeCode = "const n = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier'); const s = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store'); const out=[]; const task=s.getResourceTaskById('restart-partial'); const now=Date.parse(task.notify.updatedAt)+61000; Date.now=()=>now; n.notifyCompletedTasks({sender:n.createDailyReportSender({bot:{internal:{sendGroupMsg:async (_t,m)=>{out.push(m[0].data.text);return 888;}}}})}).then(()=>console.log(JSON.stringify({out,task:s.getResourceTaskById('restart-partial')}))).catch(e=>{console.error(e);process.exitCode=1;});"
  const resumed = spawnSync(process.execPath, ['-e', resumeCode], { env: process.env, encoding: 'utf8', timeout: 10000 })
  assert.equal(resumed.status, 0, resumed.stderr)
  const recovery = JSON.parse(resumed.stdout.trim())
  assert.equal(recovery.task.notify.status, 'sent')
  assert(recovery.out.every(message => !message.startsWith('日报文字版（第 1/')))
  const recoveredText = [...partialMessages, ...recovery.out].map(piece => piece.replace(/^日报文字版（第 \d+\/\d+ 段）\n\n/, '')).join('')
  assert.equal(recoveredText, '图片生成失败，已发送文字版日报。\n\n' + resumeText)

  store.failTask(pending('unknown-receipt'), new Error('generation failed'))
  let unknownCalls = 0
  const unknownSender = notifier.createDailyReportSender({ bot: { internal: { async sendGroupMsg() { unknownCalls++; return undefined } } } })
  const unknownResult = await notifier.notifyCompletedTasks({ sender: unknownSender })
  assert.equal(unknownResult.failed, 1)
  assert.equal(store.getResourceTaskById('unknown-receipt').notify.dailyReportDelivery.confirmedSegments, 0)
  assert.equal(store.getResourceTaskById('unknown-receipt').notify.dailyReportDelivery.state, 'unknown')
  assert.equal(unknownCalls, 1)

  // 平台成功、最终 sent 状态落盘前重启，完整确认进度足以跳过发送。
  const sentTask = store.getResourceTaskById('failed-new')
  sentTask.notify.status = 'pending'
  fs.writeFileSync(paths.getTaskFile(sentTask.status, sentTask.kind, sentTask.id), JSON.stringify(sentTask))
  const beforeFinalize = sent.length
  await notifier.notifyCompletedTasks({ sender, limit: 50 })
  assert.equal(sent.length, beforeFinalize)
  assert.equal(store.getResourceTaskById('failed-new').notify.status, 'sent')

  // 超过展示批次大小的已发送历史任务不能占住通知扫描前1000条。
  const historyBase = store.getResourceTaskById('failed-new')
  for (let index = 0; index < 1050; index++) {
    const history = { ...historyBase, id: 'history-' + index, status: 'done', kind: 'agent_task' }
    fs.writeFileSync(paths.getTaskFile('done', history.kind, history.id), JSON.stringify(history))
  }
  store.completeTask(pending('done-after-history'), { text: '历史积压之后的完整日报' })
  const afterHistory = await notifier.notifyCompletedTasks({ sender, limit: 1 })
  assert.equal(afterHistory.sent, 1)
  assert.equal(store.getResourceTaskById('done-after-history').notify.status, 'sent')
  console.log(JSON.stringify({ fullText: true, failures: true, historicalIsolation: true, restart: true, unknownReceipt: true, finalize: true, backlog: true }))
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
