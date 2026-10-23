/** 图片存储与原图来源行为验证；仅使用隔离目录及模拟适配器。 */
const assert = require('assert/strict')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { createHash } = require('crypto')

const ROOT = path.resolve(process.env.IMAGE_STORAGE_TEST_ROOT || path.join(__dirname, '..', 'lib'))
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const CHILD_MODE = process.argv[2] || ''

// 独立开发验证时仅即时转译依赖源码，正式测试默认读取构建产物。
if (path.basename(ROOT) === 'src') {
  const ts = require('typescript')
  require.extensions['.ts'] = (module, filename) => {
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    })
    module._compile(result.outputText, filename)
  }
}

// 在加载来源模块之前安装确定性的原图 API，禁止真实网络和模型请求。
function installApiMock(overrides = {}) {
  const file = require.resolve(path.join(ROOT, 'core', 'api'))
  const calls = { onebot: 0, local: 0, remote: 0, model: 0 }
  const mock = {
    async callGetImage() { calls.onebot++; return null },
    async readImageAsBase64() { calls.local++; return null },
    async downloadImageAsBase64() { calls.remote++; return `data:image/png;base64,${PNG.toString('base64')}` },
    async requestChatCompletions() { calls.model++; throw new Error('model must not run') },
    ...overrides,
  }
  const exported = Object.fromEntries(Object.keys(mock).map(name => [name, (...args) => mock[name](...args)]))
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exported }
  return { calls, mock }
}

// 运行隔离子进程，以真实磁盘竞争验证跨进程合并和原子写入。
function runChild(mode, values, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, mode, ...values], {
      env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dataDir, IMAGE_STORAGE_TEST_ROOT: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`child ${mode} exited ${code}: ${output}`)))
  })
}

// 子进程只进行指定缓存读取或记录写入，并把模拟远端尝试落到计数文件。
async function childMain() {
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  installApiMock({
    async downloadImageAsBase64() {
      fs.appendFileSync(path.join(dataDir, 'download-attempts.txt'), `${process.pid}\n`)
      await new Promise(resolve => setTimeout(resolve, 200))
      return `data:image/png;base64,${PNG.toString('base64')}`
    },
  })
  const store = require(path.join(ROOT, 'media', 'image', 'image-store'))
  if (CHILD_MODE === '--child-store') {
    const start = Number(process.argv[3])
    const count = Number(process.argv[4]) || 5
    for (let index = start; index < start + count; index++) {
      await store.storeImageUrl('cross-write', `image-${index}`, 'https://example.test/image.png', null)
    }
  } else {
    const { readImageSource } = require(path.join(ROOT, 'media', 'image', 'image-source'))
    assert.ok(await readImageSource('cross-source', 'same-image'))
  }
}

