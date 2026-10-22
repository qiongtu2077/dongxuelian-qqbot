/** 新链正式worker、真实S0/S2、完整索引与磁盘缓存；仅配置和HTTP返回为受控边界。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path'), crypto = require('crypto')
const NativeDate = Date
let clock = NativeDate.parse('2026-10-16T12:00:00+08:00')
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return clock }
}
process.env.DAILY_REPORT_GROUNDED_ENABLED = '1'
process.env.DAILY_REPORT_GROUNDED_PROVIDER = 'fixture-ling'
process.env.DAILY_REPORT_GROUNDED_MODEL = 'glm-5.3-flash'
process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES = '4000'
const capability = require('koishi-plugin-dongxuelian-ai/lib/core/ai-capability-config')
capability.resolveConfiguredCapabilityModel = (kind, provider, model) => {
  assert.equal(kind, 'text'); assert.equal(provider, 'fixture-ling'); assert.equal(model, 'glm-5.3-flash')
  return { provider, model, apiKey: 'fake-test-key', baseURL: 'https://llm.pko.svcfusion.com/v1', chatProtocol: 'openai-chat', priorityIndex: 0 }
}
require('koishi-plugin-dongxuelian-ai/lib/core/capability-failure-notifier').notifyCapabilityStepFailure = async () => false
const taskStore = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
const { getTaskResultDir } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-paths')
const { acquireResourceGate } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
const records = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-records')
const { runTaskWithTimeout } = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main')
const { PagedReportStore } = require('../../../koishi-plugin-daily-report/lib/report-storage')
const { listPagedStoreFiles } = require('../../../koishi-plugin-daily-report/test/helpers/report-store-fixture')
let gate, current, mode = 'normal', calls = []
const period = createReportPeriod(clock), channelKey = 'grounded-real-worker'

// 模型固定返回仅使用实际请求的合法引用；完整供料、读者和模型来源证明由正式实现执行。
function reply(system, payload) {
  if (payload.items) return { groups: mode === 'two' ? { 'event:1': '安装讨论', 'event:2': '使用讨论' } : { 'event:1': '具体安装讨论' },
    records: Object.fromEntries(payload.items.map((item, index) => [item.ref, mode === 'two' && index % 2 ? 'event:2' : 'event:1'])),
    quotes: payload.items.slice(0, 3).map(item => ({ kind: 'quote', ref: item.ref, criterion: 'useful_insight' })), completed: true }
  if (payload.kind === 'topic-cards-9') return { cards: Object.fromEntries(payload.candidates.map(candidate => [candidate.ref,
    [{ refs: candidate.refs, status: 'ok', scope: '具体安装讨论', evidence: [candidate.refs[0]] }]])) }
  if (payload.kind === 'topic-directory-3') return { groups: mode !== 'two' && payload.candidates.length > 1 ? [{ refs: payload.candidates.map(candidate => candidate.ref),
    scope: '具体安装讨论', representatives: [payload.candidates[0].ref] }] : [], completed: true }
  if (payload.kind === 'topic-selection-3') return { selected: payload.candidates.slice(0, mode === 'two' ? 2 : 1).map(candidate => candidate.ref), completed: true }
  if (system.includes('四个字段齐全')) return { title: '具体安装讨论', summary: '围绕安装设置和实际使用展开讨论。', refs: [payload.sources[0].ref], completed: true }
  if (system.includes('从primary候选中选择')) {
    const primary = payload.sources.filter(source => source.role === 'primary')
    return { items: primary.length < 3 ? [] : primary.slice(0, 3).map(source => ({ ref: source.ref, comment: '' })) }
  }
  if (system.includes('仅概括本期本人实际发言')) return { members: payload.members.map(member => ({ member: member.ref, status: 'ok', title: '', description: '本期参与了安装讨论。', refs: member.refs.slice(0, 1) })), completed: true }
  return { status: 'ok', title: '本期互动', dimensions: [{ name: '讨论', percentage: 50, comment: '围绕安装交流。', refs: [payload.sources[0].ref], statRefs: ['s1'] }],
    summary: '本期参与具体安装讨论。', refs: [payload.sources[0].ref], statRefs: [], completed: true }
}

// 每个任务独立真实领取及S0票据，调用方不注入空租约守卫。
async function execute(id, options = {}) {
  const selectedChannel = options.channel || channelKey
  taskStore.submitResourceTask({ id, kind: 'daily_report', channelKey: selectedChannel, timeoutMs: 1800000,
    payload: { ...period, detail: options.detail !== false, renderImage: false }, notify: { target: 'none', status: 'pending' } })
  current = taskStore.markTaskRunning(taskStore.claimTaskById(id, 'grounded-fixture'), 'grounded-fixture')
  gate = await acquireResourceGate({ taskId: id, kind: current.kind, owner: 'grounded-fixture', waitTimeoutMs: 0, timeoutMs: 1800000 })
  try {
    const value = await runTaskWithTimeout(current)
    taskStore.completeTask(current, value)
    if (value.analysisPath) {
      const bytes = fs.readFileSync(value.analysisPath)
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), value.analysisSha256)
      return { ...value, analysis: JSON.parse(bytes) }
    }
    return value
  } catch (error) { taskStore.failTask(current, error); throw error }
  finally { gate.release('grounded-fixture-finished'); gate = null }
}

// 正式收集器读取完整窗口4100条，入选最新4000；稳定永久身份来自真实索引写入。
function append(count, prefix, first) {
  for (let index = 0; index < count; index++) records.appendReportRecord(period.reportDate, channelKey, {
    messageId: prefix + index, timestamp: first + index * 1000, userId: 'member-' + index % 3, userName: '成员' + index % 3,
    text: '安装设置的具体讨论' + prefix + index,
  })
}

// 原有目录与缓存实际落盘，热任务必须零HTTP；滑动不允许重算所有封闭中间批。
async function main() {
  const originalFetch = global.fetch, commit = PagedReportStore.prototype.commit, write = PagedReportStore.prototype.writeTaskArtifact
  const boundariesOnly = process.argv.includes('--boundaries-only')
  let coldClassifications = 0, slideClassifications = 0
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body), payload = JSON.parse(body.messages[1].content)
    assert.equal(body.model, 'glm-5.3-flash'); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.response_format.type, 'json_object')
    calls.push(payload)
    if (mode === 'lease') { gate.release('replace-original-ticket'); gate = await acquireResourceGate({ taskId: current.id, kind: current.kind, owner: 'replacement', waitTimeoutMs: 0 }) }
    if (mode === 'cancel') taskStore.discardInterruptedResourceTaskState('fixture restart during grounded model')
    if (mode === 'deadline') clock += 1800001
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply(body.messages[0].content, payload)) } }],
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 } }), { status: 200 })
  }
  try {
    const { readGroundedReportConfiguration } = require('../../../koishi-plugin-daily-report/lib/report-grounded-entry')
    process.env.DAILY_REPORT_GROUNDED_ENABLED = '0'
    assert.equal(readGroundedReportConfiguration(), null)
    process.env.DAILY_REPORT_GROUNDED_ENABLED = '1'
    delete process.env.DAILY_REPORT_GROUNDED_MODEL
    assert.throws(readGroundedReportConfiguration, /明确配置/); assert.equal(calls.length, 0)
    process.env.DAILY_REPORT_GROUNDED_MODEL = 'glm-5.3-flash'
    if (!boundariesOnly) {
    append(4100, 'initial-', period.cutoffMs - 3 * 3600000)
    const cold = await execute('grounded-cold'), coldCalls = calls.length
    coldClassifications = calls.filter(value => value.items).length
    assert.equal(cold.analysisVersion, 'grounded-report-1'); assert.equal(cold.analysis.meta.evidence.processedMessageCount, 4000)
    assert.equal(cold.analysis.meta.windowMessageCount, 4100); assert.equal(cold.analysis.meta.evidence.unprocessedMessageCount, 0)
    assert.equal(cold.analysisStorage.crossTaskCacheEligible, true); assert(cold.analysisStorage.snapshotCommit && cold.analysisStorage.catalogCommit)
    assert.equal(cold.analysis.meta.periodBackfilled, false)
    const saved = JSON.parse(fs.readFileSync(path.join(getTaskResultDir('grounded-cold'), 'result.json')))
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.analysisPath)).audit, cold.analysis.audit); assert.deepEqual(saved.analysisStorage, cold.analysisStorage)
    console.log(JSON.stringify({ phase: 'cold_complete', actualHttpRequests: coldCalls, classifiedBatches: coldClassifications }))
    const hot = await execute('grounded-hot')
    assert.equal(calls.length, coldCalls); assert.equal(hot.analysis.meta.requestCount, 0)
    assert.equal(hot.analysis.audit.classificationCache.length, coldClassifications); assert(hot.analysis.audit.stageCache.length)
    assert.deepEqual(hot.analysis.topics, cold.analysis.topics); assert.deepEqual(hot.analysis.goldenQuotes, cold.analysis.goldenQuotes)
    console.log(JSON.stringify({ phase: 'hot_complete', newHttpRequests: calls.length - coldCalls }))
    append(5, 'append-', period.cutoffMs - 30 * 60000)
    const before = calls.length, slide = await execute('grounded-slide')
    slideClassifications = calls.slice(before).filter(value => value.items).length
    assert(slideClassifications > 0 && slideClassifications < coldClassifications)
    assert.equal(slide.analysis.meta.windowMessageCount, 4105); assert.equal(slide.analysis.meta.evidence.processedMessageCount, 4000)
    console.log(JSON.stringify({ phase: 'slide_complete', newClassificationRequests: slideClassifications }))
    }
    for (const variant of ['two', 'images', 'no-records']) {
      const channel = 'display-' + variant
      if (variant !== 'no-records') for (let index = 0; index < 4; index++) records.appendReportRecord(period.reportDate, channel, {
        messageId: channel + index, timestamp: period.cutoffMs - 10000 + index * 1000, userId: 'a', userName: '甲', text: variant === 'images' ? '[图片]' : '独立讨论' + index,
      })
      mode = variant; const beforeCalls = calls.length, value = await execute('grounded-' + variant, { channel, detail: false })
      if (variant === 'no-records') { assert.equal(value.reason, 'no_report_data'); assert.equal(calls.length, beforeCalls) }
      else { assert.equal(value.analysis.topics.length, variant === 'two' ? 2 : 0); assert.equal(value.analysis.meta.evidence.unprocessedMessageCount, 0) }
      mode = 'normal'
    }
    // 新任务上游需变化才触发请求，失票据/重启取消/超时均不接受迟到模型。
    for (const failureMode of ['lease', 'cancel', 'deadline']) {
      const channel = 'failure-' + failureMode
      records.appendReportRecord(period.reportDate, channel, { messageId: channel, timestamp: period.cutoffMs - 1000, userId: 'a', userName: '甲', text: '失败边界原文' })
      mode = failureMode; const oldClock = clock, previousCalls = calls.length
      await assert.rejects(execute('grounded-' + failureMode, { channel }), failureMode === 'lease' ? /S0独占租约已失效/ : failureMode === 'cancel' ? /取消|领取/ : /时限|超时/)
      assert.equal(calls.length, previousCalls + 1)
      const file = path.join(getTaskResultDir('grounded-' + failureMode), 'result.json')
      assert(!fs.existsSync(file) || JSON.parse(fs.readFileSync(file)).ok === false)
      clock = oldClock; mode = 'normal'
    }
    for (const boundary of ['snapshot', 'unit']) {
      PagedReportStore.prototype.commit = function(kind, ...args) { if (boundary === 'snapshot' && kind === 'snapshot') throw Error('fixture snapshot write failed'); return commit.call(this, kind, ...args) }
      PagedReportStore.prototype.writeTaskArtifact = function(...args) { if (boundary === 'unit') throw Error('fixture unit write failed'); return write.apply(this, args) }
      const channel = 'disk-' + boundary
      records.appendReportRecord(period.reportDate, channel, { messageId: channel, timestamp: period.cutoffMs - 1000, userId: 'a', userName: '甲', text: '实际持久化边界' })
      await assert.rejects(execute('grounded-' + boundary, { channel }), /write failed/)
      const file = path.join(getTaskResultDir('grounded-' + boundary), 'result.json')
      assert.equal(JSON.parse(fs.readFileSync(file)).ok, false)
      PagedReportStore.prototype.commit = commit; PagedReportStore.prototype.writeTaskArtifact = write
    }
    const collector = require('../../../koishi-plugin-daily-report/lib/data-collector'), collect = collector.collectReportData
    collector.collectReportData = (channel, window, onSource) => collect(channel, window, (message, record) => onSource(message, { ...record, recordVersion: 1 }))
    const trustChannel = 'untrusted-window'
    records.appendReportRecord(period.reportDate, trustChannel, { messageId: 'trust', timestamp: period.cutoffMs - 1000, userId: 'a', userName: '甲', text: '来源完整性不可冒认' })
    try {
      const value = await execute('grounded-untrusted', { channel: trustChannel, detail: false })
      assert.equal(value.analysisStorage.crossTaskCacheEligible, false); assert.equal(value.analysisStorage.catalogCommit, null)
      assert.equal(value.analysis.meta.evidence.processedMessageCount, 1)
    } finally { collector.collectReportData = collect }
    const rename = fs.renameSync, finalFile = path.join(getTaskResultDir('grounded-final-write'), 'result.json')
    fs.renameSync = (source, target) => { if (target === finalFile) throw Error('fixture final result write failed'); return rename(source, target) }
    try {
      const channel = 'final-write-channel'
      records.appendReportRecord(period.reportDate, channel, { messageId: channel, timestamp: period.cutoffMs - 1000, userId: 'a', userName: '甲', text: '最终提交实际失败边界' })
      await assert.rejects(execute('grounded-final-write', { channel }), /final result write failed/)
      assert(!fs.existsSync(finalFile))
    } finally { fs.renameSync = rename }
    assert(listPagedStoreFiles(path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'daily-analysis')).length > 10)
    console.log(JSON.stringify({ actualS0S2: true, completeWindow4100Selected4000: !boundariesOnly, fullAuditStored: !boundariesOnly, dedicatedModel: true,
      hotZeroRequests: !boundariesOnly, slidingReusesMiddle: !boundariesOnly, slideClassifications, coldClassifications, leaseReplacementRejected: true,
      restartLateRejected: true, originalDeadline: true, requiredStorageFailure: true, finalWriteFailure: true, zeroOneTwoTopics: true,
      untrustedWindowNoCatalog: true, noNotification: true }))
  } finally {
    global.fetch = originalFetch; PagedReportStore.prototype.commit = commit; PagedReportStore.prototype.writeTaskArtifact = write
    require('koishi-plugin-dongxuelian-ai/lib/core/api').flushTokenUsage()
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
