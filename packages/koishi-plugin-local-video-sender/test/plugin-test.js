const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const MAX_SIZE = 60_000_000
const TEST_BV = 'BV1xx411c7mD'
const TEST_URL = `https://www.bilibili.com/video/${TEST_BV}`

let passed = 0
let failed = 0

// 构造与 OneBot 适配器一致的明确拒绝错误。
class SenderError extends Error {
  // 保存消息接口动作和整数返回码。
  constructor(retcode) {
    super(`sender rejected with retcode ${retcode}`)
    this.url = 'send_group_msg'
    this.code = retcode
  }
}

// 构造与 OneBot 适配器一致的响应超时错误。
class TimeoutError extends Error {
  // 保存超时对应的消息接口动作。
  constructor() {
    super('sender response timed out')
    this.url = 'send_group_msg'
  }
}

// 打印一个测试分组标题。
function section(title) {
  console.log(`\n=== local-video-sender: ${title} ===`)
}

// 记录一条轻量测试断言。
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  OK   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

// 重新加载使用当前环境变量构建的插件模块。
function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

// 创建支持日志、命令和 dispose 生命周期的 Koishi 上下文替身。
function makeCtx() {
  const commands = []
  const logs = []
  const disposeHandlers = []
  return {
    commands,
    logs,
    command(name, desc) {
      const command = {
        name,
        desc,
        action(fn) {
          commands.push({ name, desc, fn })
          return command
        },
      }
      return command
    },
    middleware() {},
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: args.map(String).join(' ') })
      return {
        info: (...args) => push('info', args),
        warn: (...args) => push('warn', args),
        error: (...args) => push('error', args),
      }
    },
    on(event, handler) {
      if (event === 'dispose') disposeHandlers.push(handler)
    },
    async dispose() {
      for (const handler of disposeHandlers.splice(0)) await handler()
    },
  }
}

// 创建可观察已发送消息的会话替身。
function makeSession(overrides = {}) {
  const sent = []
  return {
    sent,
    userId: '100000000',
    guildId: '10001',
    channelId: '10001',
    isDirect: false,
    content: '',
    async send(message) {
      sent.push(String(message))
      return message
    },
    ...overrides,
  }
}

