const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const COOKIE_FILE_MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'cookie-file.js')
const VIDEO_QUEUE_MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'video-task-queue.js')
const VIDEO_TRACE_MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'video-trace.js')
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MAX_SIZE = 60_000_000
const TEST_BV = 'BV1xx411c7mD'
const TEST_URL = `https://www.bilibili.com/video/${TEST_BV}`

let passed = 0
let failed = 0

// 构造一份不含真实凭据且覆盖 HttpOnly 数据行的有效 Netscape Cookie 文件。
function buildValidCookieFile(value = 'test-value') {
  return Buffer.from(`# Netscape HTTP Cookie File\n# test fixture\n#HttpOnly_.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${value}\n`, 'utf8')
}

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
    middlewares: [],
    middleware(handler, prepend = false) {
      this.middlewares.push({ handler, prepend })
    },
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
  process.env.BILI_MIN_MEM_MB = '300'
  process.env.BILI_TEST_VIDEO_FILE = path.join(tmpRoot, 'test-video.mp4')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  fs.writeFileSync(process.env.BILI_COOKIES_FILE, buildValidCookieFile())
  fs.chmodSync(process.env.BILI_COOKIES_FILE, 0o600)
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
    await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

// 验证 Cookie 结构校验、严格 base64、事务失败回滚和运行时自动恢复。
async function testCookieFileBoundary() {
  section('cookie file validation and runtime recovery')
  await withIsolatedPlugin(async ({ plugin, tmpRoot, dataDir }) => {
    const cookieFile = require(COOKIE_FILE_MODULE_PATH)
    const valid = buildValidCookieFile()
    const httpOnly = cookieFile.validateNetscapeCookieFile(valid)
    check('standard Netscape file accepts HttpOnly data row', httpOnly.ok && httpOnly.recordCount === 1, JSON.stringify(httpOnly))

    const emptyValue = cookieFile.validateNetscapeCookieFile(buildValidCookieFile(''))
    check('empty Cookie value remains valid', emptyValue.ok && emptyValue.recordCount === 1, JSON.stringify(emptyValue))

    const invalidFixtures = [
      ['zero bytes', Buffer.alloc(0), 'empty_file'],
      ['missing header', Buffer.from('example.com\tTRUE\t/\tFALSE\t0\tname\tvalue\n'), 'missing_header'],
      ['empty records', Buffer.from('# Netscape HTTP Cookie File\n# comment\n'), 'empty_records'],
      ['six columns', Buffer.from('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tname\n'), 'invalid_column_count'],
      ['eight columns', Buffer.from('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue\textra\n'), 'invalid_column_count'],
      ['invalid boolean', Buffer.from('# Netscape HTTP Cookie File\n.example.com\tYES\t/\tFALSE\t0\tname\tvalue\n'), 'invalid_boolean'],
      ['invalid expires', Buffer.from('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t-1\tname\tvalue\n'), 'invalid_expires'],
      ['NUL byte', Buffer.concat([valid, Buffer.from([0])]), 'nul_byte'],
    ]
    for (const [label, fixture, code] of invalidFixtures) {
      const result = cookieFile.validateNetscapeCookieFile(fixture)
      check(`${label} is rejected with ${code}`, !result.ok && result.code === code, JSON.stringify(result))
    }

    const encoded = valid.toString('base64')
    check('strict base64 accepts canonical payload', cookieFile.decodeStrictBase64(encoded, valid.length).ok)
    check('strict base64 rejects illegal characters', cookieFile.decodeStrictBase64(`${encoded.slice(0, -2)}!?`, valid.length + 10).code === 'invalid_base64')
    check('strict base64 rejects decoded oversize', cookieFile.decodeStrictBase64(encoded, valid.length - 1).code === 'file_too_large')

    const target = path.join(tmpRoot, 'atomic-cookies.txt')
    const oldBuffer = buildValidCookieFile('old-value')
    fs.writeFileSync(target, oldBuffer)
    const oldHash = require('crypto').createHash('sha256').update(oldBuffer).digest('hex')
    const stages = [
      ['write', 'writeFileSync'],
      ['sync', 'fsyncSync'],
      ['rename', 'renameSync'],
      ['chmod', 'chmodSync'],
    ]
    for (const [label, method] of stages) {
      const fsApi = Object.create(fs)
      fsApi[method] = () => { throw Object.assign(new Error(`${label} injected`), { code: 'EIO' }) }
      try { cookieFile.replaceBiliCookieFileAtomic(target, buildValidCookieFile(`new-${label}`), { fsApi, randomBytes: () => Buffer.alloc(8, 1) }) } catch {}
      const currentHash = require('crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      const leftovers = fs.readdirSync(tmpRoot).filter(name => name.includes('atomic-cookies.txt') && name.endsWith('.tmp'))
      check(`${label} failure preserves old file and removes transaction files`, currentHash === oldHash && leftovers.length === 0, JSON.stringify({ currentHash, oldHash, leftovers }))
    }

    const written = cookieFile.replaceBiliCookieFileAtomic(target, buildValidCookieFile('new-value'))
    check('successful atomic replacement writes mode 600 and validated summary', written.mode === 0o600 && written.recordCount === 1 && written.path === path.resolve(target), JSON.stringify(written))
    check('default runtime and Dashboard path rule is identical', cookieFile.resolveBiliCookiePath(dataDir, '') === path.join(dataDir, 'bilibili-cookies.txt'))

    const runtimeCookie = plugin.getRuntimeConfig().cookies
    fs.writeFileSync(runtimeCookie, Buffer.alloc(0))
    const counters = { probes: 0, downloads: 0 }
    const invalidResult = await plugin.downloadAndSend(makeCtx(), makeSession({ guildId: 'cookie-invalid', channelId: 'cookie-invalid' }), TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, counters))
    check('invalid runtime Cookie returns video-030 before probe or download', String(invalidResult).includes('video-030') && counters.probes === 0 && counters.downloads === 0, JSON.stringify({ invalidResult, counters }))

    fs.writeFileSync(runtimeCookie, valid)
    const recoveredResult = await plugin.downloadAndSend(makeCtx(), makeSession({ guildId: 'cookie-recovered', channelId: 'cookie-recovered' }), TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, counters))
    check('restoring a valid Cookie recovers without plugin reload', recoveredResult === undefined && counters.probes === 1 && counters.downloads === 1, JSON.stringify({ recoveredResult, counters }))
  })
}

