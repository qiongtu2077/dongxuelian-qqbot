/** 随机图片需求时效行为测试：隔离数据、真实跨进程授权读取、模拟模型上游。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { withScenario } = require('./scenarios/_setup')
const { AI_ROOT } = require('./fake/file')
const { mockFetch } = require('./fake/fetch')
const { seedCapabilityConfig } = require('./helpers/ai-capability-fixture')
const LIB = path.join(AI_ROOT, 'lib')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
let passed = 0

// 单项失败立即退出，不把后续通过项冲淡失败证据。
function check(label, value) { assert.ok(value, label); passed++; console.log('OK ' + label) }

// 为已保存目标准备可读原图，避免测试访问远端图片地址。
async function prepareTarget(id = 'target') {
  const store = require(path.join(LIB, 'media/image/image-store'))
  await store.storeImageUrl('10001', id, 'https://example.test/image.jpg', '')
  await store.cacheImageFile('10001', id, PNG)
  return store
}

// 跨进程只读授权，验证后台不能依赖主进程内存 Map。
function childAuthorizationValid(dataDir, authorization) {
  const script = `process.stdout.write(String(require(${JSON.stringify(path.join(LIB, 'media/image/image-random-demand'))}).isRandomImageDemandValid('10001','target',${JSON.stringify(authorization)})))`
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dataDir }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout === 'true'
}

// 模拟模型请求并总是恢复全局 fetch。
async function withFetch(mocked, fn) {
  const previous = global.fetch
  global.fetch = mocked.fetch
  try { await fn() } finally { global.fetch = previous }
}

// 验证授权的目标、窗口、跨进程读取和既有随机状态撤销入口。
async function testAuthorizationLifecycle() {
  await withScenario({}, async ({ data }) => {
    const authorization = require(path.join(LIB, 'media/image/image-random-demand'))
    const state = require(path.join(LIB, 'behavior/random-state'))
    state.bumpChannelMessageVersion('10001')
    check('普通频道消息不创建随机图片授权文件', !fs.existsSync(data.pathFor('random-image-demands')))
    const token = authorization.createRandomImageDemand('10001', 'target', Date.now() + 55000)
    check('有效授权能被真实子进程读取', childAuthorizationValid(data.dataDir, token))
    check('授权不能改换原图片或频道', !authorization.isRandomImageDemandValid('10001', 'another', token) && !authorization.isRandomImageDemandValid('another', 'target', token))
    state.bumpChannelMessageVersion('10001')
    check('新消息使已排队授权在子进程失效', !childAuthorizationValid(data.dataDir, token))
    for (const [label, cancel] of [
      ['明确交互', () => state.bumpExplicitInteractionVersion('10001')],
      ['取消随机回复', () => state.cancelPendingRandom('10001')],
      ['静默', () => state.muteRandomChannel('10001')],
      ['插件停止', () => state.clearRandomPendingState()],
    ]) {
      const current = authorization.createRandomImageDemand('10001', 'target', Date.now() + 50000)
      cancel()
      check(`${label}撤销随机图片需求`, !authorization.isRandomImageDemandValid('10001', 'target', current))
    }
    check('过期或超过既有六十秒的授权不能创建', !authorization.createRandomImageDemand('10001', 'target', Date.now() - 1) && !authorization.createRandomImageDemand('10001', 'target', Date.now() + 61000))
    const expiring = authorization.createRandomImageDemand('10001', 'target', Date.now() + 100)
    const realNow = Date.now
    Date.now = () => expiring.expiresAt + 1
    try {
      check('授权读取即时拒绝过期需求', !authorization.isRandomImageDemandValid('10001', 'target', expiring))
      authorization.cleanupRandomImageDemands()
      check('维护周期回收过期授权文件', fs.readdirSync(data.pathFor('random-image-demands')).length === 0)
    } finally { Date.now = realNow }
  })
}

// 历史消息编号只能指向有效记录，不能用 URL 复活或替换已选原图。
async function testOriginalIdentity() {
  await withScenario({}, async () => {
    const store = await prepareTarget()
    const tool = require(path.join(LIB, 'agent/tools/analyze-image'))
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    await store.storeImageUrl('10001', 'expired', 'https://example.test/old.jpg', '', { ts: Date.now() - 3 * 60 * 60 * 1000 })
    const missing = await tool.execute({ messageId: 'expired', url: 'https://example.test/old.jpg', question: '看图', force: true }, { channelKey: '10001' })
    check('过期编号加URL不能复活历史图片', missing.includes('过期') && !await store.getImageEntry('10001', 'expired') && queue.listPendingMediaTasks('media_image_analysis', 10).length === 0)
    await tool.execute({ messageId: 'target', url: 'https://example.test/another.jpg', question: '看原图', force: true }, { channelKey: '10001' })
    check('历史编号配不同URL仍绑定有效原图来源', queue.listPendingMediaTasks('media_image_analysis', 10)[0]?.url === 'https://example.test/image.jpg')
  })
}

// 工具入队受既有时效保护，取消的随机队列项不能吞掉新历史需求。
async function testToolAndQueueAuthorization() {
  await withScenario({}, async () => {
    const store = await prepareTarget()
    await store.markAnalyzed('10001', 'target', '图中是一只猫。')
    const tools = require(path.join(LIB, 'chat/chat-tools'))
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    const state = require(path.join(LIB, 'behavior/random-state'))
    const worker = require(path.join(LIB, 'resource-workers/media-worker'))
    const tc = { function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: 'target', question: '右下角完整文字', force: true }) } }
    const context = { channelKey: '10001', randomTriggered: true, selectedImageMessageId: 'target', randomImageExpiresAt: Date.now() + 55000 }
    const stale = await tools.executeChatTool(tc, { ...context, isImageReplyFresh: () => false })
    check('过时模型返回的工具调用不会新增分析任务', stale.includes('过时') && queue.listPendingMediaTasks('media_image_analysis', 10).length === 0)
    await tools.executeChatTool(tc, { ...context, isImageReplyFresh: () => true })
    const randomTask = queue.listPendingMediaTasks('media_image_analysis', 10)[0]
    check('获准随机需求携带授权且队列不延长回复时效', randomTask?.payload.imageDemand.randomAuthorization?.token && Date.parse(randomTask.expiresAt) === context.randomImageExpiresAt)
    state.bumpChannelMessageVersion('10001')
    const mocked = mockFetch([])
    await withFetch(mocked, async () => {
      const result = await worker.runClaimedMediaTask(randomTask)
      check('已排队随机需求撤销后后台消费为零模型', result.ok === false && mocked.calls.length === 0)
      const cancelled = await store.getImageEntry('10001', 'target')
      check('取消的图片需求结束pending且保留旧摘要', cancelled.analysisStatus === 'cancelled' && cancelled.analysis.includes('猫'))
    })
    await tools.executeChatTool(tc, { channelKey: '10001' })
    const tasks = queue.listPendingMediaTasks('media_image_analysis', 10)
    check('失效随机项不阻挡同图同问题的新历史需求', tasks.length === 2 && tasks.some(task => task.payload.imageDemand.source === 'history-tool' && task.id !== randomTask.id))
  })
}

// 有效授权必须仍能让真实媒体执行链识图，不能靠一律拒绝获得零调用。
async function testAuthorizedWorker() {
  await withScenario({}, async () => {
    const store = await prepareTarget()
    const authorization = require(path.join(LIB, 'media/image/image-random-demand'))
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    const worker = require(path.join(LIB, 'resource-workers/media-worker'))
    const randomAuthorization = authorization.createRandomImageDemand('10001', 'target', Date.now() + 55000)
    const payload = queue.buildImageAnalysisPayload({ source: 'random-image', question: '完整文字', force: true, randomAuthorization })
    await store.markAnalysisPending('10001', 'target')
    const mocked = mockFetch([{ json: { choices: [{ message: { content: '图片右下角完整写着欢迎光临。' } }] } }])
    await withFetch(mocked, async () => {
      const result = await worker.runClaimedMediaTask({ id: 'valid-random-task', kind: 'media_image_analysis', channelKey: '10001', messageId: 'target', payload })
      check('有效随机授权通过媒体工作进程实际发出一次视觉请求', result.ok === true && mocked.calls.length === 1 && mocked.calls[0].requestBody.model === 'glm-4.6v-flash')
      check('细节识图成功后不永久保留pending', (await store.getImageEntry('10001', 'target')).analysisStatus === 'completed')
    })
  })
}

// 第一轮模型等待期间已有新消息，返回的图片工具调用不能再登记后台模型工作。
async function testStaleChatToolResult() {
  await withScenario({}, async ({ makeSession, harness }) => {
    await prepareTarget()
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    const state = require(path.join(LIB, 'behavior/random-state'))
    const session = makeSession({ messageId: 'target', content: '<img src="https://example.test/image.jpg"/>', event: { message: [{ type: 'image', data: { url: 'https://example.test/image.jpg' } }] } })
    require(path.join(LIB, 'media/image/vision')).prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
    const mocked = mockFetch([{ json: { choices: [{ message: { content: null, tool_calls: [{ id: 'stale-image-tool', type: 'function', function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: 'target', question: '小字是什么', force: true }) } }] } }] } }])
    const originalMockFetch = mocked.fetch
    mocked.fetch = async (...args) => { state.bumpChannelMessageVersion('10001'); return originalMockFetch(...args) }
    await withFetch(mocked, async () => {
      await require(path.join(LIB, 'chat')).chat(session, '[图片]', harness.ctx, { randomTriggered: true, isImageReplyFresh: () => state.getChannelMessageVersion('10001') === 0, randomImageExpiresAt: Date.now() + 55000 })
      check('真实聊天工具流在等待期间失效后不再登记识图', queue.listPendingMediaTasks('media_image_analysis', 10).length === 0 && mocked.calls.length === 1)
    })
  })
}

// 下载完成后新消息使授权失效，分析器必须在出站边界重新检查。
async function testCancellationAfterImageRead() {
  await withScenario({}, async () => {
    await prepareTarget()
    const authorization = require(path.join(LIB, 'media/image/image-random-demand'))
    const state = require(path.join(LIB, 'behavior/random-state'))
    const source = require(path.join(LIB, 'media/image/image-source'))
    const originalRead = source.readImageSource
    source.readImageSource = async (...args) => { const result = await originalRead(...args); state.bumpChannelMessageVersion('10001'); return result }
    const analyzerFile = path.join(LIB, 'media/image/image-analyzer')
    delete require.cache[require.resolve(analyzerFile)]
    const analyzer = require(analyzerFile)
    const randomAuthorization = authorization.createRandomImageDemand('10001', 'target', Date.now() + 55000)
    const mocked = mockFetch([])
    try {
      await withFetch(mocked, async () => {
        const result = await analyzer.analyzeImageNow('10001', 'target', { source: 'random-image', question: '小字', force: true, randomAuthorization })
        check('取图完成期间失效不会发出首个视觉请求', result === null && mocked.calls.length === 0)
      })
    } finally { source.readImageSource = originalRead }
  })
}

// 首节点失败期间失效时，后台与即时随机回复都不能再调用备用视觉节点。
async function testFallbackCancellation() {
  for (const entry of ['worker', 'chat']) {
    await withScenario({}, async ({ data, makeSession, harness }) => {
      await prepareTarget()
      seedCapabilityConfig(data, { text: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], vision: [{ provider: 'glm', model: 'glm-4.6v-flash' }, { provider: 'openai', model: 'gpt-4o-mini' }] })
      require(path.join(LIB, 'core/runtime-config')).resetConfigCache()
      const state = require(path.join(LIB, 'behavior/random-state'))
      const authorization = require(path.join(LIB, 'media/image/image-random-demand'))
      const randomAuthorization = authorization.createRandomImageDemand('10001', 'target', Date.now() + 55000)
      const mocked = mockFetch([{ status: 500, text: 'test upstream failure' }, { json: { choices: [{ message: { content: 'must-not-run' } }] } }])
      const originalMockFetch = mocked.fetch
      mocked.fetch = async (...args) => { state.bumpChannelMessageVersion('10001'); return originalMockFetch(...args) }
      await withFetch(mocked, async () => {
        if (entry === 'worker') {
          const analyzer = require(path.join(LIB, 'media/image/image-analyzer'))
          await analyzer.analyzeImageNow('10001', 'target', { source: 'random-image', question: '完整文字', force: true, randomAuthorization })
        } else {
          const session = makeSession({ messageId: 'target', content: '<img src="https://example.test/image.jpg"/>', event: { message: [{ type: 'image', data: { url: 'https://example.test/image.jpg' } }] } })
          require(path.join(LIB, 'media/image/vision')).prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
          await assert.rejects(require(path.join(LIB, 'chat')).chat(session, '[图片]', harness.ctx, { randomTriggered: true, isImageReplyFresh: () => state.getChannelMessageVersion('10001') === 0, randomImageExpiresAt: randomAuthorization.expiresAt }), /随机图片话题已过时/)
        }
        check(`${entry}首节点等待期间失效不调用备用视觉模型`, mocked.calls.length === 1 && mocked.calls[0].requestBody.model === 'glm-4.6v-flash')
        check(`${entry}授权和回调不会发送给模型上游`, !Object.keys(mocked.calls[0].requestBody).some(key => key.startsWith('_') || key === 'randomAuthorization'))
      })
    })
  }
}

// 多个已登记需求不能相互覆盖排队状态，最后一个失败也须保留既有摘要。
async function testAnalysisStatusSettlement() {
  await withScenario({}, async () => {
    const store = await prepareTarget()
    await store.markAnalyzed('10001', 'target', '图中是一只猫。')
    const tools = require(path.join(LIB, 'chat/chat-tools'))
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    const worker = require(path.join(LIB, 'resource-workers/media-worker'))
    for (const question of ['读取上方文字', '读取下方文字']) await tools.executeChatTool({ function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: 'target', question, force: true }) } }, { channelKey: '10001' })
    const mocked = mockFetch([{ status: 400, text: 'controlled failure' }, { status: 400, text: 'controlled failure' }])
    await withFetch(mocked, async () => {
      const first = queue.claimNextMediaTask('test-status', 'media_image_analysis')
      queue.completeMediaTask(first, await worker.runClaimedMediaTask(first))
      check('旧需求失败不覆盖另一需求的pending', (await store.getImageEntry('10001', 'target')).analysisStatus === 'pending')
      const second = queue.claimNextMediaTask('test-status', 'media_image_analysis')
      queue.completeMediaTask(second, await worker.runClaimedMediaTask(second))
      const failed = await store.getImageEntry('10001', 'target')
      check('最后需求失败明确呈现且不清除客观摘要', failed.analysisStatus === 'failed' && failed.analyzed && failed.analysis.includes('猫'))
      const history = await tools.executeChatTool({ function: { name: 'read_image_history', arguments: '{}' } }, { channelKey: '10001' })
      check('图片历史区分已有摘要与本次失败', history.includes('已有摘要') && history.includes('本次识图失败'))
      await store.markAnalysisPending('10001', 'target', () => queue.hasImageAnalysisDemand('10001', 'target'))
      check('工具晚到的pending写入不复活已结束任务', (await store.getImageEntry('10001', 'target')).analysisStatus === 'failed')
    })
  })
  for (const successfulOwner of [false, true]) await withScenario({}, async () => {
    const store = await prepareTarget()
    const authorization = require(path.join(LIB, 'media/image/image-random-demand'))
    const requests = require(path.join(LIB, 'media/image/image-request'))
    const queue = require(path.join(LIB, 'media/backpressure/media-queue'))
    const worker = require(path.join(LIB, 'resource-workers/media-worker'))
    const randomAuthorization = authorization.createRandomImageDemand('10001', 'target', Date.now() + 50000)
    const payload = queue.buildImageAnalysisPayload({ source: 'random-image', question: '小字', force: true, randomAuthorization })
    await store.markAnalysisPending('10001', 'target')
    const owner = await requests.acquireImageRequest('10001', 'target', { source: 'explicit-image', force: true, question: '另一个有效需求' })
    authorization.revokeRandomImageDemand('10001')
    try {
      await worker.runClaimedMediaTask({ id: 'cancelled-with-owner', kind: 'media_image_analysis', channelKey: '10001', messageId: 'target', payload })
      check('取消旧任务不覆盖另一入口持有者的pending', (await store.getImageEntry('10001', 'target')).analysisStatus === 'pending')
    } finally {
      if (owner.status === 'owned') {
        if (successfulOwner) await owner.complete('完整文字是欢迎光临。')
        await owner.release()
      }
    }
    check(`保护中的即时请求${successfulOwner ? '完成细节' : '失败'}后最终结算pending`, (await store.getImageEntry('10001', 'target')).analysisStatus === (successfulOwner ? 'completed' : 'failed'))
  })
}

// 执行所有隔离测试并输出确定的完成数量。
async function main() {
  await testAuthorizationLifecycle()
  await testOriginalIdentity()
  await testToolAndQueueAuthorization()
  await testAuthorizedWorker()
  await testStaleChatToolResult()
  await testCancellationAfterImageRead()
  await testFallbackCancellation()
  await testAnalysisStatusSettlement()
  console.log(`image-random-demand: ${passed} passed`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