// 为单个测试分组建立隔离的下载和数据目录。
async function withIsolatedPlugin(fn) {
  const oldEnv = {
    BILI_COOKIES_FILE: process.env.BILI_COOKIES_FILE,
    BILI_WORKDIR: process.env.BILI_WORKDIR,
    BILI_MAX_SIZE_BYTES: process.env.BILI_MAX_SIZE_BYTES,
    BILI_MIN_MEM_MB: process.env.BILI_MIN_MEM_MB,
    BILI_TEST_VIDEO_FILE: process.env.BILI_TEST_VIDEO_FILE,
    DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-video-sender-'))
  const dataDir = path.join(tmpRoot, 'data')
  process.env.BILI_COOKIES_FILE = path.join(tmpRoot, 'cookies.txt')
  process.env.BILI_WORKDIR = path.join(tmpRoot, 'downloads')
  process.env.BILI_MAX_SIZE_BYTES = String(MAX_SIZE)
  process.env.BILI_MIN_MEM_MB = '450'
  process.env.BILI_TEST_VIDEO_FILE = path.join(tmpRoot, 'test-video.mp4')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  delete require.cache[PLUGIN_PATH]

  let plugin
  try {
    plugin = reloadPlugin()
    await fn({ plugin, tmpRoot, dataDir })
  } finally {
    if (plugin) await plugin.clearVideoRuntimeState()
    delete require.cache[PLUGIN_PATH]
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// 返回带规范 BV 地址的探测元数据。
function sampleInfo(overrides = {}) {
  return {
    title: 'Demo Video',
    thumbnail: 'https://example.com/thumb.jpg',
    webpage_url: `${TEST_URL}/`,
    formats: [
      { format_id: '30064', height: 720, vcodec: 'avc1', acodec: 'none', filesize: 40_000_000 },
      { format_id: '30280', vcodec: 'none', acodec: 'mp4a', abr: 132, filesize: 10_000_000 },
    ],
    ...overrides,
  }
}

// 返回指定预计大小的探测函数。
function makeProbe(totalSize, counters = null, infoOverrides = {}) {
  return async () => {
    if (counters) counters.probes += 1
    return {
      info: sampleInfo(infoOverrides),
      picked: { format: '30064+30280', label: '720P AVC', totalSize, height: 720 },
    }
  }
}

// 创建一个指定逻辑大小的稀疏文件。
function createSparseFile(filePath, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = fs.openSync(filePath, 'w')
  try {
    fs.ftruncateSync(fd, size)
  } finally {
    fs.closeSync(fd)
  }
}

// 读取 yt-dlp `-P kind:path` 参数中的指定目录。
function getYtdlpPath(args, kind) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-P') continue
    const value = String(args[index + 1])
    if (value.startsWith(`${kind}:`)) return value.slice(kind.length + 1)
  }
  return ''
}

// 创建会按 yt-dlp 输出模板生成 MP4 的下载器替身。
function makeDownloader(size, counters = null, beforeWrite = null) {
  return async (_command, args) => {
    if (counters) {
      counters.downloads += 1
      counters.args = [...args]
    }
    if (beforeWrite) await beforeWrite()
    const homeDir = getYtdlpPath(args, 'home')
    const outputIndex = args.indexOf('-o')
    const outputTemplate = args[outputIndex + 1]
    createSparseFile(path.join(homeDir, outputTemplate.replace('%(ext)s', 'mp4')), size)
    return { stdout: '', stderr: '' }
  }
}

// 创建一个可从测试侧释放的 Promise。
function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

// 等待某个异步测试条件成立。
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// 生成禁用生产资源门禁的下载依赖。
function makeDeps(totalSize, fileSize, counters = null, overrides = {}) {
  return {
    resourceGate: false,
    probeVideo: makeProbe(totalSize, counters),
    run: makeDownloader(fileSize, counters),
    ...overrides,
  }
}

// 创建可按单个文件系统阶段覆写行为的异步接口替身。
function makeVideoFs(overrides = {}) {
  return {
    mkdir: (...args) => fsp.mkdir(...args),
    stat: (...args) => fsp.stat(...args),
    rm: (...args) => fsp.rm(...args),
    ...overrides,
  }
}

// 创建只暴露本次测试所需准入结果的资源模块替身。
function makeResourceModules(admission, acquire = async () => ({ updateStep() {}, release() {} })) {
  return {
    admitTask: () => admission,
    acquireResourceGate: acquire,
  }
}

// 验证环境配置、解析和纯函数行为。
async function testConfigAndParsing() {
  section('env config and pure parsing')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const config = plugin.getRuntimeConfig()
    check('cookies path uses env override', config.cookies === path.join(tmpRoot, 'cookies.txt'), JSON.stringify(config))
    check('workdir path uses env override', config.workdir === path.join(tmpRoot, 'downloads'), JSON.stringify(config))
    check('max size uses 60,000,000-byte override', config.maxSize === MAX_SIZE, JSON.stringify(config))
    check('video min memory uses env override', config.videoMinMemMb === 450, JSON.stringify(config))
    check('test video path uses env override', config.testVideoFile === path.join(tmpRoot, 'test-video.mp4'), JSON.stringify(config))
    check('file URL helper emits standard file URL', plugin.toFileUrl(path.join(tmpRoot, 'downloads', 'demo.mp4')).startsWith('file:///'))
    check('formats decimal MB with one decimal', plugin.formatDecimalMb(60_000_001) === '60.0 MB')
    check('builds exact oversize text', plugin.buildOversizeMessage(61_250_000) === '视频文件过大（61.3 MB），请自行去 bilibili 观看。详细信息：预计大小为61250000字节，上传限制为60000000字节。错误编号：video-015。')

    const bvUrl = plugin.extractBiliUrl(`看看这个 ${TEST_BV}`)
    check('extracts BV id as canonical URL', bvUrl === TEST_URL, String(bvUrl))
    const shareUrl = plugin.extractBiliUrl('https://b23.tv/abc123?x=1')
    check('extracts b23 share URL', shareUrl === 'https://b23.tv/abc123?x=1', String(shareUrl))
    const keys = plugin.buildBiliKeys(`${TEST_BV} ${TEST_URL}/?spm_id_from=1`)
    check('builds normalized BV key', keys.includes('bv:1xx411c7md'), JSON.stringify(keys))
    check('builds normalized URL key', keys.includes('url:www.bilibili.com/video/bv1xx411c7md'), JSON.stringify(keys))
    check('blocks private IPv4 redirect targets', plugin.isPrivateIpAddress('127.0.0.1') && plugin.isPrivateIpAddress('192.168.1.2'))
    check('allows public redirect targets', !plugin.isPrivateIpAddress('8.8.8.8'))
    check('restricts redirect host allowlist', plugin.isAllowedBiliRedirectUrl('https://www.bilibili.com/video/BV1xx411c7mD') && !plugin.isAllowedBiliRedirectUrl('https://example.com/'))
    const resolved = await plugin.resolveBiliShortLink('https://b23.tv/testKey', async input => ({
      statusCode: 302,
      location: input.includes('testKey') ? TEST_URL : '',
    }))
    check('normalizes an allowed short-link redirect to BV key', resolved === 'bv:1xx411c7md', String(resolved))
  })
}

