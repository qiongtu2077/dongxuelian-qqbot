'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const records = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const periods = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const paths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const derived = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/precompute-status')
const ts = value => Date.parse(value + '+08:00')
const noon = ts('2026-10-02T12:00:00')
const old = ts('2026-10-02T03:59:59')
const current = ts('2026-10-02T04:00:00')
const reportPeriod = periods.createReportPeriod(old)

// 直接保存已核实的活动任务DTO，隔离状态迁移与来源清理的验证范围。
function writeTask(id, status, channelKey, payload = reportPeriod, kind = 'daily_report') {
  const task = { id, status, kind, source: 'maintenance-fixture', channelKey, userId: 'fixture', priority: 50,
    createdAt: new Date(old).toISOString(), updatedAt: new Date(old).toISOString(), expiresAt: '', timeoutMs: 600000,
    payload, notify: { target: 'none', status: 'pending' } }
  const file = paths.getTaskFile(status, kind, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(task))
  return file
}

// 保存完整正文并返回自然日文件，用真实流式读取断言清理后的记录。
function writeRecord(channelKey, id, timestamp) {
  const date = new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10)
  records.appendReportRecord(date, channelKey, { messageId: id, timestamp, userId: 'u', userName: '用户', text: id })
  return records.getReportIndexFile(date, channelKey)
}

// 不带窗口过滤读取物理保留记录，确认混合自然日文件没有删除新报告日。
function ids(file) {
  const output = []
  records.scanReportIndex(file, record => output.push(record.messageId))
  return output
}

