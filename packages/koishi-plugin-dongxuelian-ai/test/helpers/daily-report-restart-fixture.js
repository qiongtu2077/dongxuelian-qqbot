/** 真实日报管线与跨进程启动清理：第590秒迟到模型/图片不得复活旧任务。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path'), os = require('os')
const { spawnSync } = require('child_process'), { createHash } = require('crypto')
const dataDir = path.resolve(process.env.DONGXUELIAN_AI_DATA_DIR || '.')
if (path.dirname(dataDir) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('resource-regress-daily-runtime-')) throw new Error('重启夹具必须使用隔离临时目录')
const store = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const paths = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const { appendReportRecord } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const api = require('koishi-plugin-dongxuelian-ai/lib/core/api')
const config = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
const renderer = require('../../../koishi-plugin-daily-report/lib/html-renderer')
const { makeModelRequest } = require('../../../koishi-plugin-daily-report/test/analysis-entry-test')
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const { notifyCompletedTasks } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')
const { acquireResourceGate } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const NativeDate = Date, originals = { request: api.requestChatCompletions, loadConfig: config.loadConfig, render: renderer.renderReport, chmod: fs.chmodSync }
let clock = NativeDate.now(), current, mode, requestCount, beforeRestart
const period = createReportPeriod(NativeDate.parse('2026-10-01T12:00:00+08:00'))
// 路径只恢复生产产物使用的程序身份摘要，不接受任意文件名。
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// --- 已知外部边界与场景时钟 --- //

// 只推进场景时间，真实异步与子进程不使用全局fake timers。
function installBoundaries() {
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  config.loadConfig = async () => ({ apiKey: 'test-key', model: 'test-model', baseURL: 'https://example.com', provider: 'opencode' })
  api.requestChatCompletions = async (...args) => {
    requestCount++
    const response = await makeModelRequest([])(...args)
    if (mode === 'analyzing' && requestCount === 2) restartFromAnotherProcess()
    return response
  }
  renderer.renderReport = async () => { if (mode === 'rendering') restartFromAnotherProcess(); return Buffer.from('late-fixture-image') }
  fs.chmodSync = (file, permissions) => {
    originals.chmod(file, permissions)
    // 成功JSON已原子写入，真实保存回调还未返回、完成账本尚未推进。
    if (mode === 'persisting' && !beforeRestart && file.startsWith(path.join(dataDir, 'daily-analysis')) && file.endsWith('.success.json')) restartFromAnotherProcess()
  }
  for (let index = 0; index < 3; index++) appendReportRecord(period.reportDate, 'restart-pipeline', {
    messageId: 'restart-source-' + index, timestamp: period.cutoffMs - 3000 + index * 1000,
    userId: 'member-a', userName: '测试成员', text: '实际收录的独立讨论' + index,
  })
}

// --- 跨进程状态与产物核验 --- //

// 读取真实任务产物；成功文件逐字快照可证明旧执行没有追加或修改可信结果。
function snapshot(taskId) {
  const directory = path.join(dataDir, 'daily-analysis', 'task-artifacts', hash('restart-pipeline'), hash(taskId))
  const success = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.success.json')).sort()
    .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]) : []
  const progress = path.join(paths.getTaskResultDir(taskId), 'analysis-progress.json')
  return { success, progress: fs.existsSync(progress) ? fs.readFileSync(progress, 'utf8') : null }
}

// 第二个真实Node进程使用同一任务目录执行生产启动清理，旧进程保留在途响应。
function restartFromAnotherProcess() {
  clock = Date.parse(current.startedAt) + 590000
  beforeRestart = snapshot(current.id)
  assert(beforeRestart.success.length > 0)
  const script = `const NativeDate = Date; const clock = Number(process.env.DAILY_REPORT_RESTART_CLOCK_MS);
    global.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])) } static now() { return clock } };
    console.log(JSON.stringify(require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store').discardInterruptedResourceTaskState('fixture restart at 590 seconds')))`
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '../../../..'),
    env: { ...process.env, DAILY_REPORT_RESTART_CLOCK_MS: String(clock) }, encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout.trim()).cancelled, 1)
  assert.equal(store.getResourceTaskById(current.id).status, 'cancelled')
}

// --- 迟到结果与新任务 --- //

// 真实领取、worker、管线、分析器、覆盖校验和产物写入均保留，仅外部模型/图片被模拟。
async function lateCase(stage) {
  mode = stage; requestCount = 0; beforeRestart = null
  const id = 'restart-pipeline-' + stage
  store.submitResourceTask({ id, kind: 'daily_report', channelKey: 'restart-pipeline', timeoutMs: 600000,
    notify: { target: 'group', status: 'pending', groupId: 'restart-fixture-group' },
    payload: { ...period, renderImage: stage === 'rendering', reportPolicyVersion: 2 } })
  current = store.markTaskRunning(store.claimTaskById(id, 'restart-worker'), 'restart-worker')
  const lease = await acquireResourceGate({ taskId: id, kind: 'daily_report', owner: 'restart-worker', waitTimeoutMs: 0 })
  try { await assert.rejects(worker.runTaskWithTimeout(current), /已取消或领取已失效/) }
  finally { lease.release('late-report-fixture-finished') }
  assert(requestCount >= (stage === 'persisting' ? 1 : 2)); assert(beforeRestart)
  if (stage === 'persisting') assert.equal(JSON.parse(beforeRestart.progress).analysisMeta.summarizedMessageCount, 0)
  assert.deepEqual(snapshot(id), beforeRestart)
  const directory = paths.getTaskResultDir(id)
  assert.equal(fs.existsSync(path.join(directory, 'result.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'report.png')), false)
  assert.equal(fs.existsSync(path.join(directory, 'report.txt')), stage === 'rendering')
  store.completeTask(current, { ok: true, reply: 'forbidden late success' })
  assert.equal(store.getResourceTaskById(id).status, 'cancelled')
  assert.equal(store.claimTaskById(id, 'duplicate-worker'), null)
  assert.equal(fs.existsSync(path.join(directory, 'result.json')), false)
}

// 新任务独立领取与运行，不复活旧任务，也不假称尚未实现的跨任务缓存命中。
async function freshCase() {
  mode = 'fresh'; requestCount = 0
  const id = 'restart-pipeline-fresh'
  store.submitResourceTask({ id, kind: 'daily_report', channelKey: 'restart-pipeline', timeoutMs: 600000,
    notify: { target: 'group', status: 'pending', groupId: 'restart-fixture-group' },
    payload: { ...period, renderImage: false, reportPolicyVersion: 2 } })
  const fresh = store.markTaskRunning(store.claimTaskById(id, 'fresh-worker'), 'fresh-worker')
  assert.equal(Date.parse(fresh.startedAt), clock)
  const lease = await acquireResourceGate({ taskId: id, kind: 'daily_report', owner: 'fresh-worker', waitTimeoutMs: 0 })
  let result
  try { result = await worker.runTaskWithTimeout(fresh) } finally { lease.release('fresh-report-fixture-finished') }
  assert.equal(result.ok, true); assert.equal(result.analysisMeta.analysisState, 'complete')
  assert.equal(result.analysisMeta.summarizedMessageCount, 3); assert(requestCount >= 2)
  assert(snapshot(id).success.length >= 2)
  assert.equal(store.completeTask(fresh, result).status, 'done')
  for (const stage of ['analyzing', 'rendering', 'persisting']) assert.equal(store.getResourceTaskById('restart-pipeline-' + stage).status, 'cancelled')
}

// 真实通知扫描仅收到新任务一次；发送边界只记内存，不接触QQ。
async function verifyNotifications(expectFresh) {
  const received = []
  const sender = async (task, result) => {
    received.push(task.id); assert.equal(result.ok, true)
    assert(fs.readFileSync(result.textPath, 'utf8').includes('实际收录的独立讨论'))
    return true
  }
  const first = await notifyCompletedTasks({ sender }), second = await notifyCompletedTasks({ sender })
  assert.deepEqual(received, expectFresh ? ['restart-pipeline-fresh'] : [])
  assert.equal(first.sent, expectFresh ? 1 : 0); assert.equal(second.sent, 0)
  for (const stage of ['analyzing', 'rendering', 'persisting']) assert.equal(store.getResourceTaskById('restart-pipeline-' + stage).notify.status, 'pending')
}

// --- 隔离入口与恢复 --- //

// 所有替换与时钟均finally恢复，失败由隔离子进程传播到正式资源回归入口。
async function run() {
  try {
    installBoundaries()
    await lateCase('analyzing')
    await lateCase('rendering')
    await lateCase('persisting')
    await verifyNotifications(false)
    await freshCase()
    await verifyNotifications(true)
    console.log(JSON.stringify({ realPipelineRestartAt590: true, secondProcessCleanup: true, lateModelRejected: true,
      lateImageRejected: true, trustedArtifactsUnchanged: true, staleCompletionRejected: true, freshPipelineIndependent: true,
      durableBeforeLedgerInterrupted: true, cancelledReportsNeverNotified: true, freshNotificationOnce: true }))
  } finally {
    global.Date = NativeDate; api.requestChatCompletions = originals.request
    config.loadConfig = originals.loadConfig; renderer.renderReport = originals.render; fs.chmodSync = originals.chmod
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