// 验证 video-001 至 video-027 的完整中文文案和动态数据。
async function testChineseUserErrorCatalog() {
  section('Chinese user error catalog')
  await withIsolatedPlugin(async ({ plugin }) => {
    const cases = [
      [{ id: 'video-001' }, '视频解析命令格式错误。详细信息：请在“bvidl”后填写B站链接；也可以填写BV号。错误编号：video-001。'],
      [{ id: 'video-002', remainingSeconds: 300 }, '请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余300秒。错误编号：video-002。'],
      [{ id: 'video-003' }, '视频下载暂时关闭。详细信息：视频资源门禁模块加载失败。错误编号：video-003。'],
      [{ id: 'video-004', resourceState: 'red', availableMemoryMb: 321.4, minimumMemoryMb: 450, decision: 'reject' }, '视频搬运暂时无法执行，请稍后再试。详细信息：资源状态为紧张，当前可用内存321MB，视频任务最低需要450MB，调度结果为拒绝。错误编号：video-004。'],
      [{ id: 'video-005', resourceState: 'black', minimumMemoryMb: 450, decision: 'queue' }, '视频搬运暂时无法执行，请稍后再试。详细信息：资源状态为不可用，当前可用内存数据未取得，视频任务最低需要450MB，调度结果为排队。错误编号：video-005。'],
      [{ id: 'video-006' }, '视频搬运暂时无法执行，请稍后再试。详细信息：视频资源锁在5秒内未申请成功。错误编号：video-006。'],
      [{ id: 'video-007' }, '视频目录准备失败，请稍后再试。详细信息：视频工作目录创建失败。错误编号：video-007。'],
      [{ id: 'video-008' }, '视频目录准备失败，请稍后再试。详细信息：五分钟视频缓存目录创建失败。错误编号：video-008。'],
      [{ id: 'video-009' }, '视频目录准备失败，请稍后再试。详细信息：下载暂存根目录创建失败。错误编号：video-009。'],
      [{ id: 'video-010' }, '视频信息获取失败，请稍后再试。详细信息：视频信息探测命令执行失败。错误编号：video-010。'],
      [{ id: 'video-011', bvId: TEST_BV, partNumber: 2 }, `视频信息获取失败，请稍后再试。详细信息：${TEST_BV}第2P未找到可用的视频格式。错误编号：video-011。`],
      [{ id: 'video-012', retcode: 1200 }, '视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息被消息接口拒绝，返回码为1200。错误编号：video-012。'],
      [{ id: 'video-013' }, '视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息调用接口失败。错误编号：video-013。'],
      [{ id: 'video-014' }, '视频文件大小无法预估，请自行去 bilibili 观看。详细信息：所选清晰度缺少可用的文件大小、码率和时长数据。错误编号：video-014。'],
      [{ id: 'video-015', estimatedBytes: 60_000_001 }, '视频文件过大（60.0 MB），请自行去 bilibili 观看。详细信息：预计大小为60000001字节，上传限制为60000000字节。错误编号：video-015。'],
      [{ id: 'video-016' }, '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录创建失败。错误编号：video-016。'],
      [{ id: 'video-017' }, '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录未通过安全校验。错误编号：video-017。'],
      [{ id: 'video-018' }, '视频下载失败，请稍后再试。详细信息：视频下载命令执行失败。错误编号：video-018。'],
      [{ id: 'video-019' }, '视频文件校验失败，请稍后再试。详细信息：下载结果未通过视频缓存路径安全校验。错误编号：video-019。'],
      [{ id: 'video-020' }, '视频文件校验失败，请稍后再试。详细信息：下载结果的文件信息读取失败。错误编号：video-020。'],
      [{ id: 'video-021', actualBytes: 60_000_001 }, '视频文件过大（60.0 MB），请自行去 bilibili 观看。详细信息：实际大小为60000001字节，上传限制为60000000字节。错误编号：video-021。'],
      [{ id: 'video-022', retcode: 1200 }, '视频发送失败，请稍后再试。详细信息：视频发送请求被消息接口拒绝，返回码为1200。错误编号：video-022。'],
      [{ id: 'video-023' }, '视频发送失败，请稍后再试。详细信息：视频发送接口调用失败。错误编号：video-023。'],
      [{ id: 'video-024', retcode: 1200 }, '缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息被消息接口拒绝，返回码为1200。错误编号：video-024。'],
      [{ id: 'video-025' }, '缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息调用接口失败。错误编号：video-025。'],
      [{ id: 'video-026', retcode: 1200 }, '缓存视频发送失败，请稍后再试。详细信息：缓存视频发送请求被消息接口拒绝，返回码为1200。错误编号：video-026。'],
      [{ id: 'video-027' }, '缓存视频发送失败，请稍后再试。详细信息：缓存视频发送接口调用失败。错误编号：video-027。'],
    ]

    const stages = new Set()
    for (const [input, expected] of cases) {
      const userError = plugin.buildVideoUserError(input)
      stages.add(userError.stage)
      check(`${input.id} emits exact Chinese detail`, userError.id === input.id && userError.message === expected, JSON.stringify(userError))
      check(`${input.id} has one detailed stage`, userError.message.includes('详细信息：') && userError.message.endsWith(`错误编号：${input.id}。`) && !/下载或暂存|下载或发送|创建或校验/.test(userError.message), userError.message)
    }
    check('all 27 error IDs use distinct fixed stages', cases.length === 27 && stages.size === 27, JSON.stringify([...stages]))

    const stateLabels = { green: '正常', yellow: '注意', red: '紧张', black: '不可用' }
    for (const [state, label] of Object.entries(stateLabels)) {
      const message = plugin.buildVideoUserError({ id: 'video-004', resourceState: state, availableMemoryMb: 0, minimumMemoryMb: 450, decision: 'reject' }).message
      check(`resource state ${state} is translated`, message.includes(`资源状态为${label}`), message)
    }
    const decisionLabels = { reject: '拒绝', defer: '延后', queue: '排队', downgrade: '降级', silent_drop: '静默丢弃' }
    for (const [decision, label] of Object.entries(decisionLabels)) {
      const message = plugin.buildVideoUserError({ id: 'video-005', resourceState: 'yellow', minimumMemoryMb: 450, decision }).message
      check(`admission decision ${decision} is translated`, message.includes(`调度结果为${label}`), message)
    }
    const unknownLabels = plugin.buildVideoUserError({ id: 'video-005', resourceState: 'future', minimumMemoryMb: 450, decision: 'future' }).message
    check('unknown resource values stay Chinese', unknownLabels.includes('资源状态为未识别') && unknownLabels.includes('调度结果为未识别'), unknownLabels)
  })
}