// 验证到期、全部活动状态、缺失证据和启动调度的真实维护链路。
async function run() {
  store.ensureTaskDirs()
  const mixed = writeRecord('mixed', 'expired', old)
  writeRecord('mixed', 'new-window', current)
  const before = await records.cleanupReportRecords({ now: noon - 1 })
  assert.equal(before.removed, 0)
  assert.deepEqual(ids(mixed), ['expired', 'new-window'])
  // 混合文件的旧派生统计不能继续声称覆盖新保留范围。
  const slotDir = path.join(derived.SLOTS_ROOT, '2026-10-02', 'mixed')
  fs.mkdirSync(slotDir, { recursive: true })
  fs.writeFileSync(path.join(slotDir, 'old.json'), JSON.stringify({ coveredMessageIds: ['expired'], topics: [] }))
  const finalInput = derived.getDailyFinalInputFile('2026-10-02', 'mixed')
  fs.mkdirSync(path.dirname(finalInput), { recursive: true })
  fs.writeFileSync(finalInput, '{}')
  const expired = await records.cleanupReportRecords({ now: noon })
  assert.equal(expired.removed, 1)
  assert.deepEqual(ids(mixed), ['new-window'])
  assert.equal(fs.existsSync(slotDir), false)
  assert.equal(fs.existsSync(finalInput), false)
  const coverage = JSON.parse(fs.readFileSync(path.join(derived.COVERAGE_ROOT, '2026-10-02', 'mixed.json')))
  assert.equal(coverage.totalMessages, 1)
  assert.equal(coverage.coveredMessages, 0)

  const taskFiles = []
  const protectedFiles = []
  for (const status of ['pending', 'claiming', 'running', 'deferred']) {
    const key = 'protect-' + status
    protectedFiles.push(writeRecord(key, 'needed-' + status, old))
    taskFiles.push(writeTask(key, status, key))
  }
  const legacy = writeRecord('legacy-task', 'legacy-needed', old)
  taskFiles.push(writeTask('legacy-task', 'pending', 'legacy-task', {}))
  await records.cleanupReportRecords({ now: noon })
  assert(protectedFiles.every(file => ids(file).length === 1))
  assert.deepEqual(ids(legacy), ['legacy-needed'])
  for (const file of taskFiles) fs.unlinkSync(file)
  await records.cleanupReportRecords({ now: noon })
  assert(protectedFiles.every(file => !fs.existsSync(file)))
  assert.equal(fs.existsSync(legacy), false)

  const evidenceFile = writeRecord('evidence', 'needed-body', old)
  const lossFile = evidenceFile + '.losses.jsonl'
  const loss = { recordVersion: 2, messageId: 'missing-body', realMessageId: true, timestamp: old, userId: 'u', userName: '用户', text: '', media: [], bodyComplete: false, incompleteReason: 'source_file_limit' }
  fs.writeFileSync(lossFile, JSON.stringify(loss) + '\n')
  fs.writeFileSync(evidenceFile + '.integrity.json', JSON.stringify([{ firstTimestamp: old, lastTimestamp: current, count: 2 }]))
  const protectEvidence = writeTask('protect-evidence', 'running', 'evidence')
  await records.cleanupReportRecords({ now: noon })
  assert.deepEqual(ids(lossFile), ['missing-body'])
  assert.equal(JSON.parse(fs.readFileSync(evidenceFile + '.integrity.json'))[0].count, 2)
  fs.unlinkSync(protectEvidence)
  await records.cleanupReportRecords({ now: noon })
  assert.equal(fs.existsSync(evidenceFile), false)
  assert.equal(fs.existsSync(lossFile), false)
  assert.equal(fs.existsSync(evidenceFile + '.integrity.json'), true)
  await records.cleanupReportRecords({ now: ts('2026-10-03T12:00:00') })
  assert.equal(fs.existsSync(evidenceFile + '.integrity.json'), false)

  const stopFile = writeRecord('stop-on-error', 'must-keep', old)
  const badTask = paths.getTaskFile('pending', 'daily_report', 'bad-task')
  fs.writeFileSync(badTask, '{broken}')
  await assert.rejects(records.cleanupReportRecords({ now: noon }), /活动任务记录损坏/)
  assert.deepEqual(ids(stopFile), ['must-keep'])
  fs.unlinkSync(badTask)
  const invalidWindow = writeTask('invalid-window', 'pending', 'stop-on-error', { ...reportPeriod, cutoffMs: NaN })
  await assert.rejects(records.cleanupReportRecords({ now: noon }), /无效|不一致/)
  assert.deepEqual(ids(stopFile), ['must-keep'])
  fs.unlinkSync(invalidWindow)
  fs.writeFileSync(stopFile + '.losses.jsonl', '{broken}\n')
  await assert.rejects(records.cleanupReportRecords({ now: noon }), /无法解析/)
  assert.deepEqual(ids(stopFile), ['must-keep'])
  assert.equal(fs.readdirSync(path.dirname(stopFile)).some(name => name.includes('.cleanup-')), false)
  fs.unlinkSync(stopFile + '.losses.jsonl')

  // 在维护让出事件循环时提交新任务与追加记录，下一组必须重读活动保护。
  const concurrent = writeRecord('zz-concurrent', 'concurrent-needed', old)
  const appended = new Promise(resolve => setImmediate(() => {
    writeTask('during-cleanup', 'pending', 'zz-concurrent')
    writeRecord('zz-concurrent', 'during-cleanup', current + 1)
    resolve()
  }))
  await Promise.all([records.cleanupReportRecords({ now: noon }), appended])
  assert.deepEqual(ids(concurrent), ['concurrent-needed', 'during-cleanup'])
  fs.unlinkSync(paths.getTaskFile('pending', 'daily_report', 'during-cleanup'))

  // 删除保护枚举不能复用1000条或20000条的管理展示上限。
  const template = JSON.parse(fs.readFileSync(writeTask('template-agent', 'pending', 'other', {}, 'agent_task')))
  const agentDir = path.dirname(paths.getTaskFile('pending', 'agent_task', template.id))
  for (let index = 0; index < 20005; index++) fs.writeFileSync(path.join(agentDir, 'other-' + index + '.json'), JSON.stringify({ ...template, id: 'other-' + index }))
  const beyondFile = writeRecord('after-20k', 'after-20k-needed', old)
  const beyondTask = writeTask('zz-after-20k', 'pending', 'after-20k')
  assert.equal(store.listActiveDailyReportTasks().some(task => task.id === 'zz-after-20k'), true)
  await records.cleanupReportRecords({ now: noon, maxFiles: 1 })
  assert.deepEqual(ids(beyondFile), ['after-20k-needed'])
  fs.unlinkSync(beyondTask)
  for (const file of fs.readdirSync(agentDir)) fs.unlinkSync(path.join(agentDir, file))

  const schedulers = require('koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers')
  assert.equal(schedulers.getNextShanghaiNoonDelayMs(noon - 1000), 1000)
  assert.equal(schedulers.getNextShanghaiNoonDelayMs(noon), 24 * 3600000)
  const startupFile = writeRecord('restart-expired', 'startup-cleanup', old)
  const originalNow = Date.now
  const originalTimeout = global.setTimeout
  const originalClear = global.clearTimeout
  const timers = []
  const cancelledTimers = []
  try {
    Date.now = () => noon
    global.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer }
    global.clearTimeout = timer => cancelledTimers.push(timer)
    const warnings = []
    schedulers.scheduleReportSourceCleanup({ logger() { return { warn(message) { warnings.push(message) } } } })
    assert.equal(timers[0].ms, 1000)
    await timers[0].fn()
    assert.equal(fs.existsSync(startupFile), false)
    assert.equal(warnings.length, 0)
    assert.equal(timers[1].ms, 5 * 60000)
    schedulers.clearStartupSchedulers()
    assert(cancelledTimers.includes(timers[1]))
  } finally { Date.now = originalNow; global.setTimeout = originalTimeout; global.clearTimeout = originalClear; schedulers.clearStartupSchedulers() }
  console.log(JSON.stringify({ mixed: true, active: true, terminal: true, evidence: true, failClosed: true, concurrent: true, completeEnumeration: true, startup: true }))
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