// 验证 S0 存储故障统一返回 video-032，并按合并键通知全部管理员且支持最后有效名单缓存。
async function testResourceGateStorageAlerts() {
  section('resource gate storage failures and admin alerts')
  await withIsolatedPlugin(async ({ plugin, dataDir }) => {
    const adminIdsFile = path.join(dataDir, 'ai-admin-ids.json')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(adminIdsFile, JSON.stringify(['111', '222']), 'utf8')
    const privateCalls = []
    const ctx = makeCtx()
    const session = makeSession({
      guildId: 'gate-storage',
      channelId: 'gate-storage',
      bot: { internal: { async sendPrivateMsg(userId, message) { privateCalls.push({ userId: String(userId), message: String(message) }) } } },
    })
    const errnoCases = {
      EACCES: 'gate_permission_denied',
      EROFS: 'gate_readonly_filesystem',
      ENOSPC: 'gate_storage_full',
      EDQUOT: 'gate_quota_exceeded',
      ENOTDIR: 'gate_path_invalid',
      EMFILE: 'gate_fd_exhausted',
      EIO: 'gate_io_error',
    }
    const gateModule = require(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-gate', 'gate.js'))
    for (const [errno, expected] of Object.entries(errnoCases)) {
      const classified = gateModule.classifyGateStorageError(Object.assign(new Error(errno), { code: errno }), 'test_stage', gateModule.LOCK_META_FILE)
      check(`${errno} maps to ${expected}`, classified.failureCode === expected && classified.errno === errno && classified.safePath === 'lock/meta.json', JSON.stringify(classified))
    }

    const gateRollbackScript = `
      const fs = require('fs')
      const path = require('path')
      const gate = require(${JSON.stringify(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-gate', 'gate.js'))})
      const originalAppend = fs.appendFileSync
      const originalWrite = fs.writeFileSync
      let appendCalls = 0
      let lockVisibleDuringMetaWrite = null
      fs.writeFileSync = (...args) => {
        if (path.basename(String(args[0])).startsWith('meta.json.')) lockVisibleDuringMetaWrite = fs.existsSync(gate.LOCK_DIR)
        return originalWrite(...args)
      }
      fs.appendFileSync = (...args) => {
        appendCalls += 1
        if (appendCalls === 2) throw Object.assign(new Error('event write injected'), { code: 'EIO' })
        return originalAppend(...args)
      }
      ;(async () => {
        let failure = null
        try {
          await gate.acquireResourceGate({ taskId: 'rollback-test', kind: 'external_video_download', waitTimeoutMs: 50, pollMs: 200 })
        } catch (error) {
          failure = { failureCode: error.failureCode, errno: error.errno, stage: error.stage }
        } finally {
          fs.appendFileSync = originalAppend
          fs.writeFileSync = originalWrite
        }
        const tickets = fs.existsSync(gate.TICKETS_DIR) ? fs.readdirSync(gate.TICKETS_DIR).filter(name => name.endsWith('.json')) : []
        console.log(JSON.stringify({ failure, lockExists: fs.existsSync(gate.LOCK_DIR), lockVisibleDuringMetaWrite, tickets }))
      })().catch(error => { console.error(error); process.exit(1) })
    `
    const rollbackOutput = require('child_process').execFileSync(process.execPath, ['-e', gateRollbackScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: path.join(dataDir, 'gate-rollback') },
      encoding: 'utf8',
    }).trim().split(/\r?\n/).pop()
    const rollbackSummary = JSON.parse(rollbackOutput)
    check('lock event failure rolls back lock directory and ticket', rollbackSummary.failure?.failureCode === 'gate_event_write_failed' && rollbackSummary.failure?.errno === 'EIO' && rollbackSummary.lockExists === false && rollbackSummary.tickets.length === 0, JSON.stringify(rollbackSummary))
    check('lock metadata is complete before the formal lock directory becomes visible', rollbackSummary.lockVisibleDuringMetaWrite === false, JSON.stringify(rollbackSummary))

    const missingMetaScript = `
      const fs = require('fs')
      const gate = require(${JSON.stringify(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-gate', 'gate.js'))})
      fs.mkdirSync(gate.LOCK_DIR, { recursive: true })
      let failure = null
      try { gate.readLockMeta() } catch (error) { failure = { failureCode: error.failureCode, errno: error.errno, stage: error.stage } }
      console.log(JSON.stringify(failure))
    `
    const missingMetaOutput = require('child_process').execFileSync(process.execPath, ['-e', missingMetaScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: path.join(dataDir, 'gate-missing-meta') },
      encoding: 'utf8',
    }).trim().split(/\r?\n/).pop()
    const missingMeta = JSON.parse(missingMetaOutput)
    check('lock directory without metadata is a state failure instead of ordinary busy', missingMeta?.failureCode === 'gate_state_unreadable' && missingMeta?.errno === 'MISSING_LOCK_META' && missingMeta?.stage === 'lock_meta_read', JSON.stringify(missingMeta))

    const failures = [
      ['gate_permission_denied', 'EACCES'],
      ['gate_readonly_filesystem', 'EROFS'],
      ['gate_storage_full', 'ENOSPC'],
      ['gate_quota_exceeded', 'EDQUOT'],
      ['gate_path_invalid', 'ENOTDIR'],
      ['gate_fd_exhausted', 'EMFILE'],
      ['gate_io_error', 'EIO'],
      ['gate_state_unreadable', 'INVALID_STATE'],
      ['gate_event_write_failed', 'EIO'],
      ['gate_cleanup_failed', 'EACCES'],
    ]
    for (let index = 0; index < failures.length; index += 1) {
      const [failureCode, errno] = failures[index]
      const counters = { probes: 0, downloads: 0 }
      const result = await plugin.downloadAndSend(ctx, { ...session, guildId: `gate-${index}`, channelId: `gate-${index}` }, TEST_URL, `${TEST_BV}-${index}`, makeDeps(50_000_000, 30_000_000, counters, {
        resourceGate: undefined,
        resourceModules: makeResourceModules({ decision: 'run_now', resourceState: 'green', memAvailableMb: 1000 }, async () => {
          throw Object.assign(new Error('secret https://example.invalid/path?token=x'), { failureCode, errno, stage: 'ticket_write', safePath: 'tickets/test.json' })
        }),
        gateAdminAlertOptions: { adminIdsFile },
      }))
      check(`${failureCode} returns video-032 without media work`, String(result).includes('video-032') && counters.probes === 0 && counters.downloads === 0, JSON.stringify({ result, counters }))
    }
    check('each distinct gate failure immediately alerts both administrators', privateCalls.length === failures.length * 2, JSON.stringify(privateCalls))
    const firstAlert = privateCalls[0]?.message || ''
    check('gate alert contains complete sanitized evidence', firstAlert.includes('中文原因：资源锁路径权限不足') && firstAlert.includes('内部代码：gate_permission_denied') && firstAlert.includes('系统错误码：EACCES') && firstAlert.includes('失败步骤：ticket_write') && firstAlert.includes('脱敏路径：tickets/test.json') && firstAlert.includes('本次任务未入队') && !firstAlert.includes('example.invalid'), firstAlert)

    const postAcquireStart = privateCalls.length
    let postAcquireReleaseCalls = 0
    const postAcquireCounters = { probes: 0, downloads: 0 }
    const postAcquireResult = await plugin.downloadAndSend(ctx, { ...session, guildId: 'gate-post-acquire', channelId: 'gate-post-acquire' }, TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, postAcquireCounters, {
      resourceGate: undefined,
      resourceModules: makeResourceModules({ decision: 'run_now', resourceState: 'green', memAvailableMb: 1000 }, async () => ({
        updateStep() { throw Object.assign(new Error('heartbeat failed'), { failureCode: 'gate_io_error', errno: 'EIO', stage: 'post_acquire_update', safePath: 'lock/meta.json' }) },
        release() { postAcquireReleaseCalls += 1 },
      })),
      gateAdminAlertOptions: { adminIdsFile },
    }))
    check('post-acquire storage failure returns video-032, releases once, and skips media work', String(postAcquireResult).includes('video-032') && postAcquireReleaseCalls === 1 && postAcquireCounters.probes === 0 && postAcquireCounters.downloads === 0, JSON.stringify({ postAcquireResult, postAcquireReleaseCalls, postAcquireCounters }))
    check('post-acquire storage failure alerts every administrator', privateCalls.length === postAcquireStart + 2)

    const releaseFailureStart = privateCalls.length
    const releaseFailureCtx = makeCtx()
    const releaseFailureCounters = { probes: 0, downloads: 0 }
    const releaseFailureResult = await plugin.downloadAndSend(releaseFailureCtx, { ...session, guildId: 'gate-release', channelId: 'gate-release' }, TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000, releaseFailureCounters, {
      resourceGate: undefined,
      resourceModules: makeResourceModules({ decision: 'run_now', resourceState: 'green', memAvailableMb: 1000 }, async () => ({
        updateStep() {},
        release() { throw Object.assign(new Error('event log failed'), { failureCode: 'gate_event_write_failed', errno: 'EIO', stage: 'release_event', safePath: 'events.jsonl' }) },
      })),
      gateAdminAlertOptions: { adminIdsFile },
    }))
    const releaseTraceEvents = releaseFailureCtx.logs.filter(entry => entry.msg.startsWith('video_trace ')).map(entry => entry.msg)
    const releaseFailureIndex = releaseTraceEvents.findIndex(line => line.includes('event="gate_storage_failed"'))
    const releaseTerminalIndex = releaseTraceEvents.findIndex(line => line.includes('event="terminal_status"'))
    check('release storage failure preserves confirmed send result and reports the fault before terminal', releaseFailureResult === undefined && releaseFailureCounters.downloads === 1 && releaseFailureIndex >= 0 && releaseTerminalIndex > releaseFailureIndex, JSON.stringify(releaseTraceEvents))
    check('release storage failure alerts every administrator', privateCalls.length === releaseFailureStart + 2)

    const repeatedFailure = { failureCode: 'gate_permission_denied', errno: 'EACCES', stage: 'repeat_stage', safePath: 'tickets/repeat.json' }
    await plugin.reportResourceGateStorageFailure(ctx, session, repeatedFailure, 'trace-repeat-1', 'task-repeat-1', { adminIdsFile })
    await plugin.reportResourceGateStorageFailure(ctx, session, repeatedFailure, 'trace-repeat-2', 'task-repeat-2', { adminIdsFile })
    const repeatKey = 'gate_permission_denied|EACCES|repeat_stage|tickets/repeat.json'
    const beforeSummary = privateCalls.length
    await plugin.flushGateAdminAlertWindow(repeatKey)
    check('same merge key sends one immediate alert and one summary to each admin', privateCalls.length === beforeSummary + 2 && privateCalls.slice(-2).every(call => call.message.includes('总次数：2')), JSON.stringify(privateCalls.slice(-4)))
    check('suppressed repeat is written to structured log', ctx.logs.some(entry => entry.msg.includes('gate_admin_alert_suppressed') && entry.msg.includes('count=2')))

    fs.rmSync(adminIdsFile, { force: true })
    const cachedBefore = privateCalls.length
    await plugin.reportResourceGateStorageFailure(ctx, session, { failureCode: 'gate_io_error', errno: 'EIO', stage: 'cached_admins', safePath: 'lock/meta.json' }, 'trace-cache', 'task-cache', { adminIdsFile })
    check('unreadable admin file falls back to last valid administrator list', privateCalls.length === cachedBefore + 2 && ctx.logs.some(entry => entry.msg.includes('gate_admin_ids_unavailable') && entry.msg.includes('cached_count=2')))

    const failingCtx = makeCtx()
    fs.writeFileSync(adminIdsFile, JSON.stringify(['333']), 'utf8')
    const failingSession = makeSession({ bot: { internal: { async sendPrivateMsg() { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }) } } } })
    await plugin.reportResourceGateStorageFailure(failingCtx, failingSession, { failureCode: 'gate_storage_full', errno: 'ENOSPC', stage: 'notify_failure', safePath: 'events.jsonl' }, 'trace-notify', 'task-notify', { adminIdsFile })
    check('private-message failure logs once without recursive or false sent event', failingCtx.logs.filter(entry => entry.msg.includes('gate_admin_notify_failed')).length === 1 && !failingCtx.logs.some(entry => entry.msg.includes('gate_admin_alert_sent')))
  })
}

