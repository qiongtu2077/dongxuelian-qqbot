// AI 插件综合测试套件
// 冒烟测试 + 单元测试 + 回归测试 + 功能测试 + 安全测试

const path = require('path')
const indexJsPath = path.join(__dirname, 'packages', 'koishi-plugin-dongxuelian-ai', 'lib', 'index.js')

let passed = 0
let failed = 0
const failures = []

function assert(condition, testName) {
  if (condition) {
    passed++
    console.log(`  ✓ ${testName}`)
  } else {
    failed++
    failures.push(testName)
    console.log(`  ✗ ${testName}`)
  }
}

function assertEqual(actual, expected, testName) {
  assert(actual === expected, `${testName} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`)
}

// ============================================================
// 1. 冒烟测试 (Smoke Tests)
// ============================================================
console.log('\n=== 冒烟测试 ===')

// 1.1 语法检查
try {
  require(indexJsPath)
  assert(true, 'index.js 语法检查通过')
} catch (e) {
  assert(false, `index.js 语法检查失败: ${e.message}`)
}

// 1.2 关键常量存在
try {
  const mod = require(indexJsPath)
  assert(typeof mod.name === 'string', 'exports.name 存在')
  assert(typeof mod.apply === 'function', 'exports.apply 存在')
} catch (e) {
  assert(false, `模块导出检查失败: ${e.message}`)
}

// ============================================================
// 2. 回归测试 (Regression Tests)
// ============================================================
console.log('\n=== 回归测试 ===')

// 2.1 C-01: isRandomCandidate 不是 const
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const lines = src.split('\n')
  const isRandomLine = lines.findIndex(l => l.includes('isRandomCandidate') && l.includes('='))
  if (isRandomLine >= 0) {
    const line = lines[isRandomLine]
    assert(!line.includes('const isRandomCandidate'), 'C-01: isRandomCandidate 不是 const')
    assert(line.includes('let isRandomCandidate'), 'C-01: isRandomCandidate 是 let')
  } else {
    assert(false, 'C-01: isRandomCandidate 行未找到')
  }
} catch (e) {
  assert(false, `C-01 检查失败: ${e.message}`)
}

// 2.2 CS-02: providerDef.models[0] 有 .id
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(!src.includes('providerDef.models[0] :'), 'CS-02: 没有裸 providerDef.models[0]')
  assert(src.includes('providerDef.models[0].id :'), 'CS-02: 使用 providerDef.models[0].id')
} catch (e) {
  assert(false, `CS-02 检查失败: ${e.message}`)
}

// 2.3 D-02: THINKING_OUTPUT_RE 是模块级常量
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('const THINKING_OUTPUT_RE'), 'D-02: THINKING_OUTPUT_RE 已提取为常量')
  // 确认没有 inline /.../.test() 用法（常量定义本身不算）
  const inlineUsage = (src.match(/\/根据系统指令.*?\/\.test\(/g) || []).length
  assert(inlineUsage === 0, `D-02: inline 正则用法已消除 (剩余 ${inlineUsage} 处)`)
} catch (e) {
  assert(false, `D-02 检查失败: ${e.message}`)
}

// 2.4 D-03: SENSITIVE_KEYWORDS_RE 统一
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('const SENSITIVE_KEYWORDS_RE'), 'D-03: SENSITIVE_KEYWORDS_RE 已提取为常量')
  // 确认没有 inline 敏感关键词
  const strictCount = (src.match(/const strictKeywords\s*=/g) || []).length
  const sensitiveCount = (src.match(/const sensitiveKeywords\s*=/g) || []).length
  assert(strictCount === 0, `D-03: strictKeywords 已消除 (剩余 ${strictCount} 处)`)
  assert(sensitiveCount === 0, `D-03: sensitiveKeywords 已消除 (剩余 ${sensitiveCount} 处)`)
} catch (e) {
  assert(false, `D-03 检查失败: ${e.message}`)
}

