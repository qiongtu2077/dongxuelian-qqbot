const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const CONFIG_PATH = path.resolve(__dirname, '..', 'lib', 'config.js')
const DATA_COLLECTOR_PATH = path.resolve(__dirname, '..', 'lib', 'data-collector.js')
const AI_ANALYZER_PATH = path.resolve(__dirname, '..', 'lib', 'ai-analyzer.js')
const HTML_RENDERER_PATH = path.resolve(__dirname, '..', 'lib', 'html-renderer.js')
const REPORT_PIPELINE_PATH = path.resolve(__dirname, '..', 'lib', 'report-pipeline.js')
const MODELS_PATH = path.resolve(__dirname, '..', 'lib', 'models.js')
const API_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'core', 'api.js')
const RUNTIME_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'core', 'runtime-config.js')
const AI_ADMISSION_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'admission.js')
const AI_ACTIVITY_LEASE_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'resource-activity-lease.js')
const AI_TASK_STORE_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-workers', 'task-store.js')
const AI_CONSTANTS_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'core', 'constants.js')
const AI_SYSTEM_PROTECTION_PATH = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-system', 'system-protection.js')

const { requestChatCompletions } = require(API_PATH)

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n=== daily-report: ${title} ===`)
}

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  OK   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

function restoreModuleCache(modulePath, originalCache) {
  if (originalCache) require.cache[modulePath] = originalCache
  else delete require.cache[modulePath]
}

function makeCtx() {
  const middlewareList = []
  const events = new Map()
  const logs = []
  const ctx = {
    middleware(fn) { middlewareList.push(fn); return fn },
    on(event, fn) {
      const list = events.get(event) || []
      list.push(fn)
      events.set(event, list)
      return fn
    },
    async emit(event, ...args) {
      for (const fn of events.get(event) || []) await fn(...args)
    },
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: args.map(String).join(' ') })
      return { info: (...a) => push('info', a), warn: (...a) => push('warn', a), error: (...a) => push('error', a) }
    },
    _middlewareList: middlewareList,
    _events: events,
    _logs: logs,
  }
  return ctx
}

function makeSession(overrides = {}) {
  const sent = []
  return {
    content: '',
    guildId: '123456789',
    userId: 'user1',
    selfId: 'bot1',
    isDirect: false,
    async send(msg) { sent.push(msg); return true },
    _sent: sent,
    ...overrides,
  }
}

function createSampleReportData() {
  return {
    date: '2099-01-01',
    totalMessages: 12,
    activeMembers: 3,
    emojiCount: 4,
    totalChars: 260,
    peakHour: '21:00-21:59',
    topMembers: [
      { name: 'Alice', userId: '10001', msgCount: 6 },
      { name: 'Bob', userId: '10002', msgCount: 3 },
    ],
    messages: [
      { time: '21:00', user: 'Alice', userId: '10001', content: '今天的活动很顺利！' },
      { time: '21:01', user: 'Bob', userId: '10002', content: '哈哈这个点子很妙' },
      { time: '21:02', user: 'Alice', userId: '10001', content: '再补一条。' },
    ],
  }
}

function createResourceRuntimeMock(options = {}) {
  const state = {
    admissions: [],
    tasks: [],
    submissions: [],
    failed: [],
    deferred: [],
    submitAttempts: 0,
    submitError: options.submitError || null,
    admissionDecision: options.admissionDecision || { decision: 'run_now', reason: 'accepted' },
  }
  const admission = {
    admitTask(input) {
      state.admissions.push(input)
      const raw = typeof state.admissionDecision === 'function'
        ? state.admissionDecision(input, state)
        : state.admissionDecision
      return { decision: 'run_now', reason: 'accepted', ...(raw || {}) }
    },
  }
  const tasks = {
    submitResourceTask(input) {
      state.submitAttempts += 1
      if (state.submitError) throw state.submitError
      const task = {
        id: input.id || `task-${state.submitAttempts}`,
        kind: input.kind || 'daily_report',
        status: input.status || 'pending',
        channelKey: input.channelKey || '',
        userId: input.userId || '',
        payload: input.payload || {},
        notify: input.notify || { target: 'none', status: 'pending' },
      }
      state.tasks.push(task)
      state.submissions.push(task)
      return task
    },
    listResourceTasks(options = {}) {
      const statuses = Array.isArray(options.statuses) ? options.statuses.map(String) : []
      const limit = Math.max(1, Math.min(1000, Number(options.limit || 200)))
      const tasks = statuses.length
        ? state.tasks.filter(task => statuses.includes(String(task.status || '')))
        : state.tasks.slice()
      return tasks.slice(0, limit)
    },
    findResourceTaskByKindAndChannel(kind, channelKey, statuses = ['pending', 'claiming', 'running', 'deferred']) {
      const allowedStatuses = new Set((Array.isArray(statuses) ? statuses : []).map(String))
      return state.tasks.find(task =>
        String(task.kind || '') === String(kind || '') &&
        String(task.channelKey || '') === String(channelKey || '') &&
        (!allowedStatuses.size || allowedStatuses.has(String(task.status || '')))
      ) || null
    },
    failTask(task, error, result = {}) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error || '')
      task.result = result
      state.failed.push({ task, error, result })
      return task
    },
    deferTask(task, reason = 'deferred') {
      task.status = 'deferred'
      task.deferReason = reason
      state.deferred.push({ task, reason })
      return task
    },
  }
  require.cache[AI_ADMISSION_PATH] = { id: AI_ADMISSION_PATH, filename: AI_ADMISSION_PATH, loaded: true, exports: admission }
  require.cache[AI_TASK_STORE_PATH] = { id: AI_TASK_STORE_PATH, filename: AI_TASK_STORE_PATH, loaded: true, exports: tasks }
  return { state, admission, tasks }
}

function createAiRequestMock(routes) {
  const calls = []
  const request = async (messages, config, extraBody = {}) => {
    const systemPrompt = String(messages?.[0]?.content || '')
    const kind = systemPrompt.includes('摘要助手')
      ? 'compress'
      : systemPrompt.includes('userTitles') || systemPrompt.includes('qualityReview')
        ? 'full'
        : 'basic'
    calls.push({ kind, messages, config, extraBody })
    const response = typeof routes === 'function' ? routes({ kind, messages, config, extraBody, calls }) : routes[kind]
    if (response instanceof Error) throw response
    return response
  }
  return { calls, request }
}

async function withMockedAiAnalyzer(requestImpl, runner) {
  const originalRuntimeConfigCache = require.cache[RUNTIME_CONFIG_PATH]
  const originalApiCache = require.cache[API_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]

  require.cache[RUNTIME_CONFIG_PATH] = {
    id: RUNTIME_CONFIG_PATH,
    filename: RUNTIME_CONFIG_PATH,
    loaded: true,
    exports: {
      loadConfig: async () => ({
        apiKey: 'test-key',
        model: 'test-model',
        baseURL: 'https://example.com',
        provider: 'opencode',
      }),
    },
  }
  require.cache[API_PATH] = {
    id: API_PATH,
    filename: API_PATH,
    loaded: true,
    exports: {
      requestChatCompletions: requestImpl,
    },
  }

  delete require.cache[AI_ANALYZER_PATH]
  const analyzer = require(AI_ANALYZER_PATH)

  try {
    return await runner(analyzer)
  } finally {
    if (originalRuntimeConfigCache) require.cache[RUNTIME_CONFIG_PATH] = originalRuntimeConfigCache
    else delete require.cache[RUNTIME_CONFIG_PATH]
    if (originalApiCache) require.cache[API_PATH] = originalApiCache
    else delete require.cache[API_PATH]
    delete require.cache[AI_ANALYZER_PATH]
    if (originalAnalyzerCache) require.cache[AI_ANALYZER_PATH] = originalAnalyzerCache
  }
}

// ===== 1. 模块加载 =====
section('模块加载')
try { require(MODELS_PATH); check('models', true) } catch (e) { check('models', false, e.message) }
try { require(DATA_COLLECTOR_PATH); check('data-collector', true) } catch (e) { check('data-collector', false, e.message) }
try { require(AI_ANALYZER_PATH); check('ai-analyzer', true) } catch (e) { check('ai-analyzer', false, e.message) }
try { require(HTML_RENDERER_PATH); check('html-renderer', true) } catch (e) { check('html-renderer', false, e.message) }
try { reloadPlugin(); check('index', true) } catch (e) { check('index', false, e.message) }

// ===== 2. 导出检查 =====
section('导出检查')
const models = require(MODELS_PATH)
check('models exports createDefaultAnalysisResult', typeof models.createDefaultAnalysisResult === 'function')
check('models exports createTopic', typeof models.createTopic === 'function')
check('models exports createUserTitle', typeof models.createUserTitle === 'function')
check('models exports createGoldenQuote', typeof models.createGoldenQuote === 'function')

const dataCollector = require(DATA_COLLECTOR_PATH)
check('data-collector exports collectReportData', typeof dataCollector.collectReportData === 'function')

const aiAnalyzer = require(AI_ANALYZER_PATH)
check('ai-analyzer exports analyzeWithAI', typeof aiAnalyzer.analyzeWithAI === 'function')
check('ai-analyzer exports full fallback builder', typeof aiAnalyzer.buildFallbackFullAnalysis === 'function')

const htmlRenderer = require(HTML_RENDERER_PATH)
check('html-renderer exports renderReport', typeof htmlRenderer.renderReport === 'function')
check('html-renderer exports renderHtmlToImage', typeof htmlRenderer.renderHtmlToImage === 'function')

async function testRendererTimeoutCleanup() {
  section('html-renderer failure cleanup')
  const originalExistsSync = fs.existsSync
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const originalDataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  const puppeteerPath = require.resolve('puppeteer-core')
  const originalPuppeteerCache = require.cache[puppeteerPath]
  const originalConstantsCache = require.cache[AI_CONSTANTS_PATH]
  const originalSystemProtectionCache = require.cache[AI_SYSTEM_PROTECTION_PATH]
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-render-s8-'))
  const timeoutToken = { id: 'render-timeout' }
  let timeoutCreated = false
  let timeoutCleared = false
  let browserClosed = false
  let fakeChromiumProcess = null
  let fakePid = null

  const waitWithRealTimer = ms => new Promise(resolve => originalSetTimeout(resolve, ms))
  const isPidAlive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error && error.code === 'EPERM'
    }
  }

  fs.existsSync = value => String(value || '').includes('chrome') || originalExistsSync(value)
  global.setTimeout = () => { timeoutCreated = true; return timeoutToken }
  global.clearTimeout = token => { if (token === timeoutToken) timeoutCleared = true }
  process.env.DONGXUELIAN_AI_DATA_DIR = tempDataDir
  delete require.cache[AI_CONSTANTS_PATH]
  delete require.cache[AI_SYSTEM_PROTECTION_PATH]
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      async launch() {
        fakeChromiumProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        fakePid = fakeChromiumProcess.pid
        return {
          process: () => fakeChromiumProcess,
          async newPage() { throw new Error('new page failed') },
          async close() {
            browserClosed = true
            throw new Error('mock daily chromium close failed')
          },
        }
      },
    },
  }

  try {
    delete require.cache[HTML_RENDERER_PATH]
    const renderer = require(HTML_RENDERER_PATH)
    try {
      await renderer.renderHtmlToImage('<html><body>fail</body></html>', { taskId: 'daily-render-cleanup-test' })
      check('renderHtmlToImage mock failure throws', false)
    } catch (error) {
      check('renderHtmlToImage mock failure throws', error.message === 'new page failed', error.message)
    }
    await waitWithRealTimer(500)
    const fakeAliveAfterClose = fakePid ? isPidAlive(fakePid) : null
    if (fakeAliveAfterClose) {
      try { process.kill(fakePid, 'SIGKILL') } catch {}
    }
    const systemProtection = require(AI_SYSTEM_PROTECTION_PATH)
    const status = systemProtection.getSystemProtectionStatus()
    const cleanupEvents = Array.isArray(status.cleanupEvents) ? status.cleanupEvents : []
    const dailyCloseFailed = cleanupEvents.filter(event => event.event === 'daily_chromium_close_failed' && Number(event.browserPid) === Number(fakePid))
    const processTreeTerminated = cleanupEvents.filter(event => event.event === 'process_tree_terminated' && Number(event.rootPid) === Number(fakePid))
    check('renderHtmlToImage clears timeout on failure', timeoutCreated && timeoutCleared, JSON.stringify({ timeoutCreated, timeoutCleared }))
    check('renderHtmlToImage closes browser on failure', browserClosed, JSON.stringify({ browserClosed }))
    check('renderHtmlToImage writes daily chromium close failure event', dailyCloseFailed.length >= 1, JSON.stringify({ fakePid, cleanupEvents: cleanupEvents.map(event => event.event).slice(-6) }))
    check('renderHtmlToImage terminates recorded chromium child process', processTreeTerminated.length >= 1 && fakeAliveAfterClose === false, JSON.stringify({ fakePid, fakeAliveAfterClose, cleanupEvents: cleanupEvents.map(event => event.event).slice(-6) }))
  } finally {
    if (fakePid && isPidAlive(fakePid)) {
      try { process.kill(fakePid, 'SIGKILL') } catch {}
    }
    fs.existsSync = originalExistsSync
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
    if (originalDataDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = originalDataDir
    if (originalPuppeteerCache) require.cache[puppeteerPath] = originalPuppeteerCache
    else delete require.cache[puppeteerPath]
    if (originalConstantsCache) require.cache[AI_CONSTANTS_PATH] = originalConstantsCache
    else delete require.cache[AI_CONSTANTS_PATH]
    if (originalSystemProtectionCache) require.cache[AI_SYSTEM_PROTECTION_PATH] = originalSystemProtectionCache
    else delete require.cache[AI_SYSTEM_PROTECTION_PATH]
    delete require.cache[HTML_RENDERER_PATH]
    require(HTML_RENDERER_PATH)
  }
}

async function testRendererSlotReleasedWhenLeaseAcquireFails() {
  section('html-renderer lease acquire cleanup regression')
  const originalExistsSync = fs.existsSync
  const originalSetTimeout = global.setTimeout
  const originalDateNow = Date.now
  const originalDataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  const originalQueueTimeout = process.env.DAILY_REPORT_QUEUE_TIMEOUT_MS
  const puppeteerPath = require.resolve('puppeteer-core')
  const originalPuppeteerCache = require.cache[puppeteerPath]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalConstantsCache = require.cache[AI_CONSTANTS_PATH]
  const originalLeaseCache = require.cache[AI_ACTIVITY_LEASE_PATH]
  const serverModePath = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'server-mode-policy.js')
  const originalServerModeCache = require.cache[serverModePath]
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-render-lease-slot-'))
  let releaseToolLease = null
  let launchCalls = 0

  fs.existsSync = value => {
    const text = String(value || '')
    if (/chrome|edge|msedge/i.test(text)) return true
    return originalExistsSync(value)
  }
  process.env.DONGXUELIAN_AI_DATA_DIR = tempDataDir
  process.env.DAILY_REPORT_QUEUE_TIMEOUT_MS = '5000'
  const modeFile = path.join(tempDataDir, 'resource-control', 'config.json')
  fs.mkdirSync(path.dirname(modeFile), { recursive: true })
  fs.writeFileSync(modeFile, JSON.stringify({ serverMode: 'small', updatedAt: '2026-06-14T00:00:00.000Z' }, null, 2))
  delete require.cache[AI_CONSTANTS_PATH]
  delete require.cache[AI_ACTIVITY_LEASE_PATH]
  delete require.cache[serverModePath]
  delete require.cache[HTML_RENDERER_PATH]
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      async launch() {
        launchCalls += 1
        return {
          async newPage() { throw new Error('unexpected launch while render_active is blocked') },
          async close() {},
        }
      },
    },
  }

  try {
    const activityLease = require(AI_ACTIVITY_LEASE_PATH)
    releaseToolLease = activityLease.acquireResourceActivityLease('tool_active', {
      owner: 'daily-render-lease-slot-test',
      taskId: 'daily-render-lease-slot-test',
      ttlMs: 60000,
    })
    const renderer = require(HTML_RENDERER_PATH)

    try {
      await renderer.renderHtmlToImage('<html><body>blocked</body></html>', { taskId: 'lease-slot-first' })
      check('renderHtmlToImage throws when render_active conflicts with tool_active', false)
    } catch (error) {
      check('renderHtmlToImage throws when render_active conflicts with tool_active', String(error.message || error).includes('tool_active'), String(error.message || error))
    }

    let fakeNow = 1000
    Date.now = () => fakeNow
    global.setTimeout = (fn, ms, ...args) => {
      void ms
      fakeNow += 6000
      return originalSetTimeout(fn, 0, ...args)
    }

    try {
      await renderer.renderHtmlToImage('<html><body>blocked again</body></html>', { taskId: 'lease-slot-second' })
      check('renderer slot is released after lease acquire failure', false)
    } catch (error) {
      const message = String(error.message || error)
      check('renderer slot is released after lease acquire failure', message.includes('tool_active') && !message.includes('queue timeout'), message)
    }
    check('lease acquire failure does not launch Chromium', launchCalls === 0, JSON.stringify({ launchCalls }))
  } finally {
    try { if (releaseToolLease) releaseToolLease('test-finished') } catch {}
    fs.existsSync = originalExistsSync
    global.setTimeout = originalSetTimeout
    Date.now = originalDateNow
    if (originalDataDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = originalDataDir
    if (originalQueueTimeout === undefined) delete process.env.DAILY_REPORT_QUEUE_TIMEOUT_MS
    else process.env.DAILY_REPORT_QUEUE_TIMEOUT_MS = originalQueueTimeout
    restoreModuleCache(AI_CONSTANTS_PATH, originalConstantsCache)
    restoreModuleCache(AI_ACTIVITY_LEASE_PATH, originalLeaseCache)
    restoreModuleCache(serverModePath, originalServerModeCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(puppeteerPath, originalPuppeteerCache)
    try { fs.rmSync(tempDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testToolActiveRenderBlockRespectsServerMode() {
  section('report-pipeline serverMode gating regression')
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPipelineCache = require.cache[REPORT_PIPELINE_PATH]
  const originalLeaseCache = require.cache[AI_ACTIVITY_LEASE_PATH]
  const serverModePath = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'server-mode-policy.js')
  const originalServerModeCache = require.cache[serverModePath]
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-server-mode-'))
  let renderCalls = 0

  try {
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => createSampleReportData(),
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => ({
          topics: [{ title: 'Server Mode', summary: 'Large mode should preserve Chromium render.' }],
          goldenQuotes: [],
          userTitles: [],
          qualityReview: null,
          meta: {},
        }),
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('rendered-in-large-mode')
        },
      },
    }
    require.cache[AI_ACTIVITY_LEASE_PATH] = {
      id: AI_ACTIVITY_LEASE_PATH,
      filename: AI_ACTIVITY_LEASE_PATH,
      loaded: true,
      exports: {
        hasActiveResourceActivityLease(kind) {
          return kind === 'tool_active'
        },
      },
    }
    require.cache[serverModePath] = {
      id: serverModePath,
      filename: serverModePath,
      loaded: true,
      exports: {
        readResourceActivityMutualExclusionState() {
          return { strictActivityMutualExclusion: false, serverMode: 'large', serverModeSource: 'test' }
        },
        readServerModeConfig() {
          return { serverMode: 'large', serverModeSource: 'test' }
        },
      },
    }

    delete require.cache[REPORT_PIPELINE_PATH]
    const { generateDailyReportResult } = require(REPORT_PIPELINE_PATH)
    const result = await generateDailyReportResult({
      taskId: 'large-mode-tool-active-render',
      channelKey: 'large-mode-group',
      detail: true,
      outputDir,
      renderImage: true,
    })

    check('large mode does not skip Chromium render only because tool_active exists',
      renderCalls === 1 && result.mode === 'image' && !!result.imagePath,
      JSON.stringify({ renderCalls, result }))
    check('large mode does not record render_blocked_by_tool_active fallback',
      !String(result.reason || '').includes('render_blocked_by_tool_active'),
      JSON.stringify(result))
  } finally {
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(REPORT_PIPELINE_PATH, originalPipelineCache)
    restoreModuleCache(AI_ACTIVITY_LEASE_PATH, originalLeaseCache)
    restoreModuleCache(serverModePath, originalServerModeCache)
    try { fs.rmSync(outputDir, { recursive: true, force: true }) } catch {}
  }
}

section('AI fallback unit')
const fallbackFull = aiAnalyzer.buildFallbackFullAnalysis({
  totalMessages: 120,
  activeMembers: 8,
  emojiCount: 12,
  totalChars: 3000,
  peakHour: '21:00-21:59',
  topMembers: [
    { name: 'user-a', userId: '10001', msgCount: 40 },
    { name: 'user-b', userId: '10002', msgCount: 25 },
  ],
})
check('full fallback creates user title cards', Array.isArray(fallbackFull.userTitles) && fallbackFull.userTitles.length === 2)
check('full fallback creates quality review', fallbackFull.qualityReview && Array.isArray(fallbackFull.qualityReview.dimensions) && fallbackFull.qualityReview.dimensions.length > 0)
const fallbackBasic = aiAnalyzer.buildFallbackBasicAnalysis({
  totalMessages: 120,
  activeMembers: 8,
  emojiCount: 12,
  totalChars: 3000,
  peakHour: '21:00-21:59',
  topMembers: [
    { name: 'user-a', userId: '10001', msgCount: 40 },
    { name: 'user-b', userId: '10002', msgCount: 25 },
  ],
})
check('basic fallback creates topics', Array.isArray(fallbackBasic.topics) && fallbackBasic.topics.length > 0)
check('basic fallback creates golden quotes', Array.isArray(fallbackBasic.goldenQuotes) && fallbackBasic.goldenQuotes.length > 0)

async function testAiFallbackRegression() {
  section('AI fallback regression')
  const sampleData = createSampleReportData()

  const badJsonMock = createAiRequestMock({
    compress: '压缩摘要',
    basic: '{"topics":[{"id":1,"title":"缺半截"',
    full: 'full ok',
  })
  await withMockedAiAnalyzer(badJsonMock.request, async analyzer => {
    const result = await analyzer.analyzeWithAI(sampleData, false)
    check('basic bad JSON still has topics', Array.isArray(result.topics) && result.topics.length > 0)
    check('basic bad JSON still has golden quotes', Array.isArray(result.goldenQuotes) && result.goldenQuotes.length > 0)
    check('basic bad JSON records fallback warning', Array.isArray(result.meta?.warnings) && result.meta.warnings.some(w => w.includes('基础分析')))
    check('basic bad JSON records fallback stage', result.meta?.stages?.basic === 'fallback')
    const compressCall = badJsonMock.calls.find(call => call.kind === 'compress')
    const basicCall = badJsonMock.calls.find(call => call.kind === 'basic')
    check('basic bad JSON passes daily-report temperature', compressCall?.extraBody?.temperature === 0.2 && basicCall?.extraBody?.temperature === 0.2)
    check('basic bad JSON passes extended timeouts', compressCall?.extraBody?._timeoutMs === 45000 && basicCall?.extraBody?._timeoutMs === 60000)
  })

  const emptyMock = createAiRequestMock({
    compress: '压缩摘要',
    basic: '',
    full: '',
  })
  await withMockedAiAnalyzer(emptyMock.request, async analyzer => {
    const result = await analyzer.analyzeWithAI(sampleData, true)
    check('full empty response still has topics', Array.isArray(result.topics) && result.topics.length > 0)
    check('full empty response still has golden quotes', Array.isArray(result.goldenQuotes) && result.goldenQuotes.length > 0)
    check('full empty response still has user titles', Array.isArray(result.userTitles) && result.userTitles.length > 0)
    check('full empty response still has quality review', !!result.qualityReview && Array.isArray(result.qualityReview.dimensions) && result.qualityReview.dimensions.length > 0)
    check('full empty response records fallback stages', result.meta?.stages?.basic === 'fallback' && result.meta?.stages?.full === 'fallback')
  })

  const timeoutMock = createAiRequestMock({
    compress: '压缩摘要',
    basic: new Error('AbortError: request timed out'),
    full: new Error('AbortError: request timed out'),
  })
  await withMockedAiAnalyzer(timeoutMock.request, async analyzer => {
    const result = await analyzer.analyzeWithAI(sampleData, true)
    check('timeout response still has user titles', Array.isArray(result.userTitles) && result.userTitles.length > 0)
    check('timeout response still has quality review', !!result.qualityReview && Array.isArray(result.qualityReview.dimensions) && result.qualityReview.dimensions.length > 0)
    check('timeout response records warnings', Array.isArray(result.meta?.warnings) && result.meta.warnings.some(w => w.includes('请求失败')))
  })
}

async function testRequestChatCompletionsPayload() {
  section('api request payload')
  const originalFetch = global.fetch
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const timers = []
  let clearedToken = null
  let fetchUrl = ''
  let fetchOptions = null
  let signalAttached = 0
  let signalRemoved = 0
  const signalListeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(type, fn) {
      if (type === 'abort') {
        signalAttached += 1
        signalListeners.add(fn)
      }
    },
    removeEventListener(type, fn) {
      if (type === 'abort' && signalListeners.has(fn)) {
        signalRemoved += 1
        signalListeners.delete(fn)
      }
    },
  }

  global.setTimeout = (fn, ms) => {
    const token = { id: `api-timeout-${timers.length + 1}` }
    timers.push({ ms, token })
    return token
  }
  global.clearTimeout = token => {
    clearedToken = token
  }
  global.fetch = async (url, options) => {
    fetchUrl = url
    fetchOptions = options
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { total_tokens: 0 },
      }),
    }
  }

  try {
    const response = await requestChatCompletions(
      [{ role: 'user', content: 'ping' }],
      { provider: 'opencode', baseURL: 'https://example.com', apiKey: 'test-key', model: 'test-model' },
      { max_tokens: 12, temperature: 5, _timeoutMs: 999999, signal },
    )
    const body = JSON.parse(fetchOptions.body)
    const requestTimer = timers.find(timer => timer.ms === 300000)
    check('requestChatCompletions posts to chat endpoint', fetchUrl === 'https://example.com/chat/completions')
    check('requestChatCompletions serializes temperature', body.temperature === 2)
    check('requestChatCompletions serializes max tokens', body.max_tokens === 12)
    check('requestChatCompletions clamps timeout', !!requestTimer)
    check('requestChatCompletions clears timeout', clearedToken === requestTimer?.token)
    check('requestChatCompletions attaches and removes abort listener', signalAttached === 1 && signalRemoved === 1)
    check('requestChatCompletions returns text payload', response.type === 'text' && response.content === 'ok')
  } finally {
    global.fetch = originalFetch
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
}

async function testAIAnalyzerObjectResponse() {
  section('AI object response regression')
  const payload = JSON.stringify({
    topics: [{ id: 1, title: '测试话题', summary: '测试摘要', participants: ['Alice'] }],
    goldenQuotes: [{ sender: 'Alice', userId: '10001', content: '测试金句', reason: '测试点评' }],
    userTitles: [{ name: 'Alice', userId: '10001', title: '测试称号', mbti: 'ENFP', reason: '测试画像' }],
    qualityReview: {
      title: '测试锐评',
      subtitle: '测试副标题',
      dimensions: [{ name: '测试维度', percentage: 100, comment: '测试点评', color: '#39C5BB' }],
      summary: '测试总结',
    },
  })
  const mock = createAiRequestMock({
    compress: { type: 'text', content: '压缩摘要' },
    basic: { type: 'text', content: payload },
    full: { type: 'text', content: payload },
  })

  await withMockedAiAnalyzer(mock.request, async analyzer => {
    const result = await analyzer.analyzeWithAI(createSampleReportData(), true)
    check('analyzeWithAI parses object response topics', result.topics.length === 1)
    check('analyzeWithAI parses object response quotes', result.goldenQuotes.length === 1)
    check('analyzeWithAI parses object response titles', result.userTitles.length === 1)
    check('analyzeWithAI parses object response quality review', !!result.qualityReview && result.qualityReview.dimensions.length === 1)
  })
}

async function testConcurrentReportGuard() {
  section('middleware concurrency guard')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123', '456']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]

  let collectCalls = 0
  let analyzeCalls = 0
  let renderCalls = 0
  let resolvePrompt = null
  let resolveAnalysis = null
  const promptPending = new Promise(resolve => { resolvePrompt = resolve })
  const analysisPending = new Promise(resolve => { resolveAnalysis = resolve })

  try {
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => {
          collectCalls += 1
          return createSampleReportData()
        },
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return analysisPending
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('fake-png')
        },
      },
    }
    const runtime = createResourceRuntimeMock()

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]

    const firstSent = []
    const firstSession = makeSession({
      content: '群聊详细日报',
      guildId: '123',
      _sent: firstSent,
      send: async msg => {
        firstSent.push(msg)
        if (msg === 'Thinking....') return promptPending
        return true
      },
    })
    const secondSession = makeSession({ content: '群聊详细日报', guildId: '123' })

    const firstRun = middleware(firstSession, () => 'next-1')
    const secondRun = middleware(secondSession, () => 'next-2')

    check('first report submits background task', runtime.state.submissions.length === 1, JSON.stringify(runtime.state.submissions))
    check('detailed report sends Thinking while background task starts', firstSent.includes('Thinking....'), JSON.stringify(firstSent))
    check('second report is rejected while first is running', secondSession._sent.some(item => String(item).includes('正在生成中')), JSON.stringify(secondSession._sent))
    check('second report does not submit another task', runtime.state.submissions.length === 1, JSON.stringify(runtime.state.submissions))
    check('middleware does not call collector', collectCalls === 0, String(collectCalls))
    check('second report did not call analyzer', analyzeCalls === 0, String(analyzeCalls))
    check('second report did not call renderer', renderCalls === 0, String(renderCalls))

    resolvePrompt()
    resolveAnalysis({ topics: [], goldenQuotes: [], userTitles: [], qualityReview: null, tokenUsage: { totalTokens: 0 } })
    await Promise.all([firstRun, secondRun])
    check('first report clears in-flight after prompt send', !plugin._test.inFlightReports.has('123'))
    check('background submission writes cooldown', plugin._test.cooldown.has('123'))
  } finally {
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testCooldownAfterSuccessOnly() {
  section('cooldown success/failure regression')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-cooldown-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123', '456']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]

  let renderCalls = 0
  let now = 100000
  const originalDateNow = Date.now

  try {
    Date.now = () => now
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: { collectReportData: () => createSampleReportData() },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: { analyzeWithAI: async () => ({ topics: [], goldenQuotes: [] }) },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('fake-png')
        },
      },
    }
    const runtime = createResourceRuntimeMock()

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]

    const first = makeSession({ content: '群聊日报', guildId: '123' })
    await middleware(first, () => 'next')
    check('basic report submit sends Thinking', first._sent.includes('Thinking....'), JSON.stringify(first._sent))
    check('successful submit writes normal cooldown', plugin._test.cooldown.has('123'))

    const cooldownHit = makeSession({ content: '群聊日报', guildId: '123' })
    await middleware(cooldownHit, () => 'next')
    check('cooldown blocks immediate duplicate submit', cooldownHit._sent.some(item => String(item).includes('生成太频繁')), JSON.stringify(cooldownHit._sent))

    now += 61000
    runtime.state.submitError = new Error('submit failed')
    const failed = makeSession({ content: '群聊日报', guildId: '123' })
    failed.guildId = '456'
    await middleware(failed, () => 'next')
    check('submit failure returns controlled message', failed._sent.some(item => String(item).includes('提交后台任务失败')), JSON.stringify(failed._sent))
    check('submit failure writes short failure backoff', plugin._test.failureBackoff.has('456'))

    const backoff = makeSession({ content: '群聊日报', guildId: '123' })
    backoff.guildId = '456'
    await middleware(backoff, () => 'next')
    check('failed submit uses short failure backoff', backoff._sent.some(item => String(item).includes('稍等几秒')), JSON.stringify(backoff._sent))

    now += 11000
    runtime.state.submitError = null
    const retry = makeSession({ content: '群聊日报', guildId: '123' })
    retry.guildId = '456'
    await middleware(retry, () => 'next')
    check('successful retry sends Thinking', retry._sent.includes('Thinking....'), JSON.stringify(retry._sent))

    const secondCooldownHit = makeSession({ content: '群聊日报', guildId: '123' })
    secondCooldownHit.guildId = '456'
    await middleware(secondCooldownHit, () => 'next')
    check('retry success writes normal cooldown', secondCooldownHit._sent.some(item => String(item).includes('生成太频繁')), JSON.stringify(secondCooldownHit._sent))
    check('daily command middleware does not render synchronously', renderCalls === 0, String(renderCalls))
    check('successful submissions are recorded', runtime.state.submissions.length === 2, JSON.stringify(runtime.state.submissions))
  } finally {
    Date.now = originalDateNow
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testOpenDailyReportTaskLookupDoesNotMissUnderBacklogWindow() {
  section('open daily task lookup backlog-window regression')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-open-task-backlog-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]

  try {
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    const runtime = createResourceRuntimeMock()
    for (let i = 0; i < 1000; i += 1) {
      runtime.state.tasks.push({
        id: `unrelated-active-${i}`,
        kind: 'agent_task',
        status: 'pending',
        channelKey: `other-${i}`,
        userId: `user-${i}`,
        payload: {},
        notify: { target: 'none', status: 'pending' },
      })
    }
    runtime.state.tasks.push({
      id: 'daily-report-open-existing',
      kind: 'daily_report',
      status: 'deferred',
      channelKey: '123',
      userId: 'daily-user',
      payload: { detail: false },
      notify: { target: 'qq-group', channelKey: '123', status: 'pending' },
    })

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]

    const session = makeSession({ content: '群聊日报', guildId: '123' })
    await middleware(session, () => 'next')

    check('daily report duplicate lookup sees existing task beyond global list window',
      session._sent.some(item => String(item).includes('已在后台队列中')) &&
        session._sent.some(item => String(item).includes('daily-report-open-existing')),
      JSON.stringify(session._sent))
    check('daily report duplicate lookup does not submit another task under backlog window',
      runtime.state.submissions.length === 0,
      JSON.stringify(runtime.state.submissions))
  } finally {
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testMaintenanceModeBlocksDailyCommand() {
  section('maintenance mode command guard')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-maintenance-'))
  fs.writeFileSync(path.join(reportDataDir, 'ai-paused.txt'), '优化中\n', 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]

  try {
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    const runtime = createResourceRuntimeMock()

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]
    const session = makeSession({ content: '群聊日报', guildId: 'not-whitelisted' })
    let nextCalled = false

    await middleware(session, () => { nextCalled = true; return 'next' })

    check('maintenance daily command is intercepted', !nextCalled)
    check('maintenance daily command returns fixed text', session._sent[0] === '优化中', JSON.stringify(session._sent))
    check('maintenance daily command skips admission', runtime.state.admissions.length === 0, JSON.stringify(runtime.state.admissions))
    check('maintenance daily command skips S2 submission', runtime.state.submissions.length === 0, JSON.stringify(runtime.state.submissions))
    check('maintenance daily command does not set cooldown', !plugin._test.cooldown.has('not-whitelisted'))
  } finally {
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testSendFailureBoundary() {
  section('send failure boundary')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-send-fail-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]
  const oldSendRetryDelay = process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS

  let collectCalls = 0
  let analyzeCalls = 0
  let renderCalls = 0

  try {
    process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = '0'
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => {
          collectCalls += 1
          return createSampleReportData()
        },
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return { topics: [], goldenQuotes: [] }
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('fake-png')
        },
      },
    }
    const runtime = createResourceRuntimeMock()

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]
    const session = makeSession({
      content: '群聊日报',
      guildId: '123',
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })

    let rejected = false
    try {
      await middleware(session, () => 'next')
    } catch {
      rejected = true
    }
    check('daily report prompt send failure does not reject middleware', !rejected)
    check('daily report submits background task before prompt send failure', runtime.state.submissions.length === 1, JSON.stringify(runtime.state.submissions))
    check('daily report does not run synchronous pipeline after prompt failure', collectCalls === 0 && analyzeCalls === 0 && renderCalls === 0, JSON.stringify({ collectCalls, analyzeCalls, renderCalls }))
    check('daily report logs controlled prompt send failure', ctx._logs.some(log => log.level === 'warn' && log.msg.includes('日报后台任务提示发送失败')), JSON.stringify(ctx._logs))
    check('daily report clears in-flight after prompt send failure', !plugin._test.inFlightReports.has('123'))

    let retryAttempts = 0
    const retrySession = makeSession({
      content: '',
      guildId: '123',
      async send() {
        retryAttempts += 1
        if (retryAttempts === 1) throw new Error('Timeout with request send_group_msg')
        return true
      },
    })
    const retryOk = await plugin._test.safeSendDailyReport(ctx, retrySession, '日报生成超时了，请稍后再试。', '失败提示')
    check('daily report retries text send after OneBot timeout', retryOk && retryAttempts === 2, JSON.stringify({ retryOk, retryAttempts }))
    check('daily report logs text retry success', ctx._logs.some(log => log.level === 'info' && log.msg.includes('失败提示重试发送成功')), JSON.stringify(ctx._logs))
  } finally {
    if (oldSendRetryDelay === undefined) delete process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS
    else process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = oldSendRetryDelay
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testRenderPreflightSkipsAiAndChromium() {
  section('admission defer regression')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-preflight-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const originalAdmissionCache = require.cache[AI_ADMISSION_PATH]
  const originalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]
  const oldSendRetryDelay = process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS

  let collectCalls = 0
  let analyzeCalls = 0
  let renderCalls = 0
  let preflightCalls = 0

  try {
    process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = '0'
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => {
          collectCalls += 1
          return createSampleReportData()
        },
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return { topics: [] }
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        assertRenderEnvironment: () => {
          preflightCalls += 1
          throw new Error('available memory is too low for Chromium render (252MB < 300MB)')
        },
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('fake-png')
        },
      },
    }
    const runtime = createResourceRuntimeMock({
      admissionDecision: { decision: 'defer', reason: 'resource state black defers heavy task' },
    })

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]
    const session = makeSession({ content: '群聊详细日报', guildId: '123' })

    await middleware(session, () => 'next')

    check('admission defer submits one daily task', runtime.state.submissions.length === 1, JSON.stringify(runtime.state.submissions))
    check('admission defer marks task deferred', runtime.state.deferred.length === 1 && runtime.state.deferred[0].reason.includes('resource state black'), JSON.stringify(runtime.state.deferred))
    check('admission defer sends low-cost deferred notice', session._sent.some(item => String(item).includes('日报已延期')), JSON.stringify(session._sent))
    check('admission defer skips synchronous collect/AI/Chromium', collectCalls === 0 && analyzeCalls === 0 && renderCalls === 0 && preflightCalls === 0, JSON.stringify({ collectCalls, analyzeCalls, renderCalls, preflightCalls }))
    check('admission defer clears in-flight state', !plugin._test.inFlightReports.has('123'))
  } finally {
    if (oldSendRetryDelay === undefined) delete process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS
    else process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = oldSendRetryDelay
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    restoreModuleCache(AI_ADMISSION_PATH, originalAdmissionCache)
    restoreModuleCache(AI_TASK_STORE_PATH, originalTaskStoreCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function testRenderFailureSendsTextFallbackLegacy() {
  section('render text fallback regression')
  const reportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-text-fallback-'))
  fs.writeFileSync(path.join(reportDataDir, 'summary-whitelist.json'), JSON.stringify(['123']), 'utf8')

  const originalConfigCache = require.cache[CONFIG_PATH]
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPluginCache = require.cache[PLUGIN_PATH]
  const oldSendRetryDelay = process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS

  let analyzeCalls = 0
  let renderCalls = 0

  try {
    process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = '0'
    require.cache[CONFIG_PATH] = {
      id: CONFIG_PATH,
      filename: CONFIG_PATH,
      loaded: true,
      exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: reportDataDir },
    }
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: { collectReportData: () => createSampleReportData() },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return {
            topics: [{ title: '测试话题', summary: '测试摘要' }],
            goldenQuotes: [{ sender: 'Alice', content: '测试金句', reason: '测试点评' }],
            userTitles: [{ name: 'Alice', title: '测试称号', reason: '测试画像' }],
            qualityReview: { title: '测试锐评', summary: '测试总结' },
          }
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        assertRenderEnvironment: () => {},
        renderReport: async () => {
          renderCalls += 1
          throw new Error("Target.setAutoAttach timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.")
        },
      },
    }

    delete require.cache[PLUGIN_PATH]
    const plugin = require(PLUGIN_PATH)
    const ctx = makeCtx()
    plugin.apply(ctx)
    const middleware = ctx._middlewareList[0]
    const session = makeSession({ content: '群聊详细日报', guildId: '123' })

    await middleware(session, () => 'next')

    const fallbackText = session._sent.find(item => String(item).includes('详细日报文字版'))
    check('render failure runs AI before rendering', analyzeCalls === 1 && renderCalls === 1, JSON.stringify({ analyzeCalls, renderCalls }))
    check('render failure sends Thinking before fallback', session._sent[0] === 'Thinking......', JSON.stringify(session._sent))
    check('render failure sends text fallback with analysis', !!fallbackText && String(fallbackText).includes('话题摘要') && String(fallbackText).includes('测试话题'), JSON.stringify(session._sent))
    check('render failure classifies Target.setAutoAttach as timeout', ctx._logs.some(log => log.level === 'error' && log.msg.includes('生成失败[timeout]')), JSON.stringify(ctx._logs))
    check('render failure logs fallback success', ctx._logs.some(log => log.level === 'warn' && log.msg.includes('已发送文字降级日报[timeout]')), JSON.stringify(ctx._logs))
    check('render failure keeps normal image cooldown unset', !plugin._test.cooldown.has('123'))
  } finally {
    if (oldSendRetryDelay === undefined) delete process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS
    else process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS = oldSendRetryDelay
    restoreModuleCache(CONFIG_PATH, originalConfigCache)
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(PLUGIN_PATH, originalPluginCache)
    try { fs.rmSync(reportDataDir, { recursive: true, force: true }) } catch {}
  }
}

// ===== 3. models 单元测试 =====
section('models 单元测试')
async function testRenderFailureSendsTextFallback() {
  section('report-pipeline render fallback regression')
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-render-fallback-'))
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPipelineCache = require.cache[REPORT_PIPELINE_PATH]

  let collectCalls = 0
  let analyzeCalls = 0
  let renderCalls = 0

  try {
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => {
          collectCalls += 1
          return {
            date: '2099-01-01',
            totalMessages: 3,
            activeMembers: 2,
            emojiCount: 0,
            totalChars: 48,
            peakHour: '21:00-21:59',
            topMembers: [
              { name: 'Alice', userId: '10001', msgCount: 2 },
              { name: 'Bob', userId: '10002', msgCount: 1 },
            ],
            messages: [
              { time: '21:00', user: 'Alice', userId: '10001', content: 'first message' },
              { time: '21:01', user: 'Bob', userId: '10002', content: 'second message' },
              { time: '21:02', user: 'Alice', userId: '10001', content: 'third message' },
            ],
          }
        },
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return {
            topics: [{ title: 'Topic Alpha', summary: 'Summary Alpha' }],
            goldenQuotes: [{ sender: 'Alice', content: 'Quote Alpha', reason: 'Reason Alpha' }],
            userTitles: [{ name: 'Alice', title: 'Title Alpha', reason: 'Portrait Alpha' }],
            qualityReview: { title: 'Review Alpha', summary: 'Quality Alpha' },
          }
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        assertRenderEnvironment: () => {},
        renderReport: async () => {
          renderCalls += 1
          throw new Error('Target.setAutoAttach timed out while testing render fallback')
        },
      },
    }

    delete require.cache[REPORT_PIPELINE_PATH]
    const { generateDailyReportResult } = require(REPORT_PIPELINE_PATH)
    const steps = []
    const result = await generateDailyReportResult({
      taskId: 'render-failure-test',
      channelKey: '123',
      detail: true,
      outputDir,
      renderImage: true,
      onStep: step => steps.push(step),
    })

    const textPath = path.join(outputDir, 'report.txt')
    const resultPath = path.join(outputDir, 'result.json')
    const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf8') : ''
    const json = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null

    check('render failure collects and analyzes once', collectCalls === 1 && analyzeCalls === 1, JSON.stringify({ collectCalls, analyzeCalls }))
    check('render failure attempts render once', renderCalls === 1, JSON.stringify({ renderCalls }))
    check('render failure keeps text mode result', result.mode === 'text' && result.level === 'L2', JSON.stringify(result))
    check('render failure records render_failed reason', String(result.reason).startsWith('render_failed:Target.setAutoAttach timed out'), String(result.reason))
    check('render failure writes report.txt without image', result.imagePath === null && fs.existsSync(textPath), JSON.stringify({ imagePath: result.imagePath, textPathExists: fs.existsSync(textPath) }))
    check('render failure writes result.json as text', !!json && json.mode === 'text' && json.level === 'L2' && json.imagePath === null, JSON.stringify(json))
    check('render failure text includes AI topics', text.includes('Topic Alpha') && text.includes('Summary Alpha'), text.slice(0, 500))
    check('render failure emits pipeline steps', ['collecting', 'analyzing', 'compose_text', 'rendering', 'writing_result'].every(step => steps.includes(step)), JSON.stringify(steps))
  } finally {
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(REPORT_PIPELINE_PATH, originalPipelineCache)
    try { fs.rmSync(outputDir, { recursive: true, force: true }) } catch {}
  }
}

async function testRenderBlockedByActiveToolLease() {
  section('render blocked by active tool lease regression')
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-tool-lease-'))
  const originalDataCollectorCache = require.cache[DATA_COLLECTOR_PATH]
  const originalAnalyzerCache = require.cache[AI_ANALYZER_PATH]
  const originalRendererCache = require.cache[HTML_RENDERER_PATH]
  const originalPipelineCache = require.cache[REPORT_PIPELINE_PATH]
  const originalLeaseCache = require.cache[AI_ACTIVITY_LEASE_PATH]
  const serverModePath = path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-scheduler', 'server-mode-policy.js')
  const originalServerModeCache = require.cache[serverModePath]

  let collectCalls = 0
  let analyzeCalls = 0
  let renderCalls = 0
  let toolLeaseChecks = 0

  try {
    require.cache[DATA_COLLECTOR_PATH] = {
      id: DATA_COLLECTOR_PATH,
      filename: DATA_COLLECTOR_PATH,
      loaded: true,
      exports: {
        collectReportData: () => {
          collectCalls += 1
          return createSampleReportData()
        },
      },
    }
    require.cache[AI_ANALYZER_PATH] = {
      id: AI_ANALYZER_PATH,
      filename: AI_ANALYZER_PATH,
      loaded: true,
      exports: {
        analyzeWithAI: async () => {
          analyzeCalls += 1
          return {
            topics: [{ title: 'Tool Active', summary: 'Render should stay text-only.' }],
            goldenQuotes: [],
            userTitles: [],
            qualityReview: null,
          }
        },
      },
    }
    require.cache[HTML_RENDERER_PATH] = {
      id: HTML_RENDERER_PATH,
      filename: HTML_RENDERER_PATH,
      loaded: true,
      exports: {
        renderReport: async () => {
          renderCalls += 1
          return Buffer.from('unexpected-render')
        },
      },
    }
    require.cache[AI_ACTIVITY_LEASE_PATH] = {
      id: AI_ACTIVITY_LEASE_PATH,
      filename: AI_ACTIVITY_LEASE_PATH,
      loaded: true,
      exports: {
        hasActiveResourceActivityLease(kind) {
          if (kind === 'tool_active') toolLeaseChecks += 1
          return kind === 'tool_active'
        },
      },
    }
    require.cache[serverModePath] = {
      id: serverModePath,
      filename: serverModePath,
      loaded: true,
      exports: {
        readResourceActivityMutualExclusionState() {
          return { strictActivityMutualExclusion: true, serverMode: 'small', serverModeSource: 'test' }
        },
        readServerModeConfig() {
          return { serverMode: 'small', serverModeSource: 'test' }
        },
      },
    }

    delete require.cache[REPORT_PIPELINE_PATH]
    const { generateDailyReportResult } = require(REPORT_PIPELINE_PATH)
    const steps = []
    const result = await generateDailyReportResult({
      taskId: 'render-blocked-by-tool-lease',
      channelKey: 'lease-group',
      detail: true,
      outputDir,
      renderImage: true,
      onStep: step => steps.push(step),
    })

    const resultPath = path.join(outputDir, 'result.json')
    const json = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
    check('tool_active lease still allows collect/analyze/text', collectCalls === 1 && analyzeCalls === 1 && fs.existsSync(path.join(outputDir, 'report.txt')), JSON.stringify({ collectCalls, analyzeCalls }))
    check('tool_active lease blocks renderReport after text is ready', renderCalls === 0 && toolLeaseChecks >= 1, JSON.stringify({ renderCalls, toolLeaseChecks }))
    check('tool_active lease keeps report in text mode', result.mode === 'text' && result.imagePath === null, JSON.stringify(result))
    check('tool_active lease records render_blocked_by_tool_active reason', String(result.reason || '').includes('render_blocked_by_tool_active'), String(result.reason))
    check('tool_active lease writes result.json without rendering step', !!json && json.mode === 'text' && !steps.includes('rendering') && steps.includes('writing_result'), JSON.stringify({ json, steps }))
  } finally {
    restoreModuleCache(DATA_COLLECTOR_PATH, originalDataCollectorCache)
    restoreModuleCache(AI_ANALYZER_PATH, originalAnalyzerCache)
    restoreModuleCache(HTML_RENDERER_PATH, originalRendererCache)
    restoreModuleCache(REPORT_PIPELINE_PATH, originalPipelineCache)
    restoreModuleCache(AI_ACTIVITY_LEASE_PATH, originalLeaseCache)
    restoreModuleCache(serverModePath, originalServerModeCache)
    try { fs.rmSync(outputDir, { recursive: true, force: true }) } catch {}
  }
}

const result = models.createDefaultAnalysisResult()
check('createDefaultAnalysisResult returns object', typeof result === 'object')
check('result has topics', Array.isArray(result.topics))
check('result has userTitles', Array.isArray(result.userTitles))
check('result has goldenQuotes', Array.isArray(result.goldenQuotes))
check('result has tokenUsage', typeof result.tokenUsage === 'object')

const topic = models.createTopic(1, '测试标题', '测试摘要', ['用户1'])
check('createTopic returns correct shape', topic.id === 1 && topic.title === '测试标题')

const title = models.createUserTitle('测试用户', 'uid1', '活跃水怪', '描述', 'ENFP')
check('createUserTitle returns correct shape', title.name === '测试用户' && title.title === '活跃水怪')

const quote = models.createGoldenQuote('内容', '发送者', '点评')
check('createGoldenQuote returns correct shape', quote.content === '内容' && quote.sender === '发送者')

// ===== 4. data-collector 数据校验 =====
section('data-collector 数据校验')
const dc = require(DATA_COLLECTOR_PATH)
// 测试空目录
const emptyResult = dc.collectReportData('nonexistent-group-' + Date.now())
check('collectReportData returns null for missing cache', emptyResult === null)
const oldMaxAnalysisMessages = process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES
process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES = '200'
delete require.cache[DATA_COLLECTOR_PATH]
const cappedCollector = require(DATA_COLLECTOR_PATH)
const cappedBaseTs = Date.parse('2099-01-01T12:00:00+08:00')
const manyMessages = Array.from({ length: 260 }, (_, index) => ({
  time: '12:00:00',
  ts: cappedBaseTs + index,
  user: index % 2 ? '用户B' : '用户A',
  userId: index % 2 ? 'u-b' : 'u-a',
  content: `第 ${index + 1} 条消息 [CQ:face,id=14]`,
}))
const cappedData = cappedCollector.processMessages(manyMessages, '2099-01-01', Date.parse('2099-01-01T12:30:00+08:00'))
check('processMessages keeps full total stats', cappedData && cappedData.totalMessages === 260 && cappedData.emojiCount === 260)
check('processMessages caps analysis payload', cappedData && cappedData.messages.length === 200 && cappedData.sampledMessages === 200 && cappedData.truncatedMessages === 60)
check('processMessages returns tail sample', cappedData && cappedData.messages[0].content.includes('第 61 条消息'))
const reportNow = Date.parse('2099-01-01T12:30:00+08:00')
const mixedDayData = cappedCollector.processMessages([
  { time: '23:50:00', ts: Date.parse('2098-12-31T23:50:00+08:00'), user: '旧日', userId: 'old', content: '昨天消息 [CQ:face,id=14]' },
  { time: '00:05:00', ts: Date.parse('2099-01-01T00:05:00+08:00'), user: '今日A', userId: 'a', content: '今天消息 [CQ:face,id=14] 【QQ表情：微笑】' },
  { time: '12:00:00', ts: Date.parse('2099-01-01T12:00:00+08:00'), user: '今日B', userId: 'b', content: '中午 <face id="13"/> 😊' },
  { time: '16:00:00', ts: Date.parse('2099-01-01T16:00:00+08:00'), user: '未来', userId: 'future', content: '未来消息 [CQ:mface,id=1]' },
], '2099-01-01', reportNow)
check('processMessages filters old and future cache messages', mixedDayData && mixedDayData.totalMessages === 2 && mixedDayData.hourlyActivity[0] === 1 && mixedDayData.hourlyActivity[12] === 1 && mixedDayData.hourlyActivity[16] === 0, JSON.stringify(mixedDayData && mixedDayData.hourlyActivity))
check('processMessages counts CQ XML readable and unicode emoji', mixedDayData && mixedDayData.emojiCount === 4, JSON.stringify(mixedDayData && mixedDayData.emojiCount))
check('countEmojiInContent supports mixed emoji formats', cappedCollector.countEmojiInContent('[CQ:face,id=14] <face id="13"/> 【QQ表情：微笑】 😊') === 4)
if (oldMaxAnalysisMessages === undefined) delete process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES
else process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES = oldMaxAnalysisMessages
delete require.cache[DATA_COLLECTOR_PATH]
// ===== 5. index 中间件注册 =====
section('index 中间件注册')
const middlewareCommandDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-command-'))
fs.writeFileSync(path.join(middlewareCommandDataDir, 'summary-whitelist.json'), JSON.stringify(['123']), 'utf8')
const middlewareOriginalConfigCache = require.cache[CONFIG_PATH]
const middlewareOriginalPluginCache = require.cache[PLUGIN_PATH]
const middlewareOriginalAdmissionCache = require.cache[AI_ADMISSION_PATH]
const middlewareOriginalTaskStoreCache = require.cache[AI_TASK_STORE_PATH]
require.cache[CONFIG_PATH] = {
  id: CONFIG_PATH,
  filename: CONFIG_PATH,
  loaded: true,
  exports: { TIMEOUTS: { aiRequest: 30000, cooldown: 60000 }, DATA_DIR: middlewareCommandDataDir },
}
createResourceRuntimeMock()
const plugin = reloadPlugin()
check('plugin has name', plugin.name === 'daily-report')
check('plugin has apply', typeof plugin.apply === 'function')

const ctx = makeCtx()
plugin.apply(ctx)
check('middleware registered', ctx._middlewareList.length === 1)
check('ready event registered', (ctx._events.get('ready') || []).length === 1)

// ===== 6. 中间件命令匹配 =====
section('中间件命令匹配')
const middleware = ctx._middlewareList[0]

function testMiddleware(content, guildId) {
  const session = makeSession({ content, guildId })
  let nextCalled = false
  return middleware(session, () => { nextCalled = true; return '' })
    .then(() => ({ session, nextCalled }))
}

// 测试非日报命令应调用next
testMiddleware('你好', '123').then(nonReport => {
  check('非日报命令调用next', nonReport.nextCalled)

  // 测试日报命令不调用next（被拦截）
  return testMiddleware('群聊日报', '123')
}).then(reportResult => {
  check('群聊日报命令被拦截（不调用next）', !reportResult.nextCalled)
  check('日报命令返回提示', reportResult.session._sent.some(s => typeof s === 'string'))

  // 测试私聊被拒绝
  return testMiddleware('群聊日报', '')
}).then(privateResult => {
  check('私聊日报被拒绝', privateResult.session._sent.some(s => s.includes('群里使用')))

  // 测试详细日报命令匹配
  return testMiddleware('群聊详细日报', '123')
}).then(fullResult => {
  check('群聊详细日报命令被拦截', !fullResult.nextCalled)

  // 清理
  restoreModuleCache(CONFIG_PATH, middlewareOriginalConfigCache)
  restoreModuleCache(PLUGIN_PATH, middlewareOriginalPluginCache)
  restoreModuleCache(AI_ADMISSION_PATH, middlewareOriginalAdmissionCache)
  restoreModuleCache(AI_TASK_STORE_PATH, middlewareOriginalTaskStoreCache)
  try { fs.rmSync(middlewareCommandDataDir, { recursive: true, force: true }) } catch {}

  return testRendererTimeoutCleanup()
}).then(() => testRendererSlotReleasedWhenLeaseAcquireFails()
).then(() => testToolActiveRenderBlockRespectsServerMode()
).then(() => testAiFallbackRegression()
).then(() => testRequestChatCompletionsPayload()
).then(() => testAIAnalyzerObjectResponse()
).then(() => testConcurrentReportGuard()
).then(() => testCooldownAfterSuccessOnly()
).then(() => testOpenDailyReportTaskLookupDoesNotMissUnderBacklogWindow()
).then(() => testMaintenanceModeBlocksDailyCommand()
).then(() => testSendFailureBoundary()
).then(() => testRenderPreflightSkipsAiAndChromium()
).then(() => testRenderBlockedByActiveToolLease()
).then(() => testRenderFailureSendsTextFallback()
).then(() => {

  // ===== 长内容渲染回归 =====
  section('html-renderer long content regression')
  const originalExistsSync = fs.existsSync
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const puppeteerPath = require.resolve('puppeteer-core')
  const originalPuppeteerCache = require.cache[puppeteerPath]
  const timeoutToken = { id: 'render-timeout' }
  let timeoutMs = null
  let clearedToken = null
  let browserClosed = 0
  let networkIdleArgs = null
  let setContentArgs = null
  let screenshotArgs = null
  const viewportCalls = []
  let evaluateCalls = 0

  fs.existsSync = () => true
  global.setTimeout = (fn, ms) => {
    timeoutMs = ms
    return timeoutToken
  }
  global.clearTimeout = token => {
    clearedToken = token
  }
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      async launch() {
        return {
          async newPage() {
            return {
              async setRequestInterception() {},
              on() {},
              async setViewport(args) {
                viewportCalls.push(args)
              },
              async setContent(html, args) {
                setContentArgs = { html, args }
              },
              async evaluate() {
                evaluateCalls += 1
                return evaluateCalls === 1 ? true : 9200
              },
              async waitForNetworkIdle(args) {
                networkIdleArgs = args
              },
              async screenshot(args) {
                screenshotArgs = args
                return Buffer.from('render-ok')
              },
            }
          },
          async close() {
            browserClosed += 1
          },
        }
      },
    },
  }

  return (async () => {
    try {
      delete require.cache[HTML_RENDERER_PATH]
      const renderer = require(HTML_RENDERER_PATH)
      const buffer = await renderer.renderHtmlToImage('<html><body><div style="height:9200px">long</div></body></html>')
      check('renderHtmlToImage returns screenshot buffer', Buffer.isBuffer(buffer) && buffer.toString() === 'render-ok')
      check('renderHtmlToImage keeps setContent timeout', setContentArgs && setContentArgs.args && setContentArgs.args.waitUntil === 'domcontentloaded' && setContentArgs.args.timeout === 20000)
      check('renderHtmlToImage waits for assets', networkIdleArgs && networkIdleArgs.timeout === 8000 && networkIdleArgs.idleTime === 1000)
      check('renderHtmlToImage adjusts viewport height for long content', viewportCalls.length >= 2 && viewportCalls[0].height === 800 && viewportCalls[1].height === 6000)
      check('renderHtmlToImage clips screenshot to viewport', screenshotArgs && screenshotArgs.clip && screenshotArgs.clip.height === 6000)
      check('renderHtmlToImage clears timeout on success', timeoutMs === 8 * 60 * 1000 && clearedToken === timeoutToken)
      check('renderHtmlToImage closes browser on success', browserClosed === 1)
    } finally {
      fs.existsSync = originalExistsSync
      global.setTimeout = originalSetTimeout
      global.clearTimeout = originalClearTimeout
      if (originalPuppeteerCache) require.cache[puppeteerPath] = originalPuppeteerCache
      else delete require.cache[puppeteerPath]
      delete require.cache[HTML_RENDERER_PATH]
      require(HTML_RENDERER_PATH)
    }
  })()
}).then(() => {

  // ===== 总结 =====
  console.log(`\n=== daily-report 测试总结 ===`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
})