// 验证 S2 真队列的接口门禁、原子容量、全状态确认、FIFO 单执行者和重启取消规则。
async function testPersistentVideoTaskQueue() {
  section('persistent cross-group video queue')
  const queueModule = require(VIDEO_QUEUE_MODULE_PATH)

  const unavailable = queueModule.createVideoTaskQueue({ store: {}, execute: async () => ({ status: 'done' }) })
  const unavailableStartup = unavailable.initialize()
  const unavailableResult = await unavailable.enqueue(makeQueueInput(1))
  check('missing required task-store interface disables queue and never claims persistence', unavailableStartup.available === false && unavailableResult.status === 'unavailable', JSON.stringify({ unavailableStartup, unavailableResult }))
  unavailable.dispose()

  const failedStore = makeVideoTaskStore({ failBeforePersist: true })
  const failedQueue = queueModule.createVideoTaskQueue({ store: failedStore, execute: async () => ({ status: 'done' }) })
  failedQueue.initialize()
  const failedPersist = await failedQueue.enqueue(makeQueueInput(2))
  check('submit failure with no task found returns persist_failed', failedPersist.status === 'persist_failed' && failedStore.tasks.size === 0, JSON.stringify(failedPersist))
  failedQueue.dispose()

  const uncertainStore = makeVideoTaskStore({ failAfterPersist: true })
  const uncertainQueue = queueModule.createVideoTaskQueue({ store: uncertainStore, execute: async () => ({ status: 'done' }) })
  uncertainQueue.initialize()
  const confirmedAfterThrow = await uncertainQueue.enqueue(makeQueueInput(3))
  check('submit error followed by all-state lookup preserves real queued task', confirmedAfterThrow.status === 'queued' && uncertainStore.getResourceTaskById('video-task-3')?.status === 'pending', JSON.stringify(confirmedAfterThrow))
  uncertainQueue.dispose()

  const capacityStore = makeVideoTaskStore()
  const capacityQueue = queueModule.createVideoTaskQueue({ store: capacityStore, execute: async () => ({ status: 'done' }) })
  capacityQueue.initialize()
  capacityStore.submitResourceTask({ ...makeQueueInput(90), id: 'running-video', kind: 'external_video_download', payload: makeQueueInput(90), notify: {} })
  capacityStore.tasks.get('running-video').status = 'running'
  const concurrentResults = await Promise.all(Array.from({ length: 11 }, (_, index) => capacityQueue.enqueue(makeQueueInput(index + 10))))
  const queuedResults = concurrentResults.filter(result => result.status === 'queued')
  const fullResults = concurrentResults.filter(result => result.status === 'full')
  const waitingTasks = [...capacityStore.tasks.values()].filter(task => ['pending', 'deferred'].includes(task.status))
  check('one running video does not consume ten waiting positions', capacityStore.tasks.get('running-video').status === 'running' && queuedResults.length === 10 && waitingTasks.length === 10, JSON.stringify(concurrentResults))
  check('eleventh concurrent waiter is rejected without persistence', fullResults.length === 1 && !capacityStore.tasks.has('video-task-20'), JSON.stringify(concurrentResults))
  check('serialized count-and-write never exceeds global capacity', capacityQueue.status().waiting === 10, JSON.stringify(capacityQueue.status()))
  const persistedPayload = capacityStore.getResourceTaskById('video-task-10').payload
  check('persisted payload contains only planned safe video fields', Object.keys(persistedPayload).sort().join(',') === 'bvId,inputType,p1Url,requestedAt,retryCount,targetId,targetType,traceId' && !JSON.stringify(persistedPayload).includes('Cookie'), JSON.stringify(persistedPayload))
  capacityQueue.dispose()

  const orderStore = makeVideoTaskStore()
  let active = 0
  let maxActive = 0
  const order = []
  const orderQueue = queueModule.createVideoTaskQueue({
    store: orderStore,
    schedule: handler => setTimeout(handler, 0),
    execute: async task => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(task.id)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { status: 'done' }
    },
  })
  orderQueue.initialize()
  await orderQueue.enqueue(makeQueueInput(30))
  await orderQueue.enqueue(makeQueueInput(31))
  await orderQueue.enqueue(makeQueueInput(32))
  orderQueue.kick()
  await waitFor(() => [...orderStore.tasks.values()].filter(task => task.status === 'done').length === 3, 2000)
  check('runner executes cross-group tasks strictly FIFO with one active video', order.join(',') === 'video-task-30,video-task-31,video-task-32' && maxActive === 1, JSON.stringify({ order, maxActive }))
  orderQueue.dispose()

  const restartStore = makeVideoTaskStore()
  for (const [index, status] of ['pending', 'deferred', 'claiming', 'running'].entries()) {
    const task = restartStore.submitResourceTask({ ...makeQueueInput(40 + index), id: `restart-video-${status}`, kind: 'external_video_download', payload: makeQueueInput(40 + index), notify: {} })
    restartStore.tasks.get(task.id).status = status
  }
  const otherTask = restartStore.submitResourceTask({ id: 'other-ai-task', kind: 'agent_task', payload: {}, notify: {} })
  const restartTerminals = []
  const restartQueue = queueModule.createVideoTaskQueue({
    store: restartStore,
    execute: async () => ({ status: 'done' }),
    onTerminal: (task, status, reason) => restartTerminals.push({ taskId: task.id, status, reason }),
  })
  const restart = restartQueue.initialize()
  check('startup cancels all four old video active states with restart_discarded', restart.cancelled === 4 && [...restartStore.tasks.values()].filter(task => task.kind === 'external_video_download').every(task => task.status === 'cancelled' && task.error === 'restart_discarded'), JSON.stringify([...restartStore.tasks.values()]))
  check('startup cancellation reports one cancelled terminal per old video trace', restartTerminals.length === 4 && restartTerminals.every(item => item.status === 'cancelled' && item.reason === 'restart_discarded'), JSON.stringify(restartTerminals))
  check('startup video cleanup leaves other AI tasks unchanged', restartStore.getResourceTaskById(otherTask.id).status === 'pending')
  restartQueue.dispose()
}

// 验证真实入口先落盘后回执、S0 普通超时转队列、原目标发送和失败通知单次重试。
async function testQueuedVideoLifecycleIntegration() {
  section('queued video lifecycle integration')

  // 复现真实 task-store 会把提交 ID 中冒号改写为下划线的完整短链排队链路。
  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore({ normalizeTaskId: true })
    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0 }
    let admissions = 0
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'exclusive slot is busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    const source = 'https://b23.tv/mKn7Jkw'
    const session = makeSession({ guildId: 'queue-normalized-id', channelId: 'queue-normalized-id' })
    await plugin.downloadAndSend(ctx, session, source, source, makeDeps(50_000_000, 30_000_000, counters, {
      resourceGate: undefined,
      resourceModules,
      taskStore: store,
      resolveShortLink: async () => ({ ok: true, p1Url: `${TEST_URL}?p=1`, hops: 1 }),
    }))
    const submittedTaskId = store.submittedTaskIds[0]
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'done', 2000)
    const traceLines = ctx.logs.filter(entry => entry.msg.startsWith('video_trace ')).map(entry => entry.msg)
    check('task store normalization changes the submitted URL-bearing task id', submittedTaskId.includes(':') && task.id !== submittedTaskId && !task.id.includes(':'), JSON.stringify({ submittedTaskId, actualTaskId: task.id }))
    check('normalized task id stays linked through queue persistence and done terminal logs', traceLines.some(line => line.includes('event="queue_persisted"') && line.includes(`taskId="${task.id}"`)) && traceLines.some(line => line.includes('event="terminal_status"') && line.includes(`taskId="${task.id}"`) && line.includes('status="done"')), JSON.stringify(traceLines))
    check('normalized task id queue executes exactly one download and one video send', counters.probes === 1 && counters.downloads === 1 && session.sent.filter(message => message.includes('file:')).length === 1, JSON.stringify({ counters, sent: session.sent }))
    check('normalized task id queue finishes without invalid payload failure or active residue', store.getResourceTaskById(task.id)?.status === 'done' && !traceLines.some(line => line.includes('invalid_video_task_payload')) && [...store.tasks.values()].every(item => !['pending', 'claiming', 'running', 'deferred'].includes(item.status)), JSON.stringify({ task: store.getResourceTaskById(task.id), traceLines }))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore()
    const counters = { probes: 0, downloads: 0 }
    let admissions = 0
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'exclusive slot is busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    const session = makeSession({ guildId: 'queue-origin-a', channelId: 'queue-origin-a' })
    await plugin.downloadAndSend(makeCtx(), session, TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, counters, { resourceGate: undefined, resourceModules, taskStore: store }))
    const task = [...store.tasks.values()][0]
    check('busy request acknowledges queue position without exposing task id', !!task && session.sent[0] === '视频任务已排队，当前等待 1/10。' && !session.sent[0]?.includes(task.id), JSON.stringify({ task, sent: session.sent }))
    await waitFor(() => store.getResourceTaskById(task.id)?.status === 'done', 2000)
    check('queued task executes once and sends preview/video to original group session', counters.probes === 1 && counters.downloads === 1 && session.sent.length === 3 && session.sent[1].includes('Demo Video') && session.sent[2].includes('file:'), JSON.stringify({ counters, sent: session.sent }))
    check('persisted target identifies original group without retaining message body', task.payload.targetType === 'group' && task.payload.targetId === 'queue-origin-a' && !Object.keys(task.payload).some(key => /content|session|cookie|message/i.test(key)), JSON.stringify(task.payload))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore()
    let gateCalls = 0
    const resourceModules = {
      admitTask: () => ({ decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => {
        gateCalls += 1
        if (gateCalls === 1) throw Object.assign(new Error('ordinary competition'), { code: 'gate_busy_timeout' })
        return { updateStep() {}, release() {} }
      },
    }
    const session = makeSession({ guildId: 's0-timeout', channelId: 's0-timeout' })
    await plugin.downloadAndSend(makeCtx(), session, TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, null, { resourceGate: undefined, resourceModules, taskStore: store }))
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'done', 2000)
    check('healthy S0 competition timeout enters real queue instead of video-006', gateCalls === 2 && session.sent.some(message => message.includes('视频任务已排队')) && !session.sent.some(message => message.includes('video-006')), JSON.stringify({ gateCalls, sent: session.sent }))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore()
    const counters = { probes: 0, downloads: 0 }
    let admissions = 0
    let sendCalls = 0
    let delayMs = 0
    const session = makeSession({
      guildId: 'queue-failure',
      channelId: 'queue-failure',
      async send(message) {
        sendCalls += 1
        if (sendCalls === 1) return message
        throw new Error('terminal notice send failed')
      },
    })
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    const deps = makeDeps(50_000_000, 30_000_000, counters, {
      resourceGate: undefined,
      resourceModules,
      taskStore: store,
      probeVideo: async () => { counters.probes += 1; throw new Error('probe failed') },
      finalNoticeDelay: async value => { delayMs = value },
    })
    await plugin.downloadAndSend(makeCtx(), session, TEST_URL, TEST_BV, deps)
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'failed' && sendCalls === 3, 2000)
    check('queued terminal failure retries text exactly once after 10 seconds', sendCalls === 3 && delayMs === 10_000 && counters.probes === 1 && counters.downloads === 0, JSON.stringify({ sendCalls, delayMs, counters }))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore()
    let admissions = 0
    let sends = 0
    const session = makeSession({
      guildId: 'queue-ack-failure',
      channelId: 'queue-ack-failure',
      async send(message) {
        sends += 1
        if (sends === 1) throw new Error('queue acknowledgement failed')
        return message
      },
    })
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    await plugin.downloadAndSend(makeCtx(), session, TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, null, { resourceGate: undefined, resourceModules, taskStore: store }))
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'done', 2000)
    check('queue acknowledgement failure does not delete or stop persisted task', store.getResourceTaskById(task.id)?.status === 'done' && sends === 3, JSON.stringify({ task: store.getResourceTaskById(task.id), sends }))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore({ statusAfterPersist: 'running' })
    const resourceModules = {
      admitTask: () => ({ decision: 'queue', reason: 'busy', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    const session = makeSession({ guildId: 'queue-fast-running', channelId: 'queue-fast-running' })
    await plugin.downloadAndSend(makeCtx(), session, TEST_URL, TEST_BV, makeDeps(50_000_000, 30_000_000, null, { resourceGate: undefined, resourceModules, taskStore: store }))
    const task = [...store.tasks.values()][0]
    check('all-state confirmation reports a rapidly running task without claiming it is waiting', task?.status === 'running' && session.sent.some(message => message.includes('已保存并开始处理')) && !session.sent.some(message => message.includes('已排队')), JSON.stringify({ task, sent: session.sent }))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const store = makeVideoTaskStore()
    const counters = { probes: 0, downloads: 0 }
    let admissions = 0
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    const session = makeSession({ guildId: 'queue-short-link', channelId: 'queue-short-link' })
    await plugin.downloadAndSend(makeCtx(), session, 'https://b23.tv/queueShort', 'https://b23.tv/queueShort', makeDeps(50_000_000, 30_000_000, counters, {
      resourceGate: undefined,
      resourceModules,
      taskStore: store,
      resolveShortLink: async () => ({ ok: true, p1Url: `${TEST_URL}?p=1`, hops: 1 }),
    }))
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'done', 2000)
    check('queued short link preserves its original input type without persisting dedupe keys', task?.payload?.inputType === 'short_link' && !Object.prototype.hasOwnProperty.call(task.payload, 'keys'), JSON.stringify(task?.payload))
  })
}