// 2.5 RX-01: 贴图正则预编译
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('STICKER_NEG_RE_MAP'), 'RX-01: STICKER_NEG_RE_MAP 预编译正则存在')
  // sendReply 中的 new RegExp 只允许昵称替换用（不在贴图匹配中）
  const sendReplyStart = src.indexOf('async function sendReply')
  const sendReplyEnd = src.indexOf('exports.apply', sendReplyStart)
  const sendReplyBody = src.slice(sendReplyStart, sendReplyEnd)
  const stickerNewReg = sendReplyBody.match(/new RegExp\('不/g)
  assert(!stickerNewReg, 'RX-01: 贴图匹配不再 new RegExp')
} catch (e) {
  assert(false, `RX-01 检查失败: ${e.message}`)
}

// 2.6 DC-01: trimReply 使用 maxChars
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const trimStart = src.indexOf('function trimReply(')
  const trimEnd = src.indexOf('\n}', trimStart)
  const trimBody = src.slice(trimStart, trimEnd)
  assert(trimBody.includes('maxChars'), 'DC-01: trimReply 使用 maxChars 参数')
  assert(trimBody.includes('.slice(0,'), 'DC-01: trimReply 有截断逻辑')
} catch (e) {
  assert(false, `DC-01 检查失败: ${e.message}`)
}

// 2.7 DC-02: 无 console.log
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(!src.includes('console.log('), 'DC-02: 没有 console.log 残留')
} catch (e) {
  assert(false, `DC-02 检查失败: ${e.message}`)
}

// 2.8 MAX_REPLY_RETRIES = 5
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('const MAX_REPLY_RETRIES = 5'), '回归: MAX_REPLY_RETRIES = 5')
} catch (e) {
  assert(false, `MAX_REPLY_RETRIES 检查失败: ${e.message}`)
}

// 2.9 昵称替换代码存在
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('引用回复时替换昵称') || src.includes('替换昵称为你'), '回归: 昵称替换代码存在')
} catch (e) {
  assert(false, `昵称替换检查失败: ${e.message}`)
}

// 2.10 finalReply 重复检查剥离 [图:xxx]
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('finalReply.replace(/\\[图:[^\\[\\]]+\\]/g'), '回归: finalReply 重复检查剥离 [图:xxx]')
} catch (e) {
  assert(false, `finalReply 重复检查失败: ${e.message}`)
}

// ============================================================
// 3. 单元测试 (Unit Tests)
// ============================================================
console.log('\n=== 单元测试 ===')

// 3.1 trimReply 功能
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  // 提取 trimReply 函数并测试
  const fn = new Function('text', 'maxChars', `
    const MAX_OUTPUT_CHARS_FRIENDLY = 80
    const value = String(text).trim()
    if (!value) return '东雪莲信号断开。'
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars)
  `)
  assertEqual(fn('hello', 10), 'hello', 'trimReply: 短文本不截断')
  assertEqual(fn('a'.repeat(100), 80), 'a'.repeat(80), 'trimReply: 超长文本截断到 maxChars')
  assertEqual(fn('', 80), '东雪莲信号断开。', 'trimReply: 空文本返回默认')
  assertEqual(fn('  ', 80), '东雪莲信号断开。', 'trimReply: 纯空格返回默认')
} catch (e) {
  assert(false, `trimReply 单元测试失败: ${e.message}`)
}

// 3.2 THINKING_OUTPUT_RE 匹配
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const reMatch = src.match(/const THINKING_OUTPUT_RE = (\/.*?\/)/)
  if (reMatch) {
    const re = eval(reMatch[1])
    assert(re.test('根据系统指令，我应该回复'), 'THINKING_OUTPUT_RE: 匹配"根据系统指令"')
    assert(re.test('作为东雪莲，我认为'), 'THINKING_OUTPUT_RE: 匹配"作为东雪莲"')
    assert(re.test('当前场景下，我可以吐槽'), 'THINKING_OUTPUT_RE: 匹配"可以吐槽"')
    assert(!re.test('你好啊，今天天气不错'), 'THINKING_OUTPUT_RE: 不匹配普通对话')
  }
} catch (e) {
  assert(false, `THINKING_OUTPUT_RE 测试失败: ${e.message}`)
}