// 验证格式选择会合并视频流和音频流大小。
async function testFormatPicking() {
  section('format picking')
  await withIsolatedPlugin(async ({ plugin }) => {
    const picked = plugin.pickFormat(sampleInfo())
    check('prefers explicit 720P candidate', picked && picked.format === '30064+30280', JSON.stringify(picked))
    check('computes split stream size', picked && picked.totalSize === 50_000_000, JSON.stringify(picked))

    const approximate = plugin.pickFormat({
      formats: [
        { format_id: 'v720', height: 720, fps: 30, vcodec: 'avc1', acodec: 'none', filesize_approx: 42_000_000 },
        { format_id: 'a1', vcodec: 'none', acodec: 'mp4a', abr: 160, filesize_approx: 8_000_000 },
      ],
    })
    check('uses approximate sizes for split streams', approximate && approximate.totalSize === 50_000_000, JSON.stringify(approximate))
    check('rejects audio-only format sets', plugin.pickFormat({ formats: [{ format_id: 'a1', vcodec: 'none', acodec: 'mp4a' }] }) === null)
  })
}

// 验证命令注册和大小门禁的全部边界。
async function testSizeGates() {
  section('commands and size gates')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const ctx = makeCtx()
    plugin.apply(ctx)
    const testVideo = ctx.commands.find(command => command.name === 'sendtestvideo')
    check('registers sendtestvideo command', !!testVideo)
    const videoSegment = testVideo ? await testVideo.fn({ session: makeSession() }) : ''
    check('sendtestvideo uses env test file', String(videoSegment).includes('test-video.mp4'), String(videoSegment))

    let runCalled = false
    const oversizeSession = makeSession()
    const oversizeResult = await plugin.downloadAndSend(ctx, oversizeSession, TEST_URL, TEST_BV, {
      resourceGate: false,
      probeVideo: makeProbe(MAX_SIZE + 1),
      run: async () => { runCalled = true },
    })
    check('estimated oversize returns undefined after explicit sends', oversizeResult === undefined, String(oversizeResult))
    check('estimated oversize sends preview then exact refusal', oversizeSession.sent.length === 2 && oversizeSession.sent[0].includes('Demo Video') && oversizeSession.sent[1] === '视频文件过大（60.0 MB），请自行去 bilibili 观看。详细信息：预计大小为60000001字节，上传限制为60000000字节。错误编号：video-015。', JSON.stringify(oversizeSession.sent))
    check('estimated oversize does not run downloader', !runCalled)

    await plugin.clearVideoRuntimeState()
    const unknownSession = makeSession({ guildId: '10002', channelId: '10002' })
    await plugin.downloadAndSend(ctx, unknownSession, TEST_URL, TEST_BV, makeDeps(0, 1))
    check('unknown size sends preview then exact refusal', unknownSession.sent.length === 2 && unknownSession.sent[1] === '视频文件大小无法预估，请自行去 bilibili 观看。详细信息：所选清晰度缺少可用的文件大小、码率和时长数据。错误编号：video-014。', JSON.stringify(unknownSession.sent))

    for (const size of [MAX_SIZE, MAX_SIZE - 1]) {
      await plugin.clearVideoRuntimeState()
      const counters = { probes: 0, downloads: 0 }
      const session = makeSession({ guildId: String(size), channelId: String(size) })
      const result = await plugin.downloadAndSend(ctx, session, TEST_URL, TEST_BV, makeDeps(size, size, counters))
      check(`${size} bytes is accepted`, result === undefined && counters.downloads === 1 && session.sent.length === 2, JSON.stringify({ result, counters, sent: session.sent }))
      check(`${size} bytes is retained in cache`, plugin.getVideoCacheStatus().entries === 1, JSON.stringify(plugin.getVideoCacheStatus()))
    }

    await plugin.clearVideoRuntimeState()
    const postDownloadSession = makeSession({ guildId: '10003', channelId: '10003' })
    await plugin.downloadAndSend(ctx, postDownloadSession, TEST_URL, TEST_BV, makeDeps(MAX_SIZE - 1, MAX_SIZE + 1))
    check('actual oversize blocks video upload', postDownloadSession.sent.length === 2 && postDownloadSession.sent[1] === '视频文件过大（60.0 MB），请自行去 bilibili 观看。详细信息：实际大小为60000001字节，上传限制为60000000字节。错误编号：video-021。', JSON.stringify(postDownloadSession.sent))
    check('actual oversize is deleted and not cached', plugin.getVideoCacheStatus().entries === 0 && fs.readdirSync(path.join(tmpRoot, 'downloads', 'cache')).length === 0, JSON.stringify(plugin.getVideoCacheStatus()))
    check('actual oversize removes request staging', fs.readdirSync(path.join(tmpRoot, 'downloads', '.staging')).length === 0)

    await ctx.dispose()
  })
}