// 验证 trace 字段脱敏、唯一终态以及排队前后沿用同一链路编号。
async function testVideoTraceLifecycle() {
  section('video trace lifecycle')
  const traceModule = require(VIDEO_TRACE_MODULE_PATH)
  traceModule.clearVideoTraceState()
  const unitLines = []
  const logger = { warn: message => unitLines.push(String(message)) }
  const unitTrace = traceModule.createVideoTrace({ traceId: 'trace-unit', taskId: 'task-unit', inputType: 'short_link', videoKey: `${TEST_URL}?token=secret` })
  const expectedEvents = ['input_detected', 'input_normalized', 'input_rejected', 'cookie_health_checked', 'shortlink_hop', 'shortlink_failed', 'admission_decided', 'queue_write_started', 'queue_persisted', 'queue_persist_failed', 'gate_acquired', 'gate_released', 'gate_storage_failed', 'gate_admin_alert_sent', 'gate_admin_alert_suppressed', 'gate_admin_alert_summary', 'probe_started', 'probe_finished', 'download_started', 'download_finished', 'preview_send_finished', 'video_send_finished', 'terminal_status']
  const firstTerminal = traceModule.writeVideoTrace(logger, unitTrace, 'terminal_status', { status: 'done', reason: `Cookie=secret https://example.invalid/path?token=secret C:\\tmp\\bilibili-cookies.txt` })
  const duplicateTerminal = traceModule.writeVideoTrace(logger, unitTrace, 'terminal_status', { status: 'failed', reason: 'must not be written' })
  const invalidTerminal = traceModule.writeVideoTrace(logger, traceModule.createVideoTrace({ traceId: 'trace-invalid' }), 'terminal_status', { status: 'queued' })
  check('trace module accepts one legal terminal and rejects duplicate or illegal terminal values', firstTerminal && !duplicateTerminal && !invalidTerminal && traceModule.getVideoTerminalTraceCount() === 1, JSON.stringify(unitLines))
  check('trace module exposes only the fixed planned event set', JSON.stringify(traceModule.VIDEO_TRACE_EVENTS) === JSON.stringify(expectedEvents), JSON.stringify(traceModule.VIDEO_TRACE_EVENTS))
  check('trace module hashes video keys and removes Cookie, URL query, and credential values', unitLines.length === 1 && unitLines[0].includes('videoKeyHash=') && !unitLines[0].includes('secret') && !unitLines[0].includes('example.invalid') && !unitLines[0].includes('bilibili-cookies'), unitLines[0])

  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0 }
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'trace-direct', channelId: 'trace-direct' }), `${TEST_URL}?token=hidden`, `分析一下 ${TEST_URL}?token=hidden`, makeDeps(1_000_000, 1_000_000, counters))
    const lines = ctx.logs.filter(entry => entry.msg.startsWith('video_trace ')).map(entry => entry.msg)
    const events = lines.map(line => line.match(/event="([^"]+)"/)?.[1]).filter(Boolean)
    const required = ['input_detected', 'input_normalized', 'cookie_health_checked', 'admission_decided', 'gate_acquired', 'probe_started', 'probe_finished', 'preview_send_finished', 'download_started', 'download_finished', 'video_send_finished', 'gate_released', 'terminal_status']
    check('direct execution emits the planned lifecycle event set', required.every(event => events.includes(event)), JSON.stringify(events))
    check('direct execution writes exactly one done terminal with its taskId', events.filter(event => event === 'terminal_status').length === 1 && lines.some(line => line.includes('event="terminal_status"') && line.includes('status="done"') && !line.includes('taskId=""')), JSON.stringify(lines))
    check('direct trace logs omit full URL query, Cookie path, and user text', lines.every(line => !line.includes('token=hidden') && !line.includes('bilibili-cookies') && !line.includes('分析一下')), JSON.stringify(lines))
  })

  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const store = makeVideoTaskStore()
    let admissions = 0
    const resourceModules = {
      admitTask: () => (++admissions % 2 === 1
        ? { decision: 'queue', reason: 'exclusive slot is busy', resourceState: 'green', memAvailableMb: 1000 }
        : { decision: 'run_now', reason: 'available', resourceState: 'green', memAvailableMb: 1000 }),
      acquireResourceGate: async () => ({ updateStep() {}, release() {} }),
    }
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'trace-queue', channelId: 'trace-queue' }), TEST_URL, TEST_BV, makeDeps(1_000_000, 1_000_000, null, { resourceGate: undefined, resourceModules, taskStore: store }))
    const task = [...store.tasks.values()][0]
    await waitFor(() => task && store.getResourceTaskById(task.id)?.status === 'done', 2000)
    const traceId = String(task?.payload?.traceId || '')
    const lines = ctx.logs.filter(entry => entry.msg.startsWith('video_trace ') && entry.msg.includes(`traceId="${traceId}"`)).map(entry => entry.msg)
    const events = lines.map(line => line.match(/event="([^"]+)"/)?.[1]).filter(Boolean)
    const persistedIndex = events.indexOf('queue_persisted')
    const terminalIndex = events.lastIndexOf('terminal_status')
    check('queued task keeps a traceId distinct from taskId and links both after persistence', !!traceId && traceId !== task.id && lines.some(line => line.includes('event="queue_persisted"') && line.includes(`taskId="${task.id}"`)), JSON.stringify({ traceId, taskId: task.id, lines }))
    check('queue persistence is a process event followed by one done terminal on the same trace', persistedIndex >= 0 && terminalIndex > persistedIndex && events.filter(event => event === 'terminal_status').length === 1 && lines[terminalIndex].includes('status="done"'), JSON.stringify(events))
  })
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

// 创建可精确覆写暂存目录检查和删除阶段的文件系统替身。
function makeStagingFs(overrides = {}) {
  return {
    lstat: (...args) => fsp.lstat(...args),
    realpath: (...args) => fsp.realpath(...args),
    rm: (...args) => fsp.rm(...args),
    stat: (...args) => fsp.stat(...args),
    readFile: (...args) => fsp.readFile(...args),
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

// 创建只在内存中保存状态的 S2 task-store，用于并发容量和 runner 行为测试。
function makeVideoTaskStore(options = {}) {
  const tasks = new Map()
  const submittedTaskIds = []
  let sequence = 0
  const copy = task => task ? { ...task, payload: { ...task.payload }, notify: { ...task.notify } } : null
  const store = {
    tasks,
    submittedTaskIds,
    submitResourceTask(input) {
      if (options.failBeforePersist) throw new Error('submit failed before persist')
      const now = new Date(Date.now() + sequence++).toISOString()
      const submittedTaskId = String(input.id)
      const taskId = options.normalizeTaskId
        ? submittedTaskId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160)
        : submittedTaskId
      submittedTaskIds.push(submittedTaskId)
      const task = {
        id: taskId, kind: String(input.kind), status: 'pending', source: String(input.source || ''),
        channelKey: String(input.channelKey || ''), userId: String(input.userId || ''), priority: Number(input.priority || 50),
        createdAt: now, updatedAt: now, expiresAt: String(input.expiresAt || ''), timeoutMs: Number(input.timeoutMs || 0),
        payload: { ...(input.payload || {}) }, notify: { ...(input.notify || {}) },
      }
      tasks.set(task.id, task)
      if (options.statusAfterPersist) task.status = String(options.statusAfterPersist)
      if (options.failAfterPersist) throw new Error('submit event failed after persist')
      return copy(task)
    },
    getResourceTaskById(taskId) { return copy(tasks.get(String(taskId))) },
    countResourceTasksByKind({ kind, statuses = [], limit = 20000 }) {
      return [...tasks.values()].filter(task => task.kind === kind && statuses.includes(task.status)).slice(0, limit).length
    },
    claimNextTask(kind) {
      const task = [...tasks.values()].filter(item => item.kind === kind && item.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!task) return null
      task.status = 'claiming'
      return copy(task)
    },
    markTaskRunning(task) {
      const current = tasks.get(task.id)
      if (!current || current.status !== 'claiming') return copy(task)
      current.status = 'running'
      current.startedAt = new Date().toISOString()
      return copy(current)
    },
    completeTask(task, result = {}) {
      const current = tasks.get(task.id) || task
      Object.assign(current, { status: 'done', result, finishedAt: new Date().toISOString() })
      tasks.set(current.id, current)
      return copy(current)
    },
    failTask(task, error, result = {}) {
      const current = tasks.get(task.id) || task
      Object.assign(current, { status: 'failed', error: String(error), result, finishedAt: new Date().toISOString() })
      tasks.set(current.id, current)
      return copy(current)
    },
    requeueTask(task, reason = 'requeued') {
      const current = tasks.get(task.id) || task
      Object.assign(current, { status: 'pending', requeueReason: reason })
      tasks.set(current.id, current)
      return copy(current)
    },
    cancelResourceTasksByKind(kind, statuses, actor, reason) {
      const cancelled = []
      for (const task of tasks.values()) {
        if (task.kind !== kind || !statuses.includes(task.status)) continue
        Object.assign(task, { status: 'cancelled', error: reason, actor })
        cancelled.push(copy(task))
      }
      return cancelled
    },
  }
  return store
}

// 构造队列模块要求的最小安全任务输入。
function makeQueueInput(index = 0) {
  const bvId = `BV1xx411c7${String(index).padStart(2, '0')}`.slice(0, 12)
  return {
    taskId: `video-task-${index}`,
    p1Url: `https://www.bilibili.com/video/${bvId}?p=1`,
    bvId,
    inputType: 'bare_bv',
    targetType: 'group',
    targetId: `group-${index}`,
    channelKey: `group-${index}`,
    userId: `user-${index}`,
    requestedAt: new Date().toISOString(),
    retryCount: 0,
    traceId: `trace-${index}`,
    keys: [`bv:${bvId.slice(2).toLowerCase()}`],
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
    check('video min memory uses env override', config.videoMinMemMb === 300, JSON.stringify(config))
    process.env.BILI_MIN_MEM_MB = '200'
    delete require.cache[PLUGIN_PATH]
    const clampedPlugin = reloadPlugin()
    check('video min memory clamps values below red boundary to 300MB', clampedPlugin.getRuntimeConfig().videoMinMemMb === 300)
    process.env.BILI_MIN_MEM_MB = '550'
    delete require.cache[PLUGIN_PATH]
    const explicitPlugin = reloadPlugin()
    check('video min memory keeps explicit values above 300MB', explicitPlugin.getRuntimeConfig().videoMinMemMb === 550)
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
    const resolved = await plugin.resolveBiliShortLink('https://b23.tv/testKey', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestRedirect: async input => ({ statusCode: 302, location: input.includes('testKey') ? `${TEST_URL}?p=2` : '' }),
    })
    check('normalizes an allowed short-link redirect to P1 URL', resolved.ok && resolved.p1Url === `${TEST_URL}?p=1` && resolved.hops === 1, JSON.stringify(resolved))

    const acceptedStandaloneInputs = [
      TEST_BV,
      `${TEST_BV}?p=2`,
      TEST_URL,
      `${TEST_URL}?p=2`,
      'https://b23.tv/abc123?x=1',
      `这个视频讲了什么 ${TEST_BV}`,
      `帮我分析这个视频 ${TEST_URL}`,
    ]
    check('video detector accepts bare, linked, and natural-language Bilibili inputs', acceptedStandaloneInputs.every(input => plugin.isStandaloneBilibiliVideoInput(input)), JSON.stringify(acceptedStandaloneInputs))
    const rejectedStandaloneInputs = [
      '普通文本',
      'https://example.com/video',
      `bvidl ${TEST_BV}`,
    ]
    check('video detector leaves commands and non-Bilibili inputs to their owners', rejectedStandaloneInputs.every(input => !plugin.isStandaloneBilibiliVideoInput(input)), JSON.stringify(rejectedStandaloneInputs))
  })
}

