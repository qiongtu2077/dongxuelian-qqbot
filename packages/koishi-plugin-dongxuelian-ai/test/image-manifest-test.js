/** 完整图片链行为验证；隔离目录、真实解码与捕获模型输入，不连接群聊。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

// 构造真实媒体消息，保留协议位置与下载身份。
function message(id, segments) { return { messageId: id, elements: segments } }
// 模拟 OneBot 图片消息段。
function image(file, extra = {}) { return { type: 'image', data: { file, ...extra } } }
// 模拟普通图片附件消息段。
function attachment(file, name, extra = {}) { return { type: 'file', data: { file, name, ...extra } } }

// 通过共用入口验证清单、大小、附件协议、真实视觉覆盖、失败和清理。
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-manifest-'))
  process.env.DONGXUELIAN_AI_DATA_DIR = dir
  const lib = path.resolve(__dirname, '../lib')
  const api = require(path.join(lib, 'core/api'))
  const capabilities = require(path.join(lib, 'core/ai-capability-config'))
  const admission = require(path.join(lib, 'resource-scheduler/admission'))
  const originalAdmission = admission.admitTask
  let resourcePaused = false
  admission.admitTask = input => ({ ...originalAdmission(input), ...(resourcePaused ? { decision: 'defer' } : {}) })
  const { ModelRequestError } = require(path.join(lib, 'core/request-diagnostics'))
  const bytes = new Map()
  const sourceCalls = []
  const requests = []
  let steps = [{ capability: 'vision', provider: 'opencode', providerName: 'test', model: 'mimo-v2.6-flash', apiKey: 'test', baseURL: 'https://example.test/v1', chatProtocol: 'openai-chat', priorityIndex: 0 }]
  let rejectLargeBatch = false
  api.callGetImage = async file => { sourceCalls.push(['image', file]); return { file } }
  api.callGetFile = async file => { sourceCalls.push(['attachment', file]); return { file } }
  api.readImageAsBase64 = async file => bytes.has(file) ? 'data:image/png;base64,' + bytes.get(file).toString('base64') : null
  api.downloadImageAsBase64 = async () => null
  api.requestChatCompletions = async (messages, config, extra) => {
    extra._onRequestAttempt?.()
    const inputs = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url')
    requests.push({ model: config.model, inputs: inputs.map(p => p.image_url.url), messages })
    if (rejectLargeBatch && config.model === 'mimo-v2.6-flash' && inputs.length > 1) throw new ModelRequestError('body too large', 'HTTP_413', false, 413)
    return { type: 'text', content: '已读取本批全部图片：颜色与形状已核实。', reasoning: '' }
  }
  capabilities.resolveCapabilityRuntimeSteps = () => steps
  const manifest = require(path.join(lib, 'media/image/image-manifest'))
  const batch = require(path.join(lib, 'media/image/image-batch'))
  const store = require(path.join(lib, 'media/image/image-store'))
  const content = require(path.join(lib, 'core/image-content'))
  const safety = require(path.join(lib, 'media/file/file-safety'))
  let checks = 0
  // 输出简短检查名，不打印原图与请求凭据。
  const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('OK ' + name) }
  try {
    for (let index = 0; index < 16; index++) bytes.set('p' + index, await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: index * 12, g: 10, b: 150 } } }).png().toBuffer())
    const mixed = { ...message('current', [image('p2'), attachment('p3', 'PHOTO.JpEg')]), quote: message('quote', [image('p0'), attachment('p1', 'picture.PNG', { mime: 'image/png' })]) }
    const targets = manifest.collectImageManifest(mixed, 'mixed', 'mixed')
    check('引用在前当前在后，四个媒体各有独立身份', targets.length === 4 && new Set(targets.map(x => x.id)).size === 4 && targets[0].aliases[0].group === 'quoted' && targets[2].aliases[0].group === 'current')
    check('普通文件图片按大小写及查询参数分类', safety.checkFile('PHOTO.JpEg', 1).category === 'image' && safety.isImageFileCandidate('', '', 'https://example.test/PIC.PNG?sig=x'))
    check('线上已核实两种图片大小字段进入下载前检查', manifest.collectImageManifest(message('sizes', [image('a', { file_size: 123 }), image('b', { fileSize: '456' })]), 'sizes', 'sizes').map(x => x.declaredSize).join() === '123,456')
    check('纯文字文件名和普通图片链接不创建目标', manifest.collectImageManifest({ ...message('text', []), content: '看 photo.jpg https://example.test/a.png' }, 'mixed', 'mixed').length === 0)
    const result = await batch.readExplicitImageEvidence(targets, '今天星期几？')
    check('无关文字问题仍实际把四张原图送入首次视觉请求', requests.length === 1 && requests[0].inputs.length === 4 && result.results.every(x => x.state === 'read'))
    check('附件只调用get_file，普通图片只调用get_image', sourceCalls.filter(x => x[0] === 'attachment').map(x => x[1]).sort().join() === 'p1,p3' && sourceCalls.filter(x => x[0] === 'image').map(x => x[1]).sort().join() === 'p0,p2')
    const before = requests.length
    await batch.readExplicitImageEvidence(targets, '今天星期几？')
    check('同一有序集合和问题复用已完成视觉证据', requests.length === before)
    await batch.readExplicitImageEvidence(targets, '详细读取图中文字')
    check('不同问题重新请求原图，不复用通用摘要', requests.length === before + 1)

    const many = manifest.collectImageManifest(message('many', Array.from({ length: 12 }, (_, i) => image('p' + i))), 'many', 'many')
    const manyResult = await batch.readExplicitImageEvidence(many, '比较全部图片')
    check('超过历史十条的本轮十二张全部进入实际视觉请求', requests.at(-1).inputs.length === 12 && manyResult.results.every(x => x.state === 'read'))
    check('轮次结束解除活动引用并整组恢复历史上限，消息级查询不返回残缺首图', (await store.getRecentImages('many', 20)).length <= 10 && (await store.getImagesForMessage('many', 'many')).length === 0 && await store.getImageEntry('many', 'many') === null)

    const duplicate = manifest.collectImageManifest({ ...message('dup-current', [image('p0')]), quote: message('dup-quote', [image('p0')]) }, 'dup', 'dup')
    check('同平台资源保留两组别名但只读取一次', duplicate.length === 1 && duplicate[0].aliases.length === 2)
    await batch.readExplicitImageEvidence(duplicate, '比较两处图片')
    check('重复资源只进入模型一次', requests.at(-1).inputs.length === 1)
    check('迁移后的唯一原编号继续定位同一原图缓存', !!await store.readCachedImage('dup', 'dup-quote') && (await store.getImageEntry('dup', 'dup-quote')).imageId === duplicate[0].id)
    const coordination = require(path.join(lib, 'media/image/image-request'))
    const aliasOwner = await coordination.acquireImageRequest('dup', 'dup-quote', { source: 'history-tool', question: '唯一别名协调', force: true })
    const canonicalWaiter = await coordination.acquireImageRequest('dup', duplicate[0].id, { source: 'explicit-image', question: '唯一别名协调', force: true, waitMs: 0 })
    check('原编号与逐图编号共用识图所有权，旧后台入口不会重复识别', aliasOwner.status === 'owned' && canonicalWaiter.status === 'pending' && coordination.hasActiveImageRequest('dup', 'dup-quote'))
    if (aliasOwner.status === 'owned') await aliasOwner.release()
    const refreshed = manifest.collectImageManifest({ ...message('new-current', [image('p0', { url: 'https://example.test/fresh?sig=new' })]), quote: { ...message('expired-quote', [image('p0', { url: 'https://example.test/expired?sig=old' })]), timestamp: Date.now() - 3 * 60 * 60 * 1000 } }, 'refreshed', 'refreshed')
    check('相同资源的新重发提供有效来源，保留别名且不复活过期原编号', refreshed.length === 1 && refreshed[0].originalMessageId === 'new-current' && refreshed[0].aliases.length === 2 && refreshed[0].url.includes('sig=new'))
    bytes.set('same-content', bytes.get('p0'))
    const sameContent = manifest.collectImageManifest(message('same-content', [image('p0'), image('same-content')]), 'same-content', 'same-content')
    const sameResult = await batch.readExplicitImageEvidence(sameContent, '读图')
    check('内容哈希去重仍覆盖每个来源终态', requests.at(-1).inputs.length === 1 && sameResult.results[1].state === 'reused')

    bytes.set('fake', Buffer.from('not an image'))
    const partial = manifest.collectImageManifest(message('partial', [image('p0'), image('huge', { size: content.MAX_IMAGE_BYTES + 1 }), attachment('fake', 'fake.png')]), 'partial', 'partial')
    const partialResult = await batch.readExplicitImageEvidence(partial, '描述图片')
    check('混合成功超限伪装，模型只接收合规原图', requests.at(-1).inputs.length === 1 && partialResult.results.map(x => x.state).join() === 'read,too_large,failed')
    check('已知超限在下载前拦截，失败提示定位具体序号', !sourceCalls.some(x => x[1] === 'huge') && partialResult.notice.includes('当前第2张') && partialResult.notice.includes('当前第3张'))
    const exact = Buffer.alloc(content.MAX_IMAGE_BYTES)
    bytes.get('p0').copy(exact)
    check('恰好十兆的可解码原图允许读取', (await content.validateImageContent('data:image/png;base64,' + exact.toString('base64'))).bytes === content.MAX_IMAGE_BYTES)
    await assert.rejects(() => content.validateImageContent('data:image/png;base64,' + Buffer.concat([exact, Buffer.from([0])]).toString('base64')), /image_too_large/)
    checks++; console.log('OK 十兆加一字节拒绝')
    const exactOther = Buffer.alloc(content.MAX_IMAGE_BYTES); bytes.get('p1').copy(exactOther)
    bytes.set('large-a', exact); bytes.set('large-b', exactOther)
    const primary = steps[0]
    steps = [{ ...primary, model: 'qwen3.5-omni-flash' }, primary]
    const large = manifest.collectImageManifest(message('large', [image('large-a'), attachment('large-b', 'large.png')]), 'large', 'large')
    const largeResult = await batch.readExplicitImageEvidence(large, '比较原图')
    check('单图均十兆且合计二十兆，通过可容纳的备用视觉节点全部读取', largeResult.results.every(x => x.state === 'read') && requests.at(-1).inputs.length === 2 && requests.at(-1).model === 'mimo-v2.6-flash')
    steps = [primary]

    const parallel = manifest.collectImageManifest(message('parallel', [image('p6'), image('p7')]), 'parallel', 'parallel')
    const sourceStart = sourceCalls.length
    const parallelResult = await Promise.all([batch.readExplicitImageEvidence(parallel, '正序比较'), batch.readExplicitImageEvidence([...parallel].reverse(), '倒序比较')])
    check('两轮倒序集合不死锁，原图只下载一次且各自保留问题上下文', sourceCalls.length - sourceStart === 2 && parallelResult.every(result => result.results.every(x => x.state === 'read')))
    const equivalent = manifest.collectImageManifest(message('equivalent', [image('p8'), image('p9')]), 'equivalent', 'equivalent')
    const equivalentStart = requests.length
    await Promise.all([batch.readExplicitImageEvidence(equivalent, '相同问题'), batch.readExplicitImageEvidence(equivalent, '相同问题')])
    check('并发同一集合与问题只请求一次视觉', requests.length === equivalentStart + 1)
    check('多图历史按原消息查询整组，单图查询不默认为第一张', (await store.getImagesForMessage('mixed', 'current')).length === 2 && await store.getImageEntry('mixed', 'current') === null)
    delete require.cache[require.resolve(path.join(lib, 'media/image/image-store'))]
    const restarted = require(path.join(lib, 'media/image/image-store'))
    check('重载后version=2记录仍保留逐图身份', (await restarted.getImagesForMessage('mixed', 'quote')).length === 2)

    rejectLargeBatch = true
    const split = manifest.collectImageManifest(message('split', [image('p0'), image('p1'), image('p2')]), 'split', 'split')
    const splitResult = await batch.readExplicitImageEvidence(split, '描述颜色')
    check('真实413触发有界拆分且所有批次覆盖完整目标', splitResult.results.every(x => x.state === 'read') && splitResult.batches === 5 && splitResult.evidence.includes('跨批次比较'))
    steps = [primary, { ...primary, model: 'qwen3.5-omni-flash' }]
    const compare = manifest.collectImageManifest(message('compare', [image('p0'), image('p1'), image('p2')]), 'compare', 'compare')
    const compareResult = await batch.readExplicitImageEvidence(compare, '比较颜色差异')
    check('分批比较向可容纳两图的备用节点补充真实原图对照', compareResult.results.every(x => x.state === 'read') && compareResult.evidence.includes('补充原图对照') && requests.some(request => request.model === 'qwen3.5-omni-flash' && request.inputs.length === 2))
    steps = [primary]
    rejectLargeBatch = false
    const cancelled = new AbortController(); cancelled.abort()
    const start = requests.length
    const cancelledResult = await batch.readExplicitImageEvidence(manifest.collectImageManifest(message('cancel', [image('p4'), image('p5')]), 'cancel', 'cancel'), '取消测试', { signal: cancelled.signal })
    check('取消不启动下载或模型，全部目标进入取消终态', requests.length === start && cancelledResult.results.every(x => x.state === 'cancelled'))
    resourcePaused = true
    const pauseStart = requests.length
    const pausedResult = await batch.readExplicitImageEvidence(manifest.collectImageManifest(message('pause', [image('p10')]), 'pause', 'pause'), '暂停测试')
    check('资源保护暂停后不开始新批次，并明确暂停原因', requests.length === pauseStart && pausedResult.results[0].state === 'cancelled' && pausedResult.notice.includes('资源保护暂停读取'))
    resourcePaused = false
    const files = fs.readdirSync(store.IMAGE_HISTORY_DIR).filter(x => x.endsWith('.json')).map(x => JSON.parse(fs.readFileSync(path.join(store.IMAGE_HISTORY_DIR, x), 'utf8')))
    check('成功失败取消都释放所有持久活动引用', files.every(data => Object.values(data.images).every(entry => !Object.keys(entry.activeOwners || {}).length)))
    console.log(JSON.stringify({ checks, modelRequests: requests.length }))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
