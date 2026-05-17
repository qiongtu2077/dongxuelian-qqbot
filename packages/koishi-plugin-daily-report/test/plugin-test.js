const fs = require('fs')
const os = require('os')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')
const DATA_COLLECTOR_PATH = path.resolve(__dirname, '..', 'lib', 'data-collector.js')
const AI_ANALYZER_PATH = path.resolve(__dirname, '..', 'lib', 'ai-analyzer.js')
const HTML_RENDERER_PATH = path.resolve(__dirname, '..', 'lib', 'html-renderer.js')
const MODELS_PATH = path.resolve(__dirname, '..', 'lib', 'models.js')

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
  const puppeteerPath = require.resolve('puppeteer-core')
  const originalPuppeteerCache = require.cache[puppeteerPath]
  const timeoutToken = { id: 'render-timeout' }
  let timeoutCreated = false
  let timeoutCleared = false
  let browserClosed = false

  fs.existsSync = value => String(value || '').includes('chrome') || originalExistsSync(value)
  global.setTimeout = () => { timeoutCreated = true; return timeoutToken }
  global.clearTimeout = token => { if (token === timeoutToken) timeoutCleared = true }
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      async launch() {
        return {
          async newPage() { throw new Error('new page failed') },
          async close() { browserClosed = true },
        }
      },
    },
  }

  try {
    delete require.cache[HTML_RENDERER_PATH]
    const renderer = require(HTML_RENDERER_PATH)
    try {
      await renderer.renderHtmlToImage('<html><body>fail</body></html>')
      check('renderHtmlToImage mock failure throws', false)
    } catch (error) {
      check('renderHtmlToImage mock failure throws', error.message === 'new page failed', error.message)
    }
    check('renderHtmlToImage clears timeout on failure', timeoutCreated && timeoutCleared, JSON.stringify({ timeoutCreated, timeoutCleared }))
    check('renderHtmlToImage closes browser on failure', browserClosed, JSON.stringify({ browserClosed }))
  } finally {
    fs.existsSync = originalExistsSync
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
    if (originalPuppeteerCache) require.cache[puppeteerPath] = originalPuppeteerCache
    else delete require.cache[puppeteerPath]
    delete require.cache[HTML_RENDERER_PATH]
    require(HTML_RENDERER_PATH)
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

// ===== 3. models 单元测试 =====
section('models 单元测试')
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
const manyMessages = Array.from({ length: 260 }, (_, index) => ({
  time: '12:00:00',
  ts: Date.now() + index,
  user: index % 2 ? '用户B' : '用户A',
  userId: index % 2 ? 'u-b' : 'u-a',
  content: `第 ${index + 1} 条消息 [CQ:face,id=14]`,
}))
const cappedData = cappedCollector.processMessages(manyMessages, '2099-01-01')
check('processMessages keeps full total stats', cappedData && cappedData.totalMessages === 260 && cappedData.emojiCount === 260)
check('processMessages caps analysis payload', cappedData && cappedData.messages.length === 200 && cappedData.sampledMessages === 200 && cappedData.truncatedMessages === 60)
check('processMessages returns tail sample', cappedData && cappedData.messages[0].content.includes('第 61 条消息'))
if (oldMaxAnalysisMessages === undefined) delete process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES
else process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES = oldMaxAnalysisMessages
delete require.cache[DATA_COLLECTOR_PATH]
// ===== 5. index 中间件注册 =====
section('index 中间件注册')
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
  process.env.DONGXUELIAN_AI_DATA_DIR = os.tmpdir()
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
  delete process.env.DONGXUELIAN_AI_DATA_DIR

  return testRendererTimeoutCleanup()
}).then(() => {

  // ===== 总结 =====
  console.log(`\n=== daily-report 测试总结 ===`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
})