// 验证前置入口注册顺序和不匹配消息的透传行为。
async function testStandaloneMiddlewareRegistration() {
  section('standalone middleware registration')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    plugin.apply(ctx)
    check('plugin registers one prepended and one normal middleware', ctx.middlewares.length === 2 && ctx.middlewares[0].prepend === true && ctx.middlewares[1].prepend === false, JSON.stringify(ctx.middlewares.map(item => item.prepend)))

    for (const content of ['普通文本', 'https://example.com/video', `bvidl ${TEST_BV}`]) {
      let nextCalls = 0
      await ctx.middlewares[0].handler(makeSession({ content }), () => { nextCalls += 1 })
      check(`prepended middleware passes through: ${content}`, nextCalls === 1)
    }
  })
}

// 验证五类输入统一进入视频流程，结构化卡片只读取链接字段。
async function testUnifiedBilibiliInputsAndCards() {
  section('unified Bilibili inputs and cards')
  await withIsolatedPlugin(async ({ plugin }) => {
    const miniApp = JSON.stringify({
      app: 'com.tencent.miniapp_01',
      prompt: '[QQ小程序]哔哩哔哩',
      meta: { detail_1: { title: '为什么这个视频这么火', qqdocurl: 'https://b23.tv/miniKey' } },
    })
    const shareCard = JSON.stringify({
      app: 'com.tencent.structmsg',
      prompt: '[分享]哔哩哔哩',
      meta: { news: { title: '讲了什么', jumpUrl: `${TEST_URL}?p=2` } },
    })
    const cases = [
      { label: 'bare BV with question text', content: `这个视频讲了什么 ${TEST_BV}` },
      { label: 'long link with analysis text', content: `帮我分析这个视频 ${TEST_URL}?p=2` },
      { label: 'short link with summary text', content: '总结一下 https://b23.tv/textKey' },
      { label: 'QQ mini app with question title', content: miniApp },
      { label: 'QQ share card', content: shareCard },
    ]

    for (const item of cases) {
      await plugin.clearVideoRuntimeState()
      const counters = { probes: 0, downloads: 0 }
      const deps = makeDeps(1_000_000, 1_000_000, counters, {
        resolveShortLink: async () => ({ ok: true, p1Url: `${TEST_URL}?p=1`, hops: 1 }),
      })
      const session = makeSession({ guildId: `input-${item.label}`, channelId: `input-${item.label}`, content: item.content })
      let nextCalls = 0
      const result = await plugin.handleStandaloneBilibiliVideoInput(makeCtx(), session, () => { nextCalls += 1 }, deps)
      check(`${item.label} enters video processing`, nextCalls === 0 && result === undefined && counters.probes === 1 && counters.downloads === 1, JSON.stringify({ result, nextCalls, counters, sent: session.sent }))
    }

    const ordinary = makeSession({ content: '普通聊天消息，不含视频编号或地址' })
    let ordinaryNext = 0
    await plugin.handleStandaloneBilibiliVideoInput(makeCtx(), ordinary, () => { ordinaryNext += 1 })
    check('ordinary non-Bilibili message continues middleware chain', ordinaryNext === 1 && ordinary.sent.length === 0)

    const brokenCard = JSON.stringify({
      app: 'com.tencent.miniapp_01',
      prompt: '[QQ小程序]哔哩哔哩',
      meta: { detail_1: { title: `为什么 ${TEST_BV} 没有链接字段` } },
    })
    const brokenSession = makeSession({ content: brokenCard })
    let brokenNext = 0
    const brokenResult = await plugin.handleStandaloneBilibiliVideoInput(makeCtx(), brokenSession, () => { brokenNext += 1 })
    check('recognized Bilibili card without link returns explicit parse error', brokenNext === 0 && String(brokenResult).includes('video-010'), JSON.stringify({ brokenResult, brokenNext }))
    check('card title BV is not treated as a link field', plugin.extractBiliUrl(brokenCard) === null)
  })
}

// 验证裸 BV 前置入口在三档边界上进入统一准入，且红档不启动探测或下载。
async function testStandaloneMiddlewareResourceBoundaries() {
  section('standalone middleware resource boundaries')
  await withIsolatedPlugin(async ({ plugin }) => {
    const { decideAdmission } = require(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'admission.js'))
    const scenarios = [
      { mem: 523, state: 'yellow', decision: 'run_now' },
      { mem: 300, state: 'yellow', decision: 'run_now' },
      { mem: 600, state: 'green', decision: 'run_now' },
      { mem: 299, state: 'red', decision: 'reject' },
    ]
    const inputs = [TEST_BV, `${TEST_BV}?p=2`]

    for (const scenario of scenarios) {
      for (const content of inputs) {
        await plugin.clearVideoRuntimeState()
        const counters = { probes: 0, downloads: 0 }
        let nextCalls = 0
        let admissionCalls = 0
        const snapshot = {
          resourceState: scenario.state,
          botMode: scenario.state === 'red' ? 'critical' : 'normal',
          memAvailableMb: scenario.mem,
          locked: false,
          running: null,
        }
        const admission = decideAdmission({ kind: 'external_video_download' }, snapshot)
        const deps = makeDeps(1_000_000, 1_000_000, counters, {
          resourceGate: true,
          resourceModules: {
            admitTask() {
              admissionCalls += 1
              return admission
            },
            async acquireResourceGate() {
              return { updateStep() {}, release() {} }
            },
          },
        })
        const session = makeSession({
          guildId: `standalone-${scenario.mem}-${content.includes('?') ? 'p2' : 'bv'}`,
          channelId: `standalone-${scenario.mem}-${content.includes('?') ? 'p2' : 'bv'}`,
          content,
        })
        const result = await plugin.handleStandaloneBilibiliVideoInput(makeCtx(), session, () => { nextCalls += 1 }, deps)
        const detail = JSON.stringify({ scenario, content, admission, admissionCalls, nextCalls, counters, sent: session.sent, result })
        check(`${scenario.mem}MB ${content.includes('?') ? 'BV?p=2' : 'bare BV'} reaches video admission once`, admissionCalls === 1 && nextCalls === 0 && admission.decision === scenario.decision, detail)
        if (scenario.decision === 'run_now') {
          check(`${scenario.mem}MB accepted standalone input probes and downloads once`, counters.probes === 1 && counters.downloads === 1, detail)
        } else {
          check(`${scenario.mem}MB rejected standalone input performs no probe or download`, counters.probes === 0 && counters.downloads === 0 && String(result).includes('最低需要300MB'), detail)
        }
      }
    }
  })
}