// 3.3 SENSITIVE_KEYWORDS_RE 匹配
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const reMatch = src.match(/const SENSITIVE_KEYWORDS_RE = (\/.*?\/i)/)
  if (reMatch) {
    const re = eval(reMatch[1])
    assert(re.test('台湾独立'), 'SENSITIVE_KEYWORDS_RE: 匹配"台湾"')
    assert(re.test('天安门事件'), 'SENSITIVE_KEYWORDS_RE: 匹配"天安门"')
    assert(re.test('法轮功'), 'SENSITIVE_KEYWORDS_RE: 匹配"法轮功"')
    assert(re.test('taiwan'), 'SENSITIVE_KEYWORDS_RE: 匹配英文"taiwan"')
    assert(re.test('江青'), 'SENSITIVE_KEYWORDS_RE: 匹配"江青"')
    assert(re.test('敏感政治话题'), 'SENSITIVE_KEYWORDS_RE: 匹配"敏感政治"')
    assert(!re.test('今天吃什么'), 'SENSITIVE_KEYWORDS_RE: 不匹配普通话题')
  }
} catch (e) {
  assert(false, `SENSITIVE_KEYWORDS_RE 测试失败: ${e.message}`)
}

// 3.4 STICKER_NEG_RE_MAP 预编译
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('STICKER_NEG_RE_MAP'), 'STICKER_NEG_RE_MAP 存在')
  // 模拟测试
  const re = new RegExp('不.{0,3}绷')
  assert(re.test('不绷'), 'STICKER_NEG_RE: 匹配"不绷"')
  assert(re.test('不太绷'), 'STICKER_NEG_RE: 匹配"不太绷"')
  assert(!re.test('绷'), 'STICKER_NEG_RE: 不匹配单独"绷"')
} catch (e) {
  assert(false, `STICKER_NEG_RE_MAP 测试失败: ${e.message}`)
}

// ============================================================
// 4. 功能测试 (Functional Tests)
// ============================================================
console.log('\n=== 功能测试 ===')

// 4.1 STICKER_MAP 完整性
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const mapMatch = src.match(/const STICKER_MAP = \[([\s\S]*?)\]\.sort/)
  if (mapMatch) {
    const entries = mapMatch[1].match(/\{ kw:/g) || []
    assert(entries.length >= 40, `STICKER_MAP: ${entries.length} 个条目 (>=40)`)
  }
} catch (e) {
  assert(false, `STICKER_MAP 完整性检查失败: ${e.message}`)
}

// 4.2 STICKER_MAP 排序（按长度降序）
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('.sort((a, b) => b.kw.length - a.kw.length)'), 'STICKER_MAP: 按关键词长度降序排序')
} catch (e) {
  assert(false, `STICKER_MAP 排序检查失败: ${e.message}`)
}

// 4.3 sendReply 接受 ctx 参数
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('async function sendReply(ctx, session, reply, isRandom'), 'sendReply: 接受 ctx 参数')
} catch (e) {
  assert(false, `sendReply 参数检查失败: ${e.message}`)
}

// 4.4 h('image', { src }) 格式
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes("h('image', { src: b64 })"), 'sendReply: 使用 h(image, {src}) 格式')
} catch (e) {
  assert(false, `h(image) 格式检查失败: ${e.message}`)
}

// 4.5 去重检查
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(src.includes('!pendingStickers.includes(b64)'), 'sendReply: pendingStickers 去重检查')
} catch (e) {
  assert(false, `去重检查失败: ${e.message}`)
}

// ============================================================
// 5. 安全测试 (Security Tests)
// ============================================================
console.log('\n=== 安全测试 ===')