// 验证同群去重、跨群缓存与固定五分钟 TTL。
async function testDuplicateAndCacheReuse() {
  section('duplicate suppression and cache reuse')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0 }
    const deps = makeDeps(1_000_000, 1_000_000, counters)
    const first = makeSession({ guildId: 'group-a', channelId: 'group-a' })
    await plugin.downloadAndSend(ctx, first, TEST_URL, TEST_BV, deps)

    const duplicate = makeSession({ guildId: 'group-a', channelId: 'group-a' })
    await plugin.downloadAndSend(ctx, duplicate, `${TEST_URL}?from=repeat`, TEST_BV, deps)
    check('same group duplicate gets exact 300-second notice', duplicate.sent.length === 1 && duplicate.sent[0] === '请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余300秒。错误编号：video-002。', JSON.stringify(duplicate.sent))
    check('same group duplicate does no extra work', counters.probes === 1 && counters.downloads === 1, JSON.stringify(counters))

    const otherGroup = makeSession({ guildId: 'group-b', channelId: 'group-b' })
    await plugin.downloadAndSend(ctx, otherGroup, `${TEST_URL}?from=other`, TEST_URL, deps)
    check('other group reuses preview and disk video', otherGroup.sent.length === 2 && counters.probes === 1 && counters.downloads === 1, JSON.stringify({ sent: otherGroup.sent, counters }))

    await plugin.clearVideoRuntimeState()
    const realNow = Date.now
    let now = 1_800_000_000_000
    Date.now = () => now
    try {
      const boundaryCounters = { probes: 0, downloads: 0 }
      const boundaryDeps = makeDeps(MAX_SIZE + 1, 1, boundaryCounters)
      const boundarySession = { guildId: 'boundary', channelId: 'boundary' }
      await plugin.downloadAndSend(ctx, makeSession(boundarySession), TEST_URL, TEST_BV, boundaryDeps)
      now += 299_999
      const blocked = makeSession(boundarySession)
      await plugin.downloadAndSend(ctx, blocked, TEST_URL, TEST_BV, boundaryDeps)
      now += 1
      const released = makeSession(boundarySession)
      await plugin.downloadAndSend(ctx, released, TEST_URL, TEST_BV, boundaryDeps)
      check('299,999 ms is blocked by duplicate window', blocked.sent.length === 1 && blocked.sent[0] === '请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余1秒。错误编号：video-002。', JSON.stringify(blocked.sent))
      check('300,000 ms boundary resumes processing', boundaryCounters.probes === 2 && released.sent.length === 2, JSON.stringify({ boundaryCounters, sent: released.sent }))

      await plugin.clearVideoRuntimeState()
      now += 1_000_000
      const ttlCounters = { probes: 0, downloads: 0 }
      const ttlDeps = makeDeps(1_000_000, 1_000_000, ttlCounters)
      await plugin.downloadAndSend(ctx, makeSession({ guildId: 'ttl-a', channelId: 'ttl-a' }), TEST_URL, TEST_BV, ttlDeps)
      const firstExpiry = plugin.getVideoCacheStatus().items[0].expiresAt
      now += 4 * 60 * 1000
      await plugin.downloadAndSend(ctx, makeSession({ guildId: 'ttl-b', channelId: 'ttl-b' }), TEST_URL, TEST_BV, ttlDeps)
      const afterHitExpiry = plugin.getVideoCacheStatus().items[0].expiresAt
      check('cache hit does not renew five-minute expiry', firstExpiry === afterHitExpiry, JSON.stringify({ firstExpiry, afterHitExpiry }))

      now += 60 * 1000 + 1
      await plugin.downloadAndSend(ctx, makeSession({ guildId: 'ttl-c', channelId: 'ttl-c' }), TEST_URL, TEST_BV, ttlDeps)
      check('expired cache triggers a fresh download', ttlCounters.probes === 2 && ttlCounters.downloads === 2, JSON.stringify(ttlCounters))
    } finally {
      Date.now = realNow
    }
  })
}

// 验证并发请求会等待同一个首次下载任务。
async function testInflightReuse() {
  section('concurrent inflight reuse')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const releaseDownload = deferred()
    const counters = { probes: 0, downloads: 0 }
    const deps = makeDeps(1_000_000, 1_000_000, counters, {
      run: makeDownloader(1_000_000, counters, () => releaseDownload.promise),
    })
    const firstSession = makeSession({ guildId: 'parallel-a', channelId: 'parallel-a' })
    const secondSession = makeSession({ guildId: 'parallel-b', channelId: 'parallel-b' })
    const first = plugin.downloadAndSend(ctx, firstSession, TEST_URL, TEST_BV, deps)
    await waitFor(() => counters.downloads === 1)
    const stagingRoot = path.join(plugin.getRuntimeConfig().workdir, '.staging')
    check('active inflight owns one request staging directory', fs.readdirSync(stagingRoot).length === 1)
    const second = plugin.downloadAndSend(ctx, secondSession, TEST_URL, TEST_BV, deps)
    releaseDownload.resolve()
    await Promise.all([first, second])
    check('parallel groups probe and download once', counters.probes === 1 && counters.downloads === 1, JSON.stringify(counters))
    check('parallel groups use one staging directory and clean it', fs.readdirSync(stagingRoot).length === 0)
    check('parallel waiter receives preview and video', secondSession.sent.length === 2, JSON.stringify(secondSession.sent))
  })
}

// 验证不同短链经过一次解析后归一到同一个 BV 缓存。
async function testShortLinkNormalization() {
  section('short-link normalization')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0, resolutions: 0 }
    const firstShort = 'https://b23.tv/firstKey'
    const secondShort = 'https://b23.tv/secondKey'
    const resolveShortLink = async () => {
      counters.resolutions += 1
      return 'bv:1xx411c7md'
    }
    const deps = makeDeps(1_000_000, 1_000_000, counters, { resolveShortLink })

    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'short-a', channelId: 'short-a' }), firstShort, firstShort, deps)
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'short-b', channelId: 'short-b' }), secondShort, secondShort, deps)
    check('different short links each resolve once then share BV file', counters.resolutions === 2 && counters.probes === 1 && counters.downloads === 1, JSON.stringify(counters))

    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'short-c', channelId: 'short-c' }), firstShort, firstShort, {
      ...deps,
      resolveShortLink: async () => { throw new Error('resolution cache should be used') },
    })
    check('same short link uses ten-minute resolution cache', counters.resolutions === 2 && counters.probes === 1 && counters.downloads === 1, JSON.stringify(counters))
  })
}