// 验证所有输入固定处理 P1，且部署配置统一使用 240 秒等待。
async function testP1NormalizationAndResponseTimeout() {
  section('P1 normalization and OneBot response timeout')
  await withIsolatedPlugin(async ({ plugin }) => {
    const p2Url = `${TEST_URL}?p=2&spm_id_from=333`
    check('direct P2 URL is normalized to P1', plugin.normalizeBiliP1Url(p2Url) === `${TEST_URL}?p=1`)
    check('plain BV input is normalized to P1', plugin.normalizeBiliP1Url(TEST_BV) === `${TEST_URL}?p=1`)
    check('P1 and P2 share the same BV key', plugin.buildBiliKeys(`${TEST_URL}?p=1`).includes('bv:1xx411c7md') && plugin.buildBiliKeys(p2Url).includes('bv:1xx411c7md'))

    let probeArgs = []
    const probeResult = await plugin.probeVideo(`${TEST_URL}?p=1`, async (_command, args) => {
      probeArgs = [...args]
      return { stdout: JSON.stringify(sampleInfo()), stderr: '' }
    })
    check('probe uses --no-playlist and exact P1 URL', probeArgs.includes('--no-playlist') && probeArgs.at(-1) === `${TEST_URL}?p=1`, JSON.stringify(probeArgs))
    check('P1 probe still selects a usable format', probeResult.picked && probeResult.picked.format === '30064+30280', JSON.stringify(probeResult))

    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0 }
    let probedUrl = ''
    const session = makeSession({ guildId: 'p1-direct', channelId: 'p1-direct' })
    await plugin.downloadAndSend(ctx, session, p2Url, p2Url, makeDeps(1_000_000, 1_000_000, counters, {
      probeVideo: async input => {
        probedUrl = input
        counters.probes += 1
        return { info: sampleInfo(), picked: { format: '30064+30280', label: '720P AVC', totalSize: 1_000_000, height: 720 } }
      },
    }))
    check('direct P2 probe and download both use exact P1 URL', probedUrl === `${TEST_URL}?p=1` && counters.args.at(-1) === probedUrl, JSON.stringify({ probedUrl, args: counters.args }))
    check('download uses --no-playlist', counters.args.includes('--no-playlist'), JSON.stringify(counters.args))
    check('multi-P handling adds no group notice', session.sent.length === 2, JSON.stringify(session.sent))

    const shortP1 = await plugin.resolveBiliShortLink('https://b23.tv/p2Key', {
      lookup: async () => [{ address: '8.8.4.4', family: 4 }],
      requestRedirect: async () => ({ statusCode: 302, location: `${TEST_URL}?p=3` }),
    })
    check('short link ending at P3 is normalized to P1', shortP1.ok && shortP1.p1Url === `${TEST_URL}?p=1`, JSON.stringify(shortP1))
  })

  const example = fs.readFileSync(path.join(REPO_ROOT, 'koishi.example.yml'), 'utf8')
  const setup = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8')
  const deploySource = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dashboard', 'src', 'lib', 'routes', 'deploy.ts'), 'utf8')
  const deployLib = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'koishi-plugin-dashboard', 'lib', 'routes', 'deploy.js'), 'utf8')
  const videoSource = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'koishi-plugin-local-video-sender', 'src', 'index.ts'), 'utf8')
  const stagingBlock = videoSource.slice(videoSource.indexOf('async function removeRequestStagingDirectory'), videoSource.indexOf('function detachVideoCacheEntry'))
  check('example config uses 240-second OneBot timeout', example.includes('responseTimeout: 240000'))
  check('setup template uses 240-second OneBot timeout', setup.includes('responseTimeout: 240000'))
  check('Dashboard source template uses 240-second OneBot timeout', deploySource.includes('responseTimeout: 240000'))
  check('Dashboard built template uses 240-second OneBot timeout', deployLib.includes('responseTimeout: 240000'))
  check('staging cleanup has no timer, scan or repeated delete', !/setInterval|setTimeout|readdir/.test(stagingBlock) && (stagingBlock.match(/\.rm\(/g) || []).length === 1)
  check('registered bvidl command marks explicit cache retry', videoSource.includes("downloadAndSend(ctx, session, url, text || url, {}, { explicitCommand: true })"))
}

