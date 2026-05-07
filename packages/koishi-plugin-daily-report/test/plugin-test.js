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

function reloadDataCollector(dataDir) {
  if (dataDir) process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'constants.js'))]
  delete require.cache[require.resolve(path.resolve(__dirname, '..', 'lib', 'config.js'))]
  delete require.cache[DATA_COLLECTOR_PATH]
  return require(DATA_COLLECTOR_PATH)
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
check('data-collector exports parseMessageHour', typeof dataCollector.parseMessageHour === 'function')

const aiAnalyzer = require(AI_ANALYZER_PATH)
check('ai-analyzer exports analyzeWithAI', typeof aiAnalyzer.analyzeWithAI === 'function')
check('ai-analyzer exports full fallback builder', typeof aiAnalyzer.buildFallbackFullAnalysis === 'function')

const htmlRenderer = require(HTML_RENDERER_PATH)
check('html-renderer exports renderReport', typeof htmlRenderer.renderReport === 'function')

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

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'))
const dcTmp = reloadDataCollector(tmpDataDir)
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const cacheFile = path.join(tmpDataDir, 'today-cache-123456789.json')
fs.writeFileSync(cacheFile, JSON.stringify({
  date: today,
  messages: [
    { time: '12:30:00 AM', user: 'A', userId: '1', content: '凌晨消息' },
    { time: '12:30:00 PM', user: 'B', userId: '2', content: '中午消息' },
    { time: '3:30:00 PM', user: 'C', userId: '3', content: '下午消息 https://example.com' },
  ],
}), 'utf8')
const parsedReport = dcTmp.collectReportData('123456789')
check('collectReportData parses valid today cache', parsedReport && parsedReport.totalMessages === 3)
check('12 AM maps to hour 0', parsedReport && parsedReport.hourlyActivity[0] === 1)
check('12 PM maps to hour 12', parsedReport && parsedReport.hourlyActivity[12] === 1)
check('3 PM maps to hour 15', parsedReport && parsedReport.hourlyActivity[15] === 1)
fs.writeFileSync(cacheFile, '{bad json', 'utf8')
const corrupt = dcTmp.collectReportData('123456789', { detailedError: true })
check('collectReportData reports corrupt JSON', corrupt && corrupt.reason === 'invalid-json')
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

  // ===== 总结 =====
  console.log(`\n=== daily-report 测试总结 ===`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
})
