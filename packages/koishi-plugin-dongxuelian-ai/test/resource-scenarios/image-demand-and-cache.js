/**
 * 图片缓存与按需分析的资源行为验证。
 * 使用临时数据和模拟模型；覆盖后台消费、旧任务切换、需求去重和资源保护。
 */
'use strict'

const { check, createTempDataDir, runScenario } = require('../helpers/resource-harness')

// 驱动普通入站、旧 pending 与旧 claimed 任务，证明消费后仍不会调用模型。
function testPassiveAndLegacyImagesOnlyCache() {
  const summary = runScenario('image passive and legacy cache', String.raw`
const Module = require('module')
let modelCalls = 0
const cachedTargets = []
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (String(request).endsWith('/image-analyzer')) return { analyzeImageNow: async () => { modelCalls++; return 'unexpected' } }
  if (String(request).endsWith('/image-source')) return { readImageSource: async (channelKey, messageId) => { cachedTargets.push([channelKey, messageId]); return messageId === 'failed-cache' ? null : 'data:image/png;base64,eA==' } }
  return originalLoad.apply(this, arguments)
}
const incoming = require('koishi-plugin-dongxuelian-ai/lib/message/incoming-message-flow')
const queue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')
const store = require('koishi-plugin-dongxuelian-ai/lib/media/image/image-store')
Module._load = originalLoad
async function run() {
  await incoming.handleIncomingMessageArtifacts({
    ctx: null, channelKey: 'group-cache', plain: '', content: '<img src="https://example.test/image.png"/>',
    analyzed: { hasVisual: true }, queueMedia: false,
    session: { userId: 'user', channelId: 'group-cache', messageId: 'ordinary', event: { message: [{ type: 'image', data: { url: 'https://example.test/image.png' } }] }, elements: [{ type: 'image', data: { url: 'https://example.test/image.png' } }] },
  })
  await incoming.handleIncomingMessageArtifacts({
    ctx: null, channelKey: 'group-cache', plain: '', content: '', analyzed: { hasVisual: true },
    session: { userId: 'user', channelId: 'group-cache', messageId: 'multiple', event: { message: [{ type: 'image', data: { url: 'https://example.test/one.png' } }, { type: 'image', data: { url: 'https://example.test/two.png' } }] } },
  })
  const multiEntry = await store.getImageEntry('group-cache', 'multiple')
  const incomingTasks = queue.listPendingMediaTasks()
  const before = queue.getMediaBackpressureStatus()
  await worker.drainOneMediaTask({ workerName: 'test-cache-worker', gateWaitMs: 0 })
  queue.enqueueMediaTask({ kind: 'media_image_analysis', channelKey: 'group-cache', messageId: 'legacy-pending', payload: { userId: 'user', conversationKey: 'old' } })
  await worker.drainOneMediaTask({ workerName: 'test-cache-worker', gateWaitMs: 0 })
  const claimedResult = await worker.runClaimedMediaTask({ id: 'old-claimed', kind: 'media_image_analysis', channelKey: 'group-cache', messageId: 'legacy-claimed', priority: 80, payload: { userId: 'user' } })
  queue.enqueueMediaTask({ kind: 'media_image_cache', channelKey: 'group-cache', messageId: 'failed-cache' })
  await worker.drainOneMediaTask({ workerName: 'test-cache-worker', gateWaitMs: 0 })
  const failedCacheRetry = queue.enqueueMediaTask({ kind: 'media_image_cache', channelKey: 'group-cache', messageId: 'failed-cache' })
  console.log(JSON.stringify({ modelCalls, cachedTargets, incomingKinds: incomingTasks.map(task => task.kind), before, claimedResult, multiEntry, failedCacheRetry }))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`, {
    DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-image-cache-only-'),
    RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE: '1200', RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE: '1600',
  })
  if (!summary) return
  check('passive image cache survives queueMedia false without analysis', summary.incomingKinds.join(',') === 'media_image_cache', JSON.stringify(summary))
  check('multi-image input does not store or cache its first image as the unique target', summary.multiEntry === null && summary.incomingKinds.length === 1, JSON.stringify(summary))
  check('cache status is separate from pending image analysis', summary.before.imagePending === 0 && summary.before.imageCachePending === 1, JSON.stringify(summary.before))
  check('ordinary, pending legacy, claimed legacy and failed cache tasks never call model', summary.modelCalls === 0 && summary.cachedTargets.length === 4 && summary.claimedResult.mode === 'image_cache', JSON.stringify(summary))
  check('failed cache is not stored as a reusable success or upgraded to image analysis', summary.failedCacheRetry.status === 'pending' && summary.failedCacheRetry.kind === 'media_image_cache' && summary.failedCacheRetry.reused !== true, JSON.stringify(summary.failedCacheRetry))
}