// 验证活动发送保护、遗留扫描和关闭清理边界。
async function testCleanupAndSafety() {
  section('cleanup lifecycle and path safety')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const ctx = makeCtx()
    plugin.apply(ctx)
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'clean-a', channelId: 'clean-a' }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    const cacheDir = path.join(tmpRoot, 'downloads', 'cache')
    const cachedFile = path.join(cacheDir, fs.readdirSync(cacheDir).find(name => name.endsWith('.mp4')))

    const videoSendStarted = deferred()
    const releaseVideoSend = deferred()
    let sends = 0
    const activeSession = makeSession({
      guildId: 'clean-b',
      channelId: 'clean-b',
      async send(message) {
        sends += 1
        if (sends === 2) {
          videoSendStarted.resolve()
          await releaseVideoSend.promise
        }
        return message
      },
    })
    const activeSend = plugin.downloadAndSend(ctx, activeSession, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    await videoSendStarted.promise
    const cleanup = await plugin.cleanupVideoCache(ctx, Date.now() + 11 * 60 * 1000)
    check('ten-minute cleanup preserves an active file', cleanup.staleActive === 1 && fs.existsSync(cachedFile), JSON.stringify(cleanup))
    releaseVideoSend.resolve()
    await activeSend
    await waitFor(() => !fs.existsSync(cachedFile))
    check('expired active file is deleted after send finally', !fs.existsSync(cachedFile))

    const staleFile = path.join(cacheDir, 'bili-cache-orphan-1-test99.mp4')
    const freshFile = path.join(cacheDir, 'bili-cache-fresh-2-test99.mp4')
    const unrelatedFile = path.join(tmpRoot, 'downloads', 'do-not-delete.mp4')
    createSparseFile(staleFile, 10)
    createSparseFile(freshFile, 10)
    createSparseFile(unrelatedFile, 10)
    const oldDate = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(staleFile, oldDate, oldDate)
    await plugin.cleanupVideoCache(ctx)
    check('sweeper deletes only stale dedicated cache files', !fs.existsSync(staleFile) && fs.existsSync(freshFile) && fs.existsSync(unrelatedFile))

    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'clean-c', channelId: 'clean-c' }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    await ctx.dispose()
    check('plugin dispose clears registered cache entries', plugin.getVideoCacheStatus().entries === 0, JSON.stringify(plugin.getVideoCacheStatus()))
    check('plugin dispose leaves unrelated workdir files alone', fs.existsSync(unrelatedFile))
  })
}

// 验证失败路径不会留下缓存或错误去重状态。
async function testFailurePaths() {
  section('failure and blacklist paths')
  await withIsolatedPlugin(async ({ plugin, dataDir }) => {
    const ctx = makeCtx()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'video-blacklist.json'), JSON.stringify({ groups: ['10001'], users: [] }), 'utf8')
    check('video blacklist blocks configured group', plugin.isBlacklistedGroup(makeSession({ guildId: '10001', channelId: '10001' })))
    fs.writeFileSync(path.join(dataDir, 'video-blacklist.json'), JSON.stringify({ groups: [], users: [] }), 'utf8')

    let probes = 0
    const failedDeps = {
      resourceGate: false,
      probeVideo: async () => {
        probes += 1
        throw new Error('probe failed')
      },
    }
    const failedFirst = await plugin.downloadAndSend(ctx, makeSession({ guildId: 'fail-a', channelId: 'fail-a' }), TEST_URL, TEST_BV, failedDeps)
    const failedSecond = await plugin.downloadAndSend(ctx, makeSession({ guildId: 'fail-a', channelId: 'fail-a' }), TEST_URL, TEST_BV, failedDeps)
    check('probe failure can be retried immediately', probes === 2, `probes=${probes}`)
    check('probe failure keeps controlled user error', String(failedFirst).includes('错误编号：video-010') && String(failedSecond).includes('错误编号：video-010'))

    await plugin.clearVideoRuntimeState()
    const uploadFailure = makeSession({
      guildId: 'upload-fail',
      channelId: 'upload-fail',
      async send(message) {
        if (String(message).includes('<video')) throw new Error('video upload failed')
        return message
      },
    })
    const result = await plugin.downloadAndSend(ctx, uploadFailure, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    check('upload failure returns controlled error', String(result).includes('错误编号：video-023'), String(result))
    check('upload failure leaves no cache entry', plugin.getVideoCacheStatus().entries === 0, JSON.stringify(plugin.getVideoCacheStatus()))
    check('upload failure removes final file and staging', fs.readdirSync(path.join(plugin.getRuntimeConfig().workdir, 'cache')).length === 0 && fs.readdirSync(path.join(plugin.getRuntimeConfig().workdir, '.staging')).length === 0)
  })
}