// 逐项验证保留、读取、原图生命周期和来源回退，不访问运行数据。
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-storage-'))
  const originalDir = process.env.DONGXUELIAN_AI_DATA_DIR
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  let checks = 0
  const check = (label, value) => { assert.ok(value, label); checks++; console.log(`OK ${label}`) }
  try {
    const { calls, mock } = installApiMock()
    const store = require(path.join(ROOT, 'media', 'image', 'image-store'))
    const { readImageSource, cleanupImageSourceLocks } = require(path.join(ROOT, 'media', 'image', 'image-source'))
    const channelDir = channel => path.join(store.IMAGE_CACHE_DIR, channel)
    const historyFile = channel => path.join(store.IMAGE_HISTORY_DIR, channel + '.json')

    await store.storeImageUrl('retention', 'first', 'https://example.test/first.png', null)
    await store.cacheImageFile('retention', 'first', PNG)
    check('纯缓存保留 recorded 状态且没有摘要', (await store.getImageEntry('retention', 'first')).analysisStatus === 'recorded' && await store.getCachedAnalysis('retention', 'first') === null)
    check('缓存拒绝十兆以上或无记录目标', await store.cacheImageFile('retention', 'first', Buffer.alloc(10 * 1024 * 1024 + 1)) === null && await store.cacheImageFile('retention', 'missing', PNG) === null)
    const replacement = Buffer.from('474946383961', 'hex')
    await store.cacheImageFile('retention', 'first', replacement)
    await store.cacheImageFile('retention', 'first', PNG)
    check('更新缓存格式只保留并读取最新原图', await store.readCachedImage('retention', 'first') === `data:image/png;base64,${PNG.toString('base64')}` && fs.readdirSync(channelDir('retention')).length === 1)
    for (let index = 0; index < 10; index++) {
      await store.storeImageUrl('retention', `new-${index}`, 'https://example.test/image.png', null, { ts: Date.now() + index + 1 })
      await store.cacheImageFile('retention', `new-${index}`, PNG)
      check(`插入第 ${index + 2} 条后磁盘记录和缓存至多十条`, Object.keys(JSON.parse(fs.readFileSync(historyFile('retention'))).images).length <= 10 && fs.readdirSync(channelDir('retention')).length <= 10)
    }
    check('第十一条立即淘汰最旧记录及原图', await store.getImageEntry('retention', 'first') === null && !fs.existsSync(path.join(channelDir('retention'), 'first.png')))

    await store.storeImageUrl('expiry', 'expired', 'https://example.test/expired.png', null)
    const expiredPath = await store.cacheImageFile('expiry', 'expired', PNG)
    await store.markAnalyzed('expiry', 'expired', '一只白猫。')
    await store.markAnalysisPending('expiry', 'expired')
    const pendingDetail = await store.getImageEntry('expiry', 'expired')
    check('细节识图排队保留已分析标记及客观摘要', pendingDetail.analysisStatus === 'pending' && pendingDetail.analyzed === true && pendingDetail.analysis === '一只白猫。' && await store.getCachedAnalysis('expiry', 'expired') === '一只白猫。')
    const disk = JSON.parse(fs.readFileSync(historyFile('expiry')))
    disk.images.expired.ts = Date.now() - 2 * 60 * 60 * 1000 - 1
    fs.writeFileSync(historyFile('expiry'), JSON.stringify(disk))
    check('直接编号和摘要读取拒绝过期，删除对应原图', await store.getImageEntry('expiry', 'expired') === null && await store.getCachedAnalysis('expiry', 'expired') === null && !fs.existsSync(expiredPath))
    check('过期下载及分析写回不能复活目标', await store.cacheImageFile('expiry', 'expired', PNG) === null && await store.markAnalyzed('expiry', 'expired', '一只黑猫。') === false)
    await store.storeImageUrl('idle-expiry', 'idle', 'https://example.test/idle.png', null)
    const idlePath = await store.cacheImageFile('idle-expiry', 'idle', PNG)
    const idle = JSON.parse(fs.readFileSync(historyFile('idle-expiry')))
    idle.images.idle.ts = Date.now() - 2 * 60 * 60 * 1000 - 1
    fs.writeFileSync(historyFile('idle-expiry'), JSON.stringify(idle))
    await fsp.mkdir(channelDir('orphan'), { recursive: true })
    await fsp.writeFile(path.join(channelDir('orphan'), 'lost.png'), PNG)
    const cleanup = await store.cleanupImageStorage()
    check('全局维护回收无历史记录的孤立文件', cleanup.removedFiles >= 1 && fs.readdirSync(channelDir('orphan')).length === 0)
    check('周期维护回收无人读取的过期记录及原图', cleanup.removedRecords >= 1 && !fs.existsSync(idlePath) && Object.keys(JSON.parse(fs.readFileSync(historyFile('idle-expiry'))).images).length === 0)

    await store.storeImageUrl('local-priority', 'original', 'https://example.test/offline.png', 'onebot-file')
    await store.cacheImageFile('local-priority', 'original', PNG)
    const before = { ...calls }
    const originalTime = (await store.getImageEntry('local-priority', 'original')).ts
    check('本地缓存优先且不触碰 OneBot、下载或模型', !!await readImageSource('local-priority', 'original') && JSON.stringify(before) === JSON.stringify(calls))
    check('重复读取不延长原图片保留时间', (await store.getImageEntry('local-priority', 'original')).ts === originalTime)
    await store.storeImageUrl('adapter', 'original', 'https://example.test/adapter.png', 'adapter-file')
    mock.callGetImage = async file => { calls.onebot++; assert.equal(file, 'adapter-file'); return { file: '/mock/adapter.png' } }
    mock.readImageAsBase64 = async file => { calls.local++; assert.equal(file, '/mock/adapter.png'); return `data:image/png;base64,${PNG.toString('base64')}` }
    check('本地缺失时使用已核实的 OneBot 原图接口', !!await readImageSource('adapter', 'original') && calls.onebot === 1 && calls.local === 1 && calls.remote === 0)
    await store.storeImageUrl('remote', 'original', 'https://example.test/image.png', null)
    await Promise.all(Array.from({ length: 8 }, () => readImageSource('remote', 'original')))
    check('同进程等价原图请求合并且不调用模型', calls.remote === 1 && calls.model === 0)
    await store.storeImageUrl('remote-other', 'original', 'https://example.test/other.png', null)
    await readImageSource('remote-other', 'original')
    check('不同频道相同消息编号不共享来源结果', calls.remote === 2)

    await store.storeImageUrl('invalidated', 'late', 'https://example.test/late.png', null)
    mock.downloadImageAsBase64 = async () => {
      fs.writeFileSync(historyFile('invalidated'), JSON.stringify({ images: {} }))
      return `data:image/png;base64,${PNG.toString('base64')}`
    }
    check('下载途中记录被淘汰则不落盘不返回原图', await readImageSource('invalidated', 'late') === null && await store.readCachedImage('invalidated', 'late') === null)
    mock.downloadImageAsBase64 = async () => null
    await store.storeImageUrl('failed', 'failed', 'https://example.test/failed.png', null)
    check('来源失败保留引用且不升级模型请求', await readImageSource('failed', 'failed') === null && !!await store.getImageEntry('failed', 'failed') && calls.model === 0)

    const sourceLocks = path.join(dataDir, 'image-source-locks')
    const deadHash = createHash('sha256').update('dead-source').digest('hex')
    const aliveHash = createHash('sha256').update('active-source').digest('hex')
    fs.writeFileSync(path.join(sourceLocks, `${deadHash}.lock`), '2147483647:dead')
    fs.writeFileSync(path.join(sourceLocks, `${deadHash}.lock.2147483647.dead.tmp`), '2147483647:dead')
    fs.writeFileSync(path.join(sourceLocks, `${aliveHash}.lock`), `${process.pid}:alive`)
    check('启动维护回收崩溃下载锁并保留活所有者', await cleanupImageSourceLocks() === 2 && fs.existsSync(path.join(sourceLocks, `${aliveHash}.lock`)))
    fs.unlinkSync(path.join(sourceLocks, `${aliveHash}.lock`))

    await store.storeImageUrl('cross-source', 'same-image', 'https://example.test/shared.png', null)
    await Promise.all([runChild('--child-read', [], dataDir), runChild('--child-read', [], dataDir), runChild('--child-read', [], dataDir)])
    check('跨进程读取同一原图只下载一次', fs.readFileSync(path.join(dataDir, 'download-attempts.txt'), 'utf8').trim().split('\n').length === 1)
    await Promise.all([runChild('--child-store', ['0', '4'], dataDir), runChild('--child-store', ['4', '4'], dataDir)])
    check('跨进程并发写入不丢失十条以内的独立记录', Object.keys(JSON.parse(fs.readFileSync(historyFile('cross-write'))).images).length === 8)
    await Promise.all([0, 5, 10, 15].map(start => runChild('--child-store', [String(start)], dataDir)))
    const written = JSON.parse(fs.readFileSync(historyFile('cross-write')))
    check('跨进程写入后JSON完整且保留十条', Object.keys(written.images).length === 10 && (await store.getRecentImages('cross-write', 20)).length === 10)
    check('原子写入与下载所有权没有遗留临时文件', fs.readdirSync(store.IMAGE_HISTORY_DIR).every(name => !name.endsWith('.tmp') && !name.endsWith('.lock')) && fs.readdirSync(path.join(dataDir, 'image-source-locks')).length === 0)
    console.log(`image-storage: ${checks} checks passed`)
  } finally {
    if (originalDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = originalDir
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
}

;(CHILD_MODE ? childMain() : main()).catch(error => { console.error(error); process.exitCode = 1 })