// 验证等价需求合并、频道隔离、细节用途及问题真实传到执行端。
function testImageDemandIdentityAndExecution() {
  const summary = runScenario('image demand identity and execution', String.raw`
const Module = require('module')
const calls = []
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (String(request).endsWith('/image-analyzer')) return { analyzeImageNow: async (channelKey, messageId, options) => { calls.push({ channelKey, messageId, options }); return 'detail answer' } }
  if (String(request).endsWith('/image-source')) return { readImageSource: async () => 'data:image/png;base64,eA==' }
  return originalLoad.apply(this, arguments)
}
const queue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')
Module._load = originalLoad
const base = { kind: 'media_image_analysis', channelKey: 'one', messageId: 'same', url: 'https://example.test/same.png' }
const payload = queue.buildImageAnalysisPayload({ source: 'history-tool', question: '读取右下角文字', force: true })
async function run() {
  const oldTask = queue.enqueueMediaTask({ ...base, payload: { userId: 'old' } })
  const oldClaimed = queue.claimNextMediaTask('legacy-test-worker')
  queue.completeMediaTask(oldClaimed, await worker.runClaimedMediaTask(oldClaimed))
  const task = queue.enqueueMediaTask({ ...base, payload })
  const equal = queue.enqueueMediaTask({ ...base, payload: queue.buildImageAnalysisPayload({ source: 'explicit-image', question: '读取右下角文字', force: true }) })
  const anotherChannel = queue.createMediaHash({ ...base, channelKey: 'two', payload })
  const anotherQuestion = queue.createMediaHash({ ...base, payload: queue.buildImageAnalysisPayload({ source: 'history-tool', question: '读取左上角文字', force: true }) })
  const summaryOnly = queue.createMediaHash({ ...base, payload: queue.buildImageAnalysisPayload({ source: 'history-tool', question: '读取右下角文字', force: false }) })
  await worker.runClaimedMediaTask(task)
  console.log(JSON.stringify({ oldId: oldTask.id, taskId: task.id, equalId: equal.existing && equal.existing.id, taskHash: task.urlHash, anotherChannel, anotherQuestion, summaryOnly, calls, invalid: queue.getImageAnalysisDemand({ imageDemand: { version: 1, source: 'passive', question: '', force: false } }) }))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`, { DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-image-demand-') })
  if (!summary) return
  check('completed legacy cache cannot block new registered demand while equivalent sources merge', summary.oldId !== summary.taskId && summary.equalId === summary.taskId, JSON.stringify(summary))
  check('image hash separates channels, questions and forced original detail purpose', [summary.anotherChannel, summary.anotherQuestion, summary.summaryOnly].every(hash => hash !== summary.taskHash), JSON.stringify(summary))
  check('registered question and force reach image analyzer once', summary.calls.length === 1 && summary.calls[0].channelKey === 'one' && summary.calls[0].messageId === 'same' && summary.calls[0].options.question === '读取右下角文字' && summary.calls[0].options.force === true && summary.calls[0].options.source === 'history-tool', JSON.stringify(summary.calls))
  check('unknown or passive demand source is rejected', summary.invalid === null, JSON.stringify(summary))
}

// 在旧任务取得快照后注入前台写回或新需求，防止迁移覆盖更新后的分析状态。
function testLegacyCachePreservesConcurrentAnalysis() {
  const summary = runScenario('legacy cache preserves concurrent analysis', String.raw`
const Module = require('module')
const store = require('koishi-plugin-dongxuelian-ai/lib/media/image/image-store')
const queue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (String(request).endsWith('/image-source')) return { readImageSource: async () => 'data:image/png;base64,eA==' }
  if (String(request).endsWith('/image-store')) return { ...store, getImageEntry: async (channelKey, messageId) => {
    const snapshot = await store.getImageEntry(channelKey, messageId)
    if (messageId === 'completed-during-migration') await store.markAnalyzed(channelKey, messageId, '一只白猫。')
    if (messageId === 'queued-during-migration') {
      queue.enqueueMediaTask({ kind: 'media_image_analysis', channelKey, messageId, payload: queue.buildImageAnalysisPayload({ source: 'history-tool' }) })
      await store.markAnalysisPending(channelKey, messageId)
    }
    return snapshot
  } }
  return originalLoad.apply(this, arguments)
}
const worker = require('koishi-plugin-dongxuelian-ai/lib/resource-workers/media-worker')
Module._load = originalLoad
async function run() {
  const entries = {}
  for (const messageId of ['legacy-only', 'completed-during-migration', 'queued-during-migration']) {
    await store.storeImageUrl('migration-race', messageId, 'https://example.test/image.png', null)
    await store.markAnalysisPending('migration-race', messageId)
    await worker.runClaimedMediaTask({ id: messageId, kind: 'media_image_analysis', channelKey: 'migration-race', messageId, priority: 80, payload: {} })
    entries[messageId] = await store.getImageEntry('migration-race', messageId)
  }
  console.log(JSON.stringify(entries))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`, { DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-image-migration-race-') })
  if (!summary) return
  check('legacy pending without a new demand becomes recorded', summary['legacy-only'].analysisStatus === 'recorded' && summary['legacy-only'].analyzed === false, JSON.stringify(summary))
  check('legacy migration cannot erase an objective result completed after its snapshot', summary['completed-during-migration'].analyzed === true && summary['completed-during-migration'].analysis === '一只白猫。' && summary['completed-during-migration'].analysisStatus === 'analyzed', JSON.stringify(summary))
  check('legacy migration preserves a newly queued demand pending status', summary['queued-during-migration'].analysisStatus === 'pending' && summary['queued-during-migration'].analyzed === false, JSON.stringify(summary))
}

// 证明缓存遵守自身预算、红线与静默保护，容量和过期也独立于模型分析。
function testImageCacheBudgetCapacityAndExpiry() {
  const summary = runScenario('image cache resource limits', String.raw`
const queue = require('koishi-plugin-dongxuelian-ai/lib/media/backpressure/media-queue')
const { decideAdmission } = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
const { normalizeTaskBudget } = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/task-budget')
const snapshot = { resourceState: 'green', botMode: 'normal', memAvailableMb: 350, locked: false, running: null }
const input = { kind: 'media_image_cache' }
const budget = normalizeTaskBudget(input)
const decisions = [decideAdmission(input, snapshot), decideAdmission(input, { ...snapshot, resourceState: 'red' }), decideAdmission(input, { ...snapshot, botMode: 'report_silent' }), decideAdmission(input, { ...snapshot, locked: true, running: { taskId: 'other' } })].map(item => item.decision)
for (let i = 0; i < 4; i++) queue.enqueueMediaTask({ kind: 'media_image_cache', channelKey: 'one', messageId: String(i) })
const expired = queue.enqueueMediaTask({ kind: 'media_image_cache', channelKey: 'one', messageId: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() })
const pending = queue.listPendingMediaTasks('media_image_cache')
console.log(JSON.stringify({ decisions, budget, pendingIds: pending.map(task => task.messageId), status: queue.getMediaBackpressureStatus(), expiry: expired.expiresAt }))
`, { DONGXUELIAN_AI_DATA_DIR: createTempDataDir('resource-image-cache-limits-'), MEDIA_BACKPRESSURE_IMAGE_CACHE_MAX: '2' })
  if (!summary) return
  check('cache has its own 300MB non-model budget and respects red, report and busy locks', summary.budget.minMemMb === 300 && summary.decisions.join(',') === 'run_now,defer,defer,defer', JSON.stringify(summary))
  check('cache capacity is bounded and expired original timestamps are not extended', summary.pendingIds.length <= 2 && !summary.pendingIds.includes('expired') && summary.status.imagePending === 0 && summary.status.imageCachePending <= 2, JSON.stringify(summary))
}

// 运行图片资源场景组，复用资源回归入口的计数与隔离方式。
function runImageDemandAndCacheScenarios() {
  testPassiveAndLegacyImagesOnlyCache()
  testImageDemandIdentityAndExecution()
  testLegacyCachePreservesConcurrentAnalysis()
  testImageCacheBudgetCapacityAndExpiry()
}

module.exports = { runImageDemandAndCacheScenarios }