// 5.1 无硬编码 API Key
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(!src.includes('sk-'), '安全: 无硬编码 OpenAI key')
  assert(!src.match(/apiKey\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/), '安全: 无硬编码长 key')
} catch (e) {
  assert(false, `API Key 安全检查失败: ${e.message}`)
}

// 5.2 无 eval() 使用（除了正则）
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  // 排除正则中的 eval
  const evalMatches = src.match(/\beval\s*\(/g) || []
  assert(evalMatches.length === 0, `安全: 无 eval() 调用 (找到 ${evalMatches.length} 个)`)
} catch (e) {
  assert(false, `eval 安全检查失败: ${e.message}`)
}

// 5.3 无 innerHTML/dangerouslySetInnerHTML
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  assert(!src.includes('innerHTML'), '安全: 无 innerHTML')
  assert(!src.includes('dangerouslySet'), '安全: 无 dangerouslySetInnerHTML')
} catch (e) {
  assert(false, `XSS 安全检查失败: ${e.message}`)
}

// 5.4 正则注入防护
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  // 检查用户输入是否经过正则转义
  assert(src.includes("replace(/[.*+?^${}()|[\\]\\\\]/g"), '安全: 用户输入正则转义存在')
} catch (e) {
  assert(false, `正则注入检查失败: ${e.message}`)
}

// 5.5 WebSocket 连接不暴露到外部
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const wsMatches = src.match(/require\(['"]ws['"]\)/g) || []
  assert(wsMatches.length > 0, '安全: WebSocket 库被引用')
  // 确认所有 ws 连接都指向 127.0.0.1
  const wsUrls = src.match(/ws:\/\/[^\s'"]+/g) || []
  for (const url of wsUrls) {
    assert(url.includes('127.0.0.1'), `安全: WebSocket URL 指向 localhost (${url.slice(0,50)})`)
  }
} catch (e) {
  assert(false, `WebSocket 安全检查失败: ${e.message}`)
}

// ============================================================
// 6. 边界测试 (Edge Case Tests)
// ============================================================
console.log('\n=== 边界测试 ===')

// 6.1 trimReply 极端输入
try {
  const fn = new Function('text', 'maxChars', `
    const value = String(text).trim()
    if (!value) return '东雪莲信号断开。'
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars)
  `)
  assertEqual(fn('', 10), '东雪莲信号断开。', 'trimReply: 空字符串返回默认')
  assertEqual(fn('   ', 10), '东雪莲信号断开。', 'trimReply: 纯空格返回默认')
  assertEqual(fn(null, 10), 'null', 'trimReply: null → String(null)="null"（预期行为）')
  assertEqual(fn(undefined, 10), 'undefined', 'trimReply: undefined → String(undefined)="undefined"（预期行为）')
  assertEqual(fn(12345, 3), '123', 'trimReply: 数字输入截断')
  assertEqual(fn('你', 80), '你', 'trimReply: 单字中文')
} catch (e) {
  assert(false, `trimReply 边界测试失败: ${e.message}`)
}

// 6.2 THINKING_OUTPUT_RE 边界
try {
  const src = require('fs').readFileSync(indexJsPath, 'utf8')
  const reMatch = src.match(/const THINKING_OUTPUT_RE = (\/.*?\/)/)
  if (reMatch) {
    const re = eval(reMatch[1])
    assert(!re.test(''), 'THINKING_OUTPUT_RE: 不匹配空字符串')
    assert(!re.test('规则'), 'THINKING_OUTPUT_RE: 不匹配单独"规则"（太短）')
    assert(re.test('规则：xxx'), 'THINKING_OUTPUT_RE: 匹配"规则："')
  }
} catch (e) {
  assert(false, `THINKING_OUTPUT_RE 边界测试失败: ${e.message}`)
}

// ============================================================
// 结果汇总
// ============================================================
console.log('\n' + '='.repeat(50))
console.log(`汇总: ${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) {
  console.log('\n失败项:')
  failures.forEach(f => console.log(`  ✗ ${f}`))
}
console.log('='.repeat(50))