// 验证 video-001 至 video-032 的完整中文文案和动态数据。
async function testChineseUserErrorCatalog() {
  section('Chinese user error catalog')
  await withIsolatedPlugin(async ({ plugin }) => {
    const cases = [
      [{ id: 'video-001' }, '视频解析命令格式错误。详细信息：请在“bvidl”后填写B站链接；也可以填写BV号。错误编号：video-001。'],
      [{ id: 'video-002', remainingSeconds: 300 }, '请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余300秒。错误编号：video-002。'],
      [{ id: 'video-003' }, '视频下载暂时关闭。详细信息：视频资源门禁模块加载失败。错误编号：video-003。'],
      [{ id: 'video-004', resourceState: 'red', availableMemoryMb: 299.4, minimumMemoryMb: 300, decision: 'reject' }, '视频搬运暂时无法执行，本次请求未执行。详细信息：资源状态为紧张，当前可用内存299MB，视频任务最低需要300MB，调度结果为拒绝。错误编号：video-004。'],
      [{ id: 'video-005', resourceState: 'red', minimumMemoryMb: 300, decision: 'queue' }, '视频搬运暂时无法执行，本次请求未执行。详细信息：资源状态为紧张，当前可用内存数据未取得，视频任务最低需要300MB，调度结果为排队。错误编号：video-005。'],
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
      [{ id: 'video-028' }, '视频搬运资源正忙，本次没有进入队列，请稍后重新发送。错误编号：video-028。'],
      [{ id: 'video-029' }, '视频任务排队保存失败，本次没有进入队列，请稍后重新发送。错误编号：video-029。'],
      [{ id: 'video-030' }, '视频凭据不可用，请联系管理员更新 B 站 Cookie。错误编号：video-030。'],
      [{ id: 'video-031' }, 'B 站短链接解析失败，请重新复制链接或发送 BV 号。错误编号：video-031。'],
      [{ id: 'video-032' }, '视频资源系统故障，本次未执行。错误编号：video-032。'],
    ]

    const stages = new Set()
    for (const [input, expected] of cases) {
      const userError = plugin.buildVideoUserError(input)
      stages.add(userError.stage)
      check(`${input.id} emits exact Chinese detail`, userError.id === input.id && userError.message === expected, JSON.stringify(userError))
      const hasRequiredDetail = Number(input.id.slice(-3)) <= 27 ? userError.message.includes('详细信息：') : true
      check(`${input.id} has one detailed stage`, hasRequiredDetail && userError.message.endsWith(`错误编号：${input.id}。`) && !/下载或暂存|下载或发送|创建或校验/.test(userError.message), userError.message)
    }
    check('all 32 error IDs use distinct fixed stages', cases.length === 32 && stages.size === 32, JSON.stringify([...stages]))

    const stateLabels = { green: '正常', yellow: '注意', red: '紧张' }
    for (const [state, label] of Object.entries(stateLabels)) {
      const message = plugin.buildVideoUserError({ id: 'video-004', resourceState: state, availableMemoryMb: 0, minimumMemoryMb: 300, decision: 'reject' }).message
      check(`resource state ${state} is translated`, message.includes(`资源状态为${label}`), message)
    }
    const decisionLabels = { reject: '拒绝', defer: '延后', queue: '排队', downgrade: '降级', silent_drop: '静默丢弃' }
    for (const [decision, label] of Object.entries(decisionLabels)) {
      const message = plugin.buildVideoUserError({ id: 'video-005', resourceState: 'yellow', minimumMemoryMb: 300, decision }).message
      check(`admission decision ${decision} is translated`, message.includes(`调度结果为${label}`), message)
    }
    const unknownLabels = plugin.buildVideoUserError({ id: 'video-005', resourceState: 'future', minimumMemoryMb: 300, decision: 'future' }).message
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
    const remainingCacheFiles = fs.readdirSync(path.join(tmpRoot, 'downloads', 'cache'))
    const outputDeleteLogs = ctx.logs.filter(entry => entry.msg.includes('video output delete failed')).map(entry => entry.msg)
    check('actual oversize is deleted and not cached', plugin.getVideoCacheStatus().entries === 0 && remainingCacheFiles.length === 0, JSON.stringify({ status: plugin.getVideoCacheStatus(), remainingCacheFiles, outputDeleteLogs }))
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

// 验证只有显式 bvidl 可以复用同群未过期的未知发送缓存。
async function testExplicitUncertainCacheRetry() {
  section('explicit uncertain cache retry')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const counters = { probes: 0, downloads: 0 }
    const deps = makeDeps(1_000_000, 1_000_000, counters)
    const timeoutSession = makeSession({
      guildId: 'uncertain-retry',
      channelId: 'uncertain-retry',
      async send(message) {
        if (String(message).includes('<video')) throw new TimeoutError()
        return message
      },
    })
    await plugin.downloadAndSend(ctx, timeoutSession, TEST_URL, TEST_BV, deps)
    const initialStatus = plugin.getVideoCacheStatus()
    const initialExpiry = initialStatus.items[0].expiresAt
    check('initial video timeout records uncertain cache status', initialStatus.items[0].lastSendStatus === 'uncertain', JSON.stringify(initialStatus))

    const ordinaryRepeat = makeSession({ guildId: 'uncertain-retry', channelId: 'uncertain-retry' })
    await plugin.downloadAndSend(ctx, ordinaryRepeat, TEST_URL, TEST_BV, deps)
    check('ordinary same-group repeat remains blocked', ordinaryRepeat.sent.length === 1 && ordinaryRepeat.sent[0].includes('错误编号：video-002'), JSON.stringify(ordinaryRepeat.sent))

    const explicitRetry = makeSession({ guildId: 'uncertain-retry', channelId: 'uncertain-retry' })
    await plugin.downloadAndSend(ctx, explicitRetry, TEST_URL, TEST_BV, deps, { explicitCommand: true })
    const confirmedStatus = plugin.getVideoCacheStatus()
    check('explicit retry reuses preview and cached file', explicitRetry.sent.length === 2 && counters.probes === 1 && counters.downloads === 1, JSON.stringify({ sent: explicitRetry.sent, counters }))
    check('explicit cache retry does not renew expiry', confirmedStatus.items[0].expiresAt === initialExpiry, JSON.stringify({ initialExpiry, current: confirmedStatus.items[0].expiresAt }))
    check('confirmed retry updates cache status', confirmedStatus.items[0].lastSendStatus === 'confirmed', JSON.stringify(confirmedStatus))

    const secondExplicit = makeSession({ guildId: 'uncertain-retry', channelId: 'uncertain-retry' })
    await plugin.downloadAndSend(ctx, secondExplicit, TEST_URL, TEST_BV, deps, { explicitCommand: true })
    check('confirmed cache cannot bypass duplicate suppression', secondExplicit.sent.length === 1 && secondExplicit.sent[0].includes('错误编号：video-002'), JSON.stringify(secondExplicit.sent))

    await plugin.clearVideoRuntimeState()
    const repeatedTimeoutCounters = { probes: 0, downloads: 0 }
    const repeatedTimeoutDeps = makeDeps(1_000_000, 1_000_000, repeatedTimeoutCounters)
    const makeTimeoutSession = () => makeSession({
      guildId: 'uncertain-again',
      channelId: 'uncertain-again',
      async send(message) {
        if (String(message).includes('<video')) throw new TimeoutError()
        return message
      },
    })
    await plugin.downloadAndSend(ctx, makeTimeoutSession(), TEST_URL, TEST_BV, repeatedTimeoutDeps)
    const repeatedExpiry = plugin.getVideoCacheStatus().items[0].expiresAt
    await plugin.downloadAndSend(ctx, makeTimeoutSession(), TEST_URL, TEST_BV, repeatedTimeoutDeps, { explicitCommand: true })
    const repeatedStatus = plugin.getVideoCacheStatus()
    check('explicit retry timeout stays uncertain without redownload', repeatedStatus.items[0].lastSendStatus === 'uncertain' && repeatedTimeoutCounters.downloads === 1, JSON.stringify({ repeatedStatus, repeatedTimeoutCounters }))
    check('repeated timeout does not extend cache lifetime', repeatedStatus.items[0].expiresAt === repeatedExpiry, JSON.stringify({ repeatedExpiry, current: repeatedStatus.items[0].expiresAt }))
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
      return { ok: true, p1Url: `${TEST_URL}?p=1`, hops: 1 }
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

// 验证短链逐跳安全校验、失败代码、一次重试和失败不缓存。
async function testShortLinkStructuredFailures() {
  section('short-link structured failures')
  await withIsolatedPlugin(async ({ plugin }) => {
    const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }]
    const hopEvents = []
    let successCalls = 0
    const success = await plugin.resolveBiliShortLink('https://b23.tv/fiveHops?secret=hidden', {
      lookup: publicLookup,
      requestRedirect: async (_input, _timeoutMs, destination) => {
        successCalls += 1
        check(`hop ${successCalls} connects to validated fixed IP`, destination.address === '8.8.8.8' && destination.family === 4, JSON.stringify(destination))
        return {
          statusCode: 302,
          location: successCalls === 5 ? `${TEST_URL}?p=2&token=secret` : `/redirect/${successCalls}?token=secret`,
        }
      },
      onHop: event => hopEvents.push(event),
    })
    check('five redirects succeed and normalize final P2 to P1', success.ok && success.hops === 5 && success.p1Url === `${TEST_URL}?p=1`, JSON.stringify(success))
    check('short-link hop events omit full query strings', hopEvents.length === 5 && !JSON.stringify(hopEvents).includes('secret'), JSON.stringify(hopEvents))

    let limitCalls = 0
    const limited = await plugin.resolveBiliShortLink('https://b23.tv/tooMany', {
      lookup: publicLookup,
      requestRedirect: async () => ({ statusCode: 302, location: `/redirect/${++limitCalls}` }),
    })
    check('more than five redirects returns redirect_limit', !limited.ok && limited.code === 'redirect_limit' && limited.hops === 5 && limitCalls === 5, JSON.stringify(limited))

    const missing = await plugin.resolveBiliShortLink('https://b23.tv/missing', {
      lookup: publicLookup,
      requestRedirect: async () => ({ statusCode: 302, location: '' }),
    })
    check('redirect without Location returns missing_location', !missing.ok && missing.code === 'missing_location' && missing.statusCode === 302, JSON.stringify(missing))

    let httpCalls = 0
    const httpFailure = await plugin.resolveBiliShortLink('https://b23.tv/notRedirect', {
      lookup: publicLookup,
      requestRedirect: async () => { httpCalls += 1; return { statusCode: 404, location: '' } },
    })
    check('4xx response is not retried and returns http_not_redirect', !httpFailure.ok && httpFailure.code === 'http_not_redirect' && httpCalls === 1, JSON.stringify(httpFailure))

    let finalCalls = 0
    const noBvFinal = await plugin.resolveBiliShortLink('https://b23.tv/noBv', {
      lookup: publicLookup,
      requestRedirect: async () => {
        finalCalls += 1
        return finalCalls === 1
          ? { statusCode: 302, location: 'https://www.bilibili.com/read/cv1' }
          : { statusCode: 200, location: '' }
      },
    })
    check('allowed final page without BV returns final_url_not_bv', !noBvFinal.ok && noBvFinal.code === 'final_url_not_bv' && finalCalls === 2, JSON.stringify(noBvFinal))

    let outsideCalls = 0
    const outside = await plugin.resolveBiliShortLink('https://b23.tv/outside', {
      lookup: publicLookup,
      requestRedirect: async () => { outsideCalls += 1; return { statusCode: 302, location: 'https://example.com/video' } },
    })
    check('redirect outside allowlist is rejected without following it', !outside.ok && outside.code === 'redirect_outside_allowlist' && outsideCalls === 1, JSON.stringify(outside))

    const emptyDns = await plugin.resolveBiliShortLink('https://b23.tv/noDns', {
      lookup: async () => [],
      requestRedirect: async () => { throw new Error('must not connect') },
    })
    check('empty DNS answer returns dns_empty', !emptyDns.ok && emptyDns.code === 'dns_empty', JSON.stringify(emptyDns))

    for (const address of ['10.0.0.1', '127.0.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.51.100.2', '203.0.113.3', '::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', '3fff::1']) {
      let privateRequests = 0
      const privateResult = await plugin.resolveBiliShortLink('https://b23.tv/private', {
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        requestRedirect: async () => { privateRequests += 1; return { statusCode: 302, location: TEST_URL } },
      })
      check(`${address} is rejected before connection`, !privateResult.ok && privateResult.code === 'dns_private_address' && privateRequests === 0, JSON.stringify(privateResult))
    }

    let dnsAttempts = 0
    const dnsRetry = await plugin.resolveBiliShortLink('https://b23.tv/dnsRetry', {
      lookup: async () => {
        dnsAttempts += 1
        if (dnsAttempts === 1) throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' })
        return [{ address: '8.8.4.4', family: 4 }]
      },
      requestRedirect: async () => ({ statusCode: 302, location: TEST_URL }),
    })
    check('temporary DNS failure retries exactly once', dnsRetry.ok && dnsAttempts === 2, JSON.stringify({ dnsRetry, dnsAttempts }))

    let timeoutAttempts = 0
    const timeout = await plugin.resolveBiliShortLink('https://b23.tv/timeout', {
      lookup: publicLookup,
      requestRedirect: async () => {
        timeoutAttempts += 1
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      },
    })
    check('request timeout retries once then returns request_timeout', !timeout.ok && timeout.code === 'request_timeout' && timeoutAttempts === 2, JSON.stringify(timeout))

    let resetAttempts = 0
    const reset = await plugin.resolveBiliShortLink('https://b23.tv/reset', {
      lookup: publicLookup,
      requestRedirect: async () => {
        resetAttempts += 1
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      },
    })
    check('connection reset retries once then returns request_failed', !reset.ok && reset.code === 'request_failed' && resetAttempts === 2, JSON.stringify(reset))

    let serverAttempts = 0
    const serverFailure = await plugin.resolveBiliShortLink('https://b23.tv/serverError', {
      lookup: publicLookup,
      requestRedirect: async () => { serverAttempts += 1; return { statusCode: 503, location: '' } },
    })
    check('HTTP 5xx retries once then returns request_failed', !serverFailure.ok && serverFailure.code === 'request_failed' && serverFailure.statusCode === 503 && serverAttempts === 2, JSON.stringify(serverFailure))

    let fakeNow = 0
    let overBudgetRequests = 0
    const totalTimeout = await plugin.resolveBiliShortLink('https://b23.tv/totalTimeout', {
      now: () => fakeNow,
      lookup: async () => { fakeNow = 5001; return [{ address: '8.8.8.8', family: 4 }] },
      requestRedirect: async () => { overBudgetRequests += 1; return { statusCode: 302, location: TEST_URL } },
    })
    check('DNS time consumes the shared five-second budget before connection', !totalTimeout.ok && totalTimeout.code === 'request_timeout' && overBudgetRequests === 0, JSON.stringify(totalTimeout))

    await plugin.clearVideoRuntimeState()
    let failureResolutions = 0
    const failingResolver = async () => {
      failureResolutions += 1
      return { ok: false, code: 'request_failed', hops: 0, statusCode: 503 }
    }
    const firstFailure = await plugin.downloadAndSend(makeCtx(), makeSession({ guildId: 'short-fail-a', channelId: 'short-fail-a' }), 'https://b23.tv/cacheFail', 'https://b23.tv/cacheFail', { resourceGate: false, resolveShortLink: failingResolver })
    const secondFailure = await plugin.downloadAndSend(makeCtx(), makeSession({ guildId: 'short-fail-b', channelId: 'short-fail-b' }), 'https://b23.tv/cacheFail', 'https://b23.tv/cacheFail', { resourceGate: false, resolveShortLink: failingResolver })
    check('short-link failures map to video-031 and are never cached', String(firstFailure).includes('video-031') && String(secondFailure).includes('video-031') && failureResolutions === 2, JSON.stringify({ firstFailure, secondFailure, failureResolutions }))
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

// 验证暂存目录只删除一次，并把精确失败信息发给全部有效管理员。
async function testStagingCleanupAlerts() {
  section('single staging cleanup and admin alerts')
  await withIsolatedPlugin(async ({ plugin, tmpRoot, dataDir }) => {
    const ctx = makeCtx()
    const stagingRoot = path.join(tmpRoot, 'downloads', '.staging')
    const adminIdsFile = path.join(dataDir, 'ai-admin-ids.json')
    fs.mkdirSync(stagingRoot, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(adminIdsFile, JSON.stringify(['111', '222', '111', 'bad-id', null]), 'utf8')

    const successfulDir = path.join(stagingRoot, 'bili-job-success-1000-abc123')
    fs.mkdirSync(successfulDir)
    let successfulRmCalls = 0
    const successfulSession = makeSession()
    const successful = await plugin.removeRequestStagingDirectory(ctx, successfulSession, successfulDir, TEST_BV, 'task-success', {
      fs: makeStagingFs({
        rm: async (...args) => {
          successfulRmCalls += 1
          return fsp.rm(...args)
        },
      }),
      adminIdsFile,
    })
    check('safe staging directory is deleted exactly once', successful && successfulRmCalls === 1 && !fs.existsSync(successfulDir), JSON.stringify({ successful, successfulRmCalls }))

    let missingRmCalls = 0
    const missing = await plugin.removeRequestStagingDirectory(ctx, successfulSession, path.join(stagingRoot, 'bili-job-missing-1001-abc123'), TEST_BV, 'task-missing', {
      fs: makeStagingFs({ rm: async () => { missingRmCalls += 1 } }),
      adminIdsFile,
    })
    check('ENOENT staging directory is successful without delete or alert', missing && missingRmCalls === 0, JSON.stringify({ missing, missingRmCalls }))

    const failedDir = path.join(stagingRoot, 'bili-job-failed-1002-abc123')
    fs.mkdirSync(failedDir)
    let failedRmCalls = 0
    const privateCalls = []
    const alertSession = makeSession({
      bot: {
        internal: {
          async sendPrivateMsg(userId, message) {
            privateCalls.push({ userId: String(userId), message: String(message) })
            if (String(userId) === '111') {
              const error = new Error('first admin offline')
              error.code = 'ECONNRESET'
              throw error
            }
          },
        },
      },
    })
    const cleanupError = new Error(`permission denied\nhttps://secret.example/video ${process.env.BILI_COOKIES_FILE}`)
    cleanupError.code = 'EACCES'
    const fixedNow = Date.UTC(2026, 6, 28, 12, 34, 56)
    const failed = await plugin.removeRequestStagingDirectory(ctx, alertSession, failedDir, TEST_BV, 'task-cleanup-1', {
      fs: makeStagingFs({
        rm: async () => {
          failedRmCalls += 1
          throw cleanupError
        },
      }),
      adminIdsFile,
      now: fixedNow,
    })
    const alertText = privateCalls[0] && privateCalls[0].message
    const cleanupLog = ctx.logs.find(entry => entry.msg.includes('staging_cleanup_failed:') && entry.msg.includes('task-cleanup-1'))
    check('failed delete is attempted exactly once', !failed && failedRmCalls === 1, JSON.stringify({ failed, failedRmCalls }))
    check('duplicate and invalid admin IDs are filtered before send', JSON.stringify(privateCalls.map(call => call.userId)) === JSON.stringify(['111', '222']), JSON.stringify(privateCalls))
    check('admin alert contains complete cleanup evidence', alertText && alertText.includes('任务：task-cleanup-1') && alertText.includes(`视频：${TEST_BV}`) && alertText.includes(`暂存目录：${path.resolve(failedDir)}`) && alertText.includes('错误码：EACCES') && alertText.includes('时间：2026-07-28 20:34:56'), alertText)
    check('admin alert sanitizes URL, cookies path and line breaks', alertText && alertText.includes('[url]') && alertText.includes('[cookies-file]') && !alertText.includes('secret.example') && !alertText.includes(String(process.env.BILI_COOKIES_FILE)), alertText)
    check('cleanup log contains exact path, code and sanitized error', cleanupLog && cleanupLog.msg.includes(JSON.stringify(path.resolve(failedDir))) && cleanupLog.msg.includes('code=EACCES') && !cleanupLog.msg.includes('secret.example'), cleanupLog && cleanupLog.msg)
    check('one failed admin notification does not block the other', ctx.logs.some(entry => entry.msg.includes('staging_cleanup_admin_notify_failed: admin=111')) && privateCalls.some(call => call.userId === '222'))

    const outsideDir = path.join(tmpRoot, 'outside', 'bili-job-outside-1003-abc123')
    fs.mkdirSync(outsideDir, { recursive: true })
    let rejectedRmCalls = 0
    const rejectedCalls = []
    const rejectedSession = makeSession({ bot: { internal: { async sendPrivateMsg(userId, message) { rejectedCalls.push({ userId, message: String(message) }) } } } })
    const rejected = await plugin.removeRequestStagingDirectory(ctx, rejectedSession, outsideDir, TEST_BV, 'task-rejected', {
      fs: makeStagingFs({ rm: async () => { rejectedRmCalls += 1 } }),
      adminIdsFile,
      now: fixedNow,
    })
    check('unsafe path is not deleted', !rejected && rejectedRmCalls === 0 && fs.existsSync(outsideDir), JSON.stringify({ rejected, rejectedRmCalls }))
    check('unsafe path alerts both admins with safety code', rejectedCalls.length === 2 && rejectedCalls.every(call => call.message.includes('错误码：SAFETY_VALIDATION_FAILED')), JSON.stringify(rejectedCalls))

    const noAdminDir = path.join(stagingRoot, 'bili-job-noadmin-1004-abc123')
    fs.mkdirSync(noAdminDir)
    const busyError = new Error('directory busy')
    busyError.code = 'EBUSY'
    const noAdminCalls = []
    await plugin.removeRequestStagingDirectory(ctx, makeSession({ bot: { internal: { async sendPrivateMsg(...args) { noAdminCalls.push(args) } } } }), noAdminDir, TEST_BV, 'task-no-admin', {
      fs: makeStagingFs({ rm: async () => { throw busyError } }),
      adminIdsFile: path.join(dataDir, 'missing-admins.json'),
    })
    check('missing admin file logs exact reason and uses last valid list', noAdminCalls.length === 2 && ctx.logs.some(entry => entry.msg.includes('staging_cleanup_admin_ids_unavailable:') && entry.msg.includes('code=ENOENT') && entry.msg.includes('cached_count=2')), JSON.stringify(noAdminCalls))

    const noApiDir = path.join(stagingRoot, 'bili-job-noapi-1005-abc123')
    fs.mkdirSync(noApiDir)
    await plugin.removeRequestStagingDirectory(ctx, makeSession(), noApiDir, TEST_BV, 'task-no-api', {
      fs: makeStagingFs({ rm: async () => { throw busyError } }),
      adminIdsFile,
    })
    check('missing private API is logged without another delete', ctx.logs.some(entry => entry.msg.includes('staging_cleanup_admin_notify_unavailable: reason=sendPrivateMsg_unavailable')))
  })
}

// 验证首次任务的每条收尾路径最多调用一次暂存目录删除函数。
async function testSingleCleanupCallPerRequest() {
  section('single cleanup call per request')
  await withIsolatedPlugin(async ({ plugin }) => {
    const ctx = makeCtx()
    const basePath = path.join(plugin.getRuntimeConfig().workdir, '.staging', 'bili-job-count-2000-abc123')

    const runCase = async (name, session, overrides, expectedCalls) => {
      let cleanupCalls = 0
      const deps = {
        ...makeDeps(1_000_000, 1_000_000),
        createStagingDirectory: async () => ({ status: 'ready', path: `${basePath}-${name}` }),
        removeStagingDirectory: async () => {
          cleanupCalls += 1
          return true
        },
        ...overrides,
      }
      await plugin.downloadAndSend(ctx, session, TEST_URL, TEST_BV, deps)
      check(`${name} calls staging cleanup at most once`, cleanupCalls === expectedCalls && cleanupCalls <= 1, `cleanupCalls=${cleanupCalls}`)
      await plugin.clearVideoRuntimeState()
    }

    await runCase('success', makeSession({ guildId: 'cleanup-success', channelId: 'cleanup-success' }), {}, 1)
    await runCase('download-failure', makeSession({ guildId: 'cleanup-download', channelId: 'cleanup-download' }), { run: async () => { throw new Error('download failed') } }, 1)
    await runCase('send-failure', makeSession({ guildId: 'cleanup-send', channelId: 'cleanup-send', async send(message) { if (String(message).includes('<video')) throw new Error('send failed'); return message } }), {}, 1)
    await runCase('send-timeout', makeSession({ guildId: 'cleanup-timeout', channelId: 'cleanup-timeout', async send(message) { if (String(message).includes('<video')) throw new TimeoutError(); return message } }), {}, 1)
    await runCase('probe-failure', makeSession({ guildId: 'cleanup-probe', channelId: 'cleanup-probe' }), { probeVideo: async () => { throw new Error('probe failed') } }, 0)

    let rejectedCleanupCalls = 0
    await plugin.downloadAndSend(ctx, makeSession({ guildId: 'cleanup-rejected', channelId: 'cleanup-rejected' }), TEST_URL, TEST_BV, {
      ...makeDeps(1_000_000, 1_000_000),
      createStagingDirectory: async () => ({ status: 'safety_validation_failed', path: `${basePath}-rejected` }),
      removeStagingDirectory: async () => {
        rejectedCleanupCalls += 1
        return false
      },
    })
    check('staging prepare rejection still reaches one finally cleanup', rejectedCleanupCalls === 1, `cleanupCalls=${rejectedCleanupCalls}`)
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
    const remainingCache = fs.readdirSync(path.join(plugin.getRuntimeConfig().workdir, 'cache'))
    const remainingStaging = fs.readdirSync(path.join(plugin.getRuntimeConfig().workdir, '.staging'))
    check(
      'upload failure removes final file and staging',
      remainingCache.length === 0 && remainingStaging.length === 0,
      JSON.stringify({ remainingCache, remainingStaging, logs: ctx.logs.map(entry => entry.msg) }),
    )
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
    await plugin.clearVideoRuntimeState()

    const resourceCases = [
      ['video-003', { resourceModules: null }],
      ['video-004', { resourceModules: makeResourceModules({ decision: 'reject', reason: 'low memory', resourceState: 'red', memAvailableMb: 321 }) }],
      ['video-028', { resourceModules: makeResourceModules({ decision: 'queue', reason: 'busy', resourceState: 'yellow', memAvailableMb: null }), taskStore: {} }],
      ['video-006', { resourceModules: makeResourceModules({ decision: 'run_now', reason: 'accepted', resourceState: 'green', memAvailableMb: 1024 }, async () => { throw new Error('gate timed out') }) }],
    ]
    for (let index = 0; index < resourceCases.length; index += 1) {
      const [id, deps] = resourceCases[index]
      const session = makeSession({ guildId: `resource-${index}`, channelId: `resource-${index}` })
      const result = await plugin.downloadAndSend(ctx, session, TEST_URL, TEST_BV, deps)
      const visible = [String(result), ...session.sent].join('\n')
      check(`resource path returns ${id}`, visible.includes(`错误编号：${id}`), visible)
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
      ['video-016', { status: 'create_failed', path: path.join(workdir, '.staging', 'bili-job-create-3000-abc123'), error: new Error('request staging mkdir failed') }],
      ['video-017', { status: 'safety_validation_failed', path: path.join(workdir, '.staging', 'bili-job-safety-3001-abc123') }],
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
  await testCookieFileBoundary()
  await testResourceGateStorageAlerts()
  await testPersistentVideoTaskQueue()
  await testQueuedVideoLifecycleIntegration()
  await testVideoTraceLifecycle()
  await testConfigAndParsing()
  await testStandaloneMiddlewareRegistration()
  await testUnifiedBilibiliInputsAndCards()
  await testStandaloneMiddlewareResourceBoundaries()
  await testP1NormalizationAndResponseTimeout()
  await testChineseUserErrorCatalog()
  await testFormatPicking()
  await testSizeGates()
  await testDuplicateAndCacheReuse()
  await testExplicitUncertainCacheRetry()
  await testInflightReuse()
  await testShortLinkNormalization()
  await testShortLinkStructuredFailures()
  await testCleanupAndSafety()
  await testStagingCleanupAlerts()
  await testSingleCleanupCallPerRequest()
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
