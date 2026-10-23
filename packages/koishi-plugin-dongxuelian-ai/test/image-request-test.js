/** 按需图片识别协调行为测试：使用临时数据、模拟上游和真实子进程文件竞争。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createTestDataDir, withDataEnv, AI_ROOT } = require('./fake/file')
const { mockFetch } = require('./fake/fetch')
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const LIB = path.join(AI_ROOT, 'lib')

// 在独立进程中争用同一目标，模型执行段使用文件计数且不访问网络。
async function childMain() {
  const { acquireImageRequest } = require(path.join(LIB, 'media/image/image-request'))
  const request = await acquireImageRequest('cross-request', 'same-image', { source: 'history-tool', question: '读取编号', force: true })
  if (request.status === 'owned') {
    try {
      fs.appendFileSync(path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'request-attempts.txt'), `${process.pid}\n`)
      await new Promise(resolve => setTimeout(resolve, 180))
      await request.complete('编号：1234567890')
    } finally { await request.release() }
  }
  assert.ok(['owned', 'reused'].includes(request.status))
  process.stdout.write(request.status)
}

// 等待真实竞争子进程结束，传播非零退出而不以部分输出认定通过。
function runChild(dataDir, mode = '--child') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, mode], {
      env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`child failed ${code}: ${errors}`)))
  })
}

// 模拟持锁后的记录复检抛错，验证领取端在交出所有权之前也能完整回收。
async function acquisitionFailureMain() {
  const store = require(path.join(LIB, 'media/image/image-store'))
  const originalGetImageEntry = store.getImageEntry
  let reads = 0
  store.getImageEntry = async (...args) => {
    if (++reads === 2) throw new Error('injected image entry read failure')
    return originalGetImageEntry(...args)
  }
  try {
    const { acquireImageRequest } = require(path.join(LIB, 'media/image/image-request'))
    await assert.rejects(acquireImageRequest('acquisition-failure', 'image', { source: 'history-tool' }), /injected image entry read failure/)
    const locks = fs.readdirSync(path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'image-analysis-requests'), { recursive: true }).filter(name => name.endsWith('.lock'))
    assert.equal(locks.length, 0)
    const retry = await acquireImageRequest('acquisition-failure', 'image', { source: 'history-tool', waitMs: 0 })
    assert.equal(retry.status, 'owned')
    await retry.release()
    process.stdout.write('released-and-retried')
  } finally { store.getImageEntry = originalGetImageEntry }
}

// 在申请创建目录后的记录等待点真正执行维护，验证目录保留且等价请求只调用一次模型。
async function cleanupRaceMain() {
  const data = createTestDataDir()
  const restoreEnv = withDataEnv(data.dataDir)
  const previousFetch = global.fetch
  const store = require(path.join(LIB, 'media/image/image-store'))
  const originalGetImageEntry = store.getImageEntry
  let coordinator
  let cleanupRan = false
  const statuses = []
  const channelDir = data.pathFor('image-analysis-requests', require('crypto').createHash('sha256').update('cleanup-race').digest('hex'))
  try {
    await store.storeImageUrl('cleanup-race', 'image', 'https://example.test/image.png', null)
    await store.cacheImageFile('cleanup-race', 'image', PNG)
    store.getImageEntry = async (...args) => {
      const entry = await originalGetImageEntry(...args)
      if (!cleanupRan) {
        cleanupRan = true
        assert.deepEqual(fs.readdirSync(channelDir), [])
        await coordinator.cleanupImageRequests()
        assert.ok(fs.existsSync(channelDir))
      }
      return entry
    }
    coordinator = require(path.join(LIB, 'media/image/image-request'))
    const acquire = coordinator.acquireImageRequest
    coordinator.acquireImageRequest = async (...args) => {
      const request = await acquire(...args)
      statuses.push(request.status)
      return request
    }
    const { analyzeImageNow } = require(path.join(LIB, 'media/image/image-analyzer'))
    const mocked = mockFetch([{ json: { choices: [{ message: { content: '底部编号是12345。' } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } }])
    global.fetch = mocked.fetch
    const options = { source: 'history-tool', question: '读取底部编号', force: true }
    const first = await analyzeImageNow('cleanup-race', 'image', options)
    const repeated = await analyzeImageNow('cleanup-race', 'image', options)
    assert.equal(cleanupRan, true)
    assert.deepEqual(statuses, ['owned', 'reused'])
    assert.equal(first, '底部编号是12345。')
    assert.equal(repeated, first)
    assert.equal(mocked.calls.length, 1)
    assert.ok(fs.readdirSync(channelDir).every(name => !name.endsWith('.lock') && !name.endsWith('.tmp')))
    process.stdout.write('cleanup-owned-released-reused-one-model')
  } finally {
    store.getImageEntry = originalGetImageEntry
    global.fetch = previousFetch
    require(path.join(LIB, 'core/api')).flushTokenUsage()
    restoreEnv()
    data.cleanup()
  }
}

// 验证真实协调器、分析器与 API 计数，模型响应以模拟 HTTP 返回。
async function main() {
  const data = createTestDataDir()
  const restoreEnv = withDataEnv(data.dataDir)
  const previousFetch = global.fetch
  let passed = 0
  // 单个断言失败立即抛出，最终只报告完整通过数量。
  const check = (label, value) => { assert.ok(value, label); passed++; console.log('OK ' + label) }
  try {
    const store = require(path.join(LIB, 'media/image/image-store'))
    const { acquireImageRequest, cleanupImageRequests } = require(path.join(LIB, 'media/image/image-request'))
    const { analyzeImageNow } = require(path.join(LIB, 'media/image/image-analyzer'))
    const { readImageRequestDiagnostic } = require(path.join(LIB, 'core/request-diagnostics'))
    await store.storeImageUrl('request', 'image', 'https://example.test/image.png', null)
    await store.cacheImageFile('request', 'image', PNG)
    const first = await acquireImageRequest('request', 'image', { source: 'explicit-image', question: '看图' })
    check('有效明确邀请获得识图所有权', first.status === 'owned')
    const pending = await acquireImageRequest('request', 'image', { source: 'history-tool', question: '看图', waitMs: 0 })
    check('同图已有活请求时不重复发起', pending.status === 'pending')
    await first.release()
    const next = await acquireImageRequest('request', 'image', { source: 'random-image' })
    check('异常或取消释放后可重试，不缓存失败', next.status === 'owned')
    await store.markAnalyzed('request', 'image', '图中有一只白猫。')
    await next.complete('图中有一只白猫。')
    await next.release()
    const reused = await acquireImageRequest('request', 'image', { source: 'history-tool', question: '概括' })
    check('跨入口复用足够的客观摘要', reused.status === 'reused' && reused.analysis.includes('白猫'))
    const fullText = '图片文字：' + '1234567890'.repeat(35)
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: fullText } }], usage: { prompt_tokens: 11, completion_tokens: 12, total_tokens: 23 } } },
      { json: { choices: [{ message: { content: '图中右下角的编号是9876543210。' } }], usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } } },
    ])
    global.fetch = mocked.fetch
    const detail = await analyzeImageNow('request', 'image', { source: 'history-tool', question: '完整读取全部文字', force: true })
    check('细节问题读取原图，完整结果不被120字摘要截断', detail === fullText && detail.length > 120 && mocked.calls.length === 1)
    check('细节识别不覆盖原来的客观概括', (await store.getCachedAnalysis('request', 'image')).includes('白猫'))
    const repeated = await analyzeImageNow('request', 'image', { source: 'history-tool', question: '完整读取全部文字', force: true })
    check('等价细节问题复用结果不再次调用模型', repeated === fullText && mocked.calls.length === 1)
    const changed = await analyzeImageNow('request', 'image', { source: 'history-tool', question: '右下角编号是什么', force: true })
    check('不同细节问题不被旧摘要和旧问题缓存吞掉', changed.includes('9876543210') && mocked.calls.length === 2)
    const body = JSON.parse(mocked.calls[0].options.body)
    check('模型实际收到当前问题和原图', body.messages[0].content[0].text.includes('完整读取全部文字') && body.messages[0].content[1].type === 'image_url')
    check('请求诊断元数据不会发给上游', !('_imageRequest' in body))
    require(path.join(LIB, 'core/api')).flushTokenUsage()
    const usage = data.readJson('token-usage.json')
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    check('实际尝试归入视觉用量，摘要复用不增加请求', usage[day].capabilities.vision.requests === 2 && !usage[day].capabilities.text)
    check('没有有效来源的旧分析调用不会请求模型', await analyzeImageNow('request', 'image') === null && mocked.calls.length === 2)
    check('无有效图片不能获得识别所有权', (await acquireImageRequest('missing', 'image', { source: 'history-tool' })).status === 'unavailable')
    await store.storeImageUrl('other-request', 'image', 'https://example.test/other.png', null)
    const other = await acquireImageRequest('other-request', 'image', { source: 'history-tool' })
    check('同消息编号不同频道不复用结果', other.status === 'owned')
    await other.release()
    await store.storeImageUrl('acquisition-failure', 'image', 'https://example.test/failure.png', null)
    check('持锁复检抛错后释放所有权，存活进程可立即重试', await runChild(data.dataDir, '--acquisition-failure') === 'released-and-retried')
    check('申请等待记录时并发维护保留工作目录，正常领取释放且等价需求仅调用一次模型', await runChild(data.dataDir, '--cleanup-race') === 'cleanup-owned-released-reused-one-model')
    await store.storeImageUrl('cross-request', 'same-image', 'https://example.test/cross.png', null)
    const childResults = await Promise.all([runChild(data.dataDir), runChild(data.dataDir), runChild(data.dataDir)])
    const attempts = fs.readFileSync(data.pathFor('request-attempts.txt'), 'utf8').trim().split('\n')
    check('三个独立进程同图同问题只执行一次识别', attempts.length === 1 && childResults.filter(value => value === 'owned').length === 1 && childResults.filter(value => value === 'reused').length === 2)
    const diagnosticsDir = data.pathFor('ai-call-diagnostics')
    const events = fs.readdirSync(diagnosticsDir).filter(name => /^image-demand-.*\.jsonl$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(diagnosticsDir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    check('业务需求与摘要/细节复用分别留痕', events.some(event => event.source === 'explicit-image') && events.some(event => event.source === 'random-image') && events.some(event => event.event === 'reused' && event.cache === 'detail'))
    check('来源诊断不含原始问题、图片地址或用户消息', !JSON.stringify(events).includes('完整读取') && !JSON.stringify(events).includes('https://') && events.every(event => /^[a-f0-9]{64}$/.test(event.target)))
    const modelEvents = fs.readdirSync(diagnosticsDir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(diagnosticsDir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    check('每次实际上游尝试关联业务来源和脱敏目标', modelEvents.length === 2 && modelEvents.every(event => event.capability === 'vision' && event.imageSource === 'history-tool' && event.imageDemandId))
    check('未知来源和未脱敏身份不进入诊断', readImageRequestDiagnostic({ source: 'passive', target: 'secret-url', demandId: 'user-text' }) === null)
    const history = data.readJson('image-history/request.json')
    history.images.image.ts = Date.now() - 2 * 3600000 - 1
    data.writeJson('image-history/request.json', history)
    check('过期图片即使有问题缓存也拒绝复用和识别', (await acquireImageRequest('request', 'image', { source: 'history-tool', question: '完整读取全部文字', force: true })).status === 'unavailable')
    await cleanupImageRequests()
    const resultFiles = fs.readdirSync(data.pathFor('image-analysis-requests'), { recursive: true }).filter(name => name.endsWith('.json'))
    check('周期维护清理过期问题结果且保留其他有效图', resultFiles.length === 1)
    console.log(`image-request summary: passed=${passed}, failed=0`)
  } finally {
    global.fetch = previousFetch
    require(path.join(LIB, 'core/api')).flushTokenUsage()
    restoreEnv()
    data.cleanup()
  }
}

(process.argv[2] === '--child' ? childMain() : process.argv[2] === '--acquisition-failure' ? acquisitionFailureMain() : process.argv[2] === '--cleanup-race' ? cleanupRaceMain() : main()).catch(error => { console.error(error.stack || error); process.exitCode = 1 })