// 验证资源、目录、校验和消息接口失败会路由到唯一编号。
async function testDetailedErrorRouting() {
  section('detailed error routing')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const ctx = makeCtx()
    plugin.apply(ctx)

    const bvidl = ctx.commands.find(command => command.name.startsWith('bvidl '))
    const usage = bvidl ? await bvidl.fn({ session: makeSession() }, '') : ''
    check('invalid bvidl input returns video-001', String(usage).includes('错误编号：video-001'), String(usage))

    const resourceCases = [
      ['video-003', { resourceModules: null }],
      ['video-004', { resourceModules: makeResourceModules({ decision: 'reject', reason: 'low memory', resourceState: 'red', memAvailableMb: 321 }) }],
      ['video-005', { resourceModules: makeResourceModules({ decision: 'queue', reason: 'busy', resourceState: 'yellow', memAvailableMb: null }) }],
      ['video-006', { resourceModules: makeResourceModules({ decision: 'run_now', reason: 'accepted', resourceState: 'green', memAvailableMb: 1024 }, async () => { throw new Error('gate timed out') }) }],
    ]
    for (let index = 0; index < resourceCases.length; index += 1) {
      const [id, deps] = resourceCases[index]
      const result = await plugin.downloadAndSend(ctx, makeSession({ guildId: `resource-${index}`, channelId: `resource-${index}` }), TEST_URL, TEST_BV, deps)
      check(`resource path returns ${id}`, String(result).includes(`错误编号：${id}`), String(result))
    }

    const workdir = path.join(tmpRoot, 'downloads')
    const directoryCases = [
      ['video-007', workdir],
      ['video-008', path.join(workdir, 'cache')],
      ['video-009', path.join(workdir, '.staging')],
    ]
    for (let index = 0; index < directoryCases.length; index += 1) {
      const [id, failedDirectory] = directoryCases[index]
      const videoFs = makeVideoFs({
        mkdir: async (directory, options) => {
          if (path.resolve(String(directory)) === path.resolve(failedDirectory)) throw new Error(`mkdir blocked for ${id}`)
          return fsp.mkdir(directory, options)
        },
      })
      const result = await plugin.downloadAndSend(ctx, makeSession({ guildId: `directory-${index}`, channelId: `directory-${index}` }), TEST_URL, TEST_BV, {
        ...makeDeps(1_000_000, 1_000_000),
        fs: videoFs,
      })
      check(`directory path returns ${id}`, String(result).includes(`错误编号：${id}`), String(result))
    }

    await plugin.clearVideoRuntimeState()
    const formatResult = await plugin.downloadAndSend(ctx, makeSession({ guildId: 'format-empty', channelId: 'format-empty' }), TEST_URL, TEST_BV, {
      resourceGate: false,
      probeVideo: async () => ({ info: sampleInfo({ formats: [] }) }),
    })
    check('empty format result returns video-011 with BV and P1', String(formatResult).includes(`详细信息：${TEST_BV}第1P未找到可用的视频格式`) && String(formatResult).includes('错误编号：video-011'), String(formatResult))

    const previewRejected = await plugin.downloadAndSend(ctx, makeSession({
      guildId: 'preview-rejected',
      channelId: 'preview-rejected',
      async send() { throw new SenderError(1200) },
    }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    check('preview rejection returns video-012 with retcode', String(previewRejected).includes('返回码为1200') && String(previewRejected).includes('错误编号：video-012'), String(previewRejected))

    const previewCallError = await plugin.downloadAndSend(ctx, makeSession({
      guildId: 'preview-call',
      channelId: 'preview-call',
      async send() { throw new Error('preview transport failed') },
    }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    check('preview call error returns video-013', String(previewCallError).includes('错误编号：video-013'), String(previewCallError))

    const stagingCases = [
      ['video-016', { status: 'create_failed', error: new Error('request staging mkdir failed') }],
      ['video-017', { status: 'safety_validation_failed' }],
    ]
    for (let index = 0; index < stagingCases.length; index += 1) {
      const [id, stagingResult] = stagingCases[index]
      const result = await plugin.downloadAndSend(ctx, makeSession({ guildId: `staging-${index}`, channelId: `staging-${index}` }), TEST_URL, TEST_BV, {
        ...makeDeps(1_000_000, 1_000_000),
        createStagingDirectory: async () => stagingResult,
      })
      check(`staging path returns ${id}`, String(result).includes(`错误编号：${id}`), String(result))
    }

    const missingOutput = await plugin.downloadAndSend(ctx, makeSession({ guildId: 'missing-output', channelId: 'missing-output' }), TEST_URL, TEST_BV, {
      resourceGate: false,
      probeVideo: makeProbe(1_000_000),
      run: async () => ({ stdout: '', stderr: '' }),
    })
    check('missing final output returns video-019', String(missingOutput).includes('错误编号：video-019'), String(missingOutput))

    const statFailure = await plugin.downloadAndSend(ctx, makeSession({ guildId: 'stat-failure', channelId: 'stat-failure' }), TEST_URL, TEST_BV, {
      ...makeDeps(1_000_000, 1_000_000),
      fs: makeVideoFs({ stat: async () => { throw new Error('stat failed') } }),
    })
    check('final output stat failure returns video-020', String(statFailure).includes('错误编号：video-020'), String(statFailure))

    const sendRejectedSession = makeSession({
      guildId: 'send-rejected',
      channelId: 'send-rejected',
      async send(message) {
        if (String(message).includes('<video')) throw new SenderError(1200)
        return message
      },
    })
    const sendRejected = await plugin.downloadAndSend(ctx, sendRejectedSession, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    check('first video rejection returns video-022 with retcode', String(sendRejected).includes('返回码为1200') && String(sendRejected).includes('错误编号：video-022'), String(sendRejected))

    await plugin.clearVideoRuntimeState()
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'cache-seed', channelId: 'cache-seed' }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    const cachedCases = [
      ['video-024', async () => { throw new SenderError(1200) }],
      ['video-025', async () => { throw new Error('cached preview failed') }],
      ['video-026', async message => { if (String(message).includes('<video')) throw new SenderError(1200); return message }],
      ['video-027', async message => { if (String(message).includes('<video')) throw new Error('cached video failed'); return message }],
    ]
    for (let index = 0; index < cachedCases.length; index += 1) {
      const [id, send] = cachedCases[index]
      const result = await plugin.downloadAndSend(ctx, makeSession({ guildId: `cached-${index}`, channelId: `cached-${index}`, send }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
      check(`cached send path returns ${id}`, String(result).includes(`错误编号：${id}`), String(result))
    }

    await plugin.clearVideoRuntimeState()
    const uncertainSession = makeSession({
      guildId: 'send-timeout',
      channelId: 'send-timeout',
      async send(message) {
        if (String(message).includes('<video')) throw new TimeoutError()
        return message
      },
    })
    const uncertainResult = await plugin.downloadAndSend(ctx, uncertainSession, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000))
    check('video timeout does not return a contradictory failure', uncertainResult === undefined && plugin.getVideoCacheStatus().entries === 1, JSON.stringify({ uncertainResult, cache: plugin.getVideoCacheStatus() }))

    await ctx.dispose()
  })
}

// 验证 yt-dlp 中间流在错误、signal 和成功路径都由请求目录统一收口。
async function testStagingDownloadLifecycle() {
  section('request staging download lifecycle')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const ctx = makeCtx()
    const workdir = path.join(tmpRoot, 'downloads')
    const cacheDir = path.join(workdir, 'cache')
    const stagingRoot = path.join(workdir, '.staging')

    const refusedSession = makeSession({ guildId: 'refused', channelId: 'refused' })
    const refusedResult = await plugin.downloadAndSend(ctx, refusedSession, TEST_URL, TEST_BV, {
      resourceGate: false,
      probeVideo: makeProbe(1_000_000),
      run: async (_command, args) => {
        const tempDir = getYtdlpPath(args, 'temp')
        createSparseFile(path.join(tempDir, 'fragment.f30032.mp4'), 1024)
        createSparseFile(path.join(tempDir, 'fragment.f30280.m4a'), 512)
        createSparseFile(path.join(tempDir, 'fragment.part'), 128)
        const error = new Error('download failed')
        error.code = 'ECONNREFUSED'
        error.stderr = 'ERROR: media https://cdn.example/video failed after 10 retries'
        throw error
      },
    })
    const refusedLog = ctx.logs.find(entry => entry.msg.includes('video_download_failed:'))
    check('ECONNREFUSED returns controlled failure', String(refusedResult).includes('错误编号：video-018'))
    check('failed split streams leave cache and staging empty', fs.readdirSync(cacheDir).length === 0 && fs.readdirSync(stagingRoot).length === 0)
    check('failure log records exit and cleanup without media URL', refusedLog && refusedLog.msg.includes('exit_code=ECONNREFUSED') && refusedLog.msg.includes('cleanup_ok=true') && refusedLog.msg.includes('[url]') && !refusedLog.msg.includes('cdn.example'), refusedLog && refusedLog.msg)

    await plugin.clearVideoRuntimeState()
    const signalSession = makeSession({ guildId: 'signal', channelId: 'signal' })
    await plugin.downloadAndSend(ctx, signalSession, TEST_URL, TEST_BV, {
      resourceGate: false,
      probeVideo: makeProbe(1_000_000),
      run: async (_command, args) => {
        createSparseFile(path.join(getYtdlpPath(args, 'temp'), 'timeout.part'), 64)
        const error = new Error('command timed out')
        error.code = 'ETIMEDOUT'
        error.signal = 'SIGTERM'
        throw error
      },
    })
    const signalLog = ctx.logs.find(entry => entry.msg.includes('exit_code=ETIMEDOUT'))
    check('timeout signal cleanup removes request staging', fs.readdirSync(stagingRoot).length === 0)
    check('timeout log records signal and cleanup result', signalLog && signalLog.msg.includes('signal=SIGTERM') && signalLog.msg.includes('cleanup_ok=true'), signalLog && signalLog.msg)

    await plugin.clearVideoRuntimeState()
    const counters = { probes: 0, downloads: 0 }
    const successSession = makeSession({ guildId: 'staging-success', channelId: 'staging-success' })
    await plugin.downloadAndSend(ctx, successSession, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000, counters))
    const outputName = counters.args[counters.args.indexOf('-o') + 1]
    check('yt-dlp uses exact home cache directory', getYtdlpPath(counters.args, 'home') === cacheDir, JSON.stringify(counters.args))
    check('yt-dlp uses a unique temp staging directory', path.dirname(getYtdlpPath(counters.args, 'temp')) === stagingRoot, JSON.stringify(counters.args))
    check('yt-dlp output template is a safe basename', !path.isAbsolute(outputName) && path.dirname(outputName) === '.' && /^bili-cache-[a-z0-9]+-\d+-[a-z0-9]+\.%\(ext\)s$/.test(outputName), outputName)
    check('successful download retains only final cache file', fs.readdirSync(cacheDir).length === 1 && fs.readdirSync(stagingRoot).length === 0, JSON.stringify(fs.readdirSync(cacheDir)))
  })
}

// 顺序运行插件测试，避免共享环境变量相互污染。
async function run() {
  await testConfigAndParsing()
  await testChineseUserErrorCatalog()
  await testFormatPicking()
  await testSizeGates()
  await testDuplicateAndCacheReuse()
  await testInflightReuse()
  await testShortLinkNormalization()
  await testCleanupAndSafety()
  await testFailurePaths()
  await testDetailedErrorRouting()
  await testStagingDownloadLifecycle()

  console.log(`\n=== local-video-sender summary ===`)
  console.log(`  passed: ${passed}`)
  console.log(`  failed: ${failed}`)
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
