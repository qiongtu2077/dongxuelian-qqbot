const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const LIB = path.join(ROOT, 'packages/koishi-plugin-dongxuelian-ai', 'lib')
const HELP = path.join(ROOT, 'packages/koishi-plugin-dongxuelian-help', 'lib')

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
let totalPassed = 0
let totalFailed = 0

function check(label, ok, detail) {
  if (ok) { totalPassed++; console.log(`  ${PASS} ${label}`) }
  else { totalFailed++; console.log(`  ${FAIL} ${label}${detail ? ': ' + detail : ''}`) }
}

// ===== 1. 模块加载 =====
console.log('\x1b[1m=== 1. 模块加载 ===\x1b[0m')
const modPaths = {
  constants: path.join(LIB, 'constants'),
  utils: path.join(LIB, 'utils'),
  persona: path.join(LIB, 'persona'),
  api: path.join(LIB, 'api'),
  conversation: path.join(LIB, 'conversation'),
  handler: path.join(LIB, 'handler'),
}
const loaded = {}
for (const [name, mp] of Object.entries(modPaths)) {
  try { loaded[name] = require(mp); check(name, true) }
  catch (e) { check(name, false, e.message) }
}
try {
  require(path.join(HELP, 'index'))
  check('help', true)
} catch (e) {
  check('help', false, e.message)
}

// ===== 2. 函数去重（所有文件） =====
console.log('\n\x1b[1m=== 2. 函数去重 ===\x1b[0m')
const files = ['index.js', 'constants.js', 'utils.js', 'persona.js', 'api.js', 'conversation.js', 'handler.js']
const all = []
for (const f of files) {
  const content = fs.readFileSync(path.join(LIB, f), 'utf8')
  const funcs = [...content.matchAll(/(?:^(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\(\)\s*=>))/gm)]
  for (const m of funcs) {
    const line = content.substring(0, m.index).split('\n').length
    all.push({ name: m[1] || m[2], file: f, line })
  }
}
const seen = {}
let dups = 0
for (const a of all) {
  if (seen[a.name]) {
    check(`重复: ${a.name}`, false, `${a.file}:${a.line} (已在 ${seen[a.name].file}:${seen[a.name].line})`)
    dups++
  }
  seen[a.name] = a
}
if (dups === 0) check(`${all.length} 个函数，无重复`, true)

// ===== 3. 常量完整性 =====
console.log('\n\x1b[1m=== 3. 常量完整性 ===\x1b[0m')
const c = loaded.constants
const required = [
  'DATA_DIR', 'PLUGIN_VERSION', 'KEY_FILE', 'MODEL_FILE', 'BASE_URL_FILE',
  'SKILLS_DIR', 'SKILLS_CORE_DIR', 'SKILLS_MODES_DIR', 'SKILLS_PERSONAS_DIR', 'SKILLS_LORE_DIR',
  'PROVIDERS', 'SENSITIVE_KEYWORDS_RE', 'CONVERSATIONS_DIR', 'USER_PROFILE_DIR',
  'REQUEST_TIMEOUT', 'TERRA_LORE_TRIGGER_SET',
]
const missingC = required.filter(k => c[k] === undefined)
if (missingC.length) {
  for (const k of missingC) check(`缺失常量: ${k}`, false)
} else {
  check(`${required.length} 个常量全部存在`, true)
}

// ===== 4. 工具函数导出 =====
console.log('\n\x1b[1m=== 4. 工具函数 ===\x1b[0m')
const u = loaded.utils
const utilsExpected = [
  'splitSentences', 'sanitizeUserName', 'getRandomDelayMs',
  'sanitizeUserInput', 'isJailbreakAttempt', 'isHostileInput',
  'isRareProvocation',
  'getSenderUserId', 'hasAdminPermission', 'stripMentions',
  'collapseRepeatedBotCalls',
  'isDirectAtBot', 'formatPercent', 'readTextFile', 'writeTextFile',
  'readJsonFile', 'writeJsonFile',
  'safeUnlink',
  'sleep', 'extractImageUrls', 'normalizeReplyFingerprint',
  'isReplyTooSimilar', 'isOverusedReply', 'hasBannedOutput',
  'getModelDisplayName', 'sanitizeReply', 'trimReply',
]
const uMissing = utilsExpected.filter(k => typeof u[k] !== 'function')
if (uMissing.length) {
  for (const k of uMissing) check(`utils 缺失: ${k}`, false)
} else {
  check(`utils: ${Object.keys(u).filter(k => typeof u[k] === 'function').length} 个函数，关键函数齐全`, true)
}

// ===== 5. splitSentences 行为测试 =====
console.log('\n\x1b[1m=== 5. splitSentences 行为 ===\x1b[0m')
const splitSentences = u.splitSentences
if (typeof splitSentences === 'function') {
  const testCases = [
    { input: '你好。世界！', expect: 2, label: '句号问号分句' },
    { input: '嘿嘿～让我想想', expect: 1, label: '波浪号不分句' },
    { input: '测试😊继续', expect: 1, label: 'emoji 不分句' },
    { input: '第一句。\n\n第二句。', expect: 2, label: '换行合并（去 \\n 分句后）' },
    { input: '......等等', expect: 2, label: '省略号分句（...... 是分句符）' },
    { input: '', expect: 1, label: '空字符串' },
  ]
  for (const tc of testCases) {
    const result = splitSentences(tc.input)
    const pass = Array.isArray(result) && (tc.expect === -1 ? result.length >= 1 : result.length === tc.expect)
    check(tc.label, pass, `输入"${tc.input}" → [${result.length}段]: ${JSON.stringify(result)}`)
  }
}

// ===== 6. Persona 函数导出 =====
console.log('\n\x1b[1m=== 6. Persona 函数 ===\x1b[0m')
const p = loaded.persona
const pExpected = [
  'getUserPersona', 'setUserPersona', 'resetUserPersona',
  'getGroupPersona', 'setGroupPersona', 'resetGroupPersona',
  'resolvePersona', 'getAvailablePersonals', 'loadPersonalSkill',
  'parsePersonaFrontmatter',
]
const pMissing = pExpected.filter(k => typeof p[k] !== 'function')
if (pMissing.length) {
  for (const k of pMissing) check(`persona 缺失: ${k}`, false)
} else {
  check(`persona: ${Object.keys(p).filter(k => typeof p[k] === 'function').length} 个函数`, true)
}

// ===== 7. 人格加载测试 =====
console.log('\n\x1b[1m=== 7. 人格文件加载 ===\x1b[0m')
const personas = p.getAvailablePersonals()
check(`getAvailablePersonals 返回 ${personas.length} 个人格`, personas.length >= 1)
for (const ps of personas) {
  const content = p.loadPersonalSkill(ps.name)
  check(`加载 "${ps.name}"`, !!content, content ? `${content.length} chars` : '失败')
}

// ===== 8. API 函数导出 =====
console.log('\n\x1b[1m=== 8. API 函数 ===\x1b[0m')
const api = loaded.api
const apiExpected = [
  'requestChatCompletions', 'buildFallbackConfig', 'getFallbackSteps', 'buildResponsesInput', 'extractResponsesText',
  'requestOpenAIResponsesWithSearch',
  'isVisionModel', 'callGetImage',
  'readImageAsBase64', 'downloadImageAsBase64', 'extractImageFileFromElements',
]
const aMissing = apiExpected.filter(k => typeof api[k] !== 'function')
if (aMissing.length) {
  for (const k of aMissing) check(`api 缺失: ${k}`, false)
} else {
  check(`api: ${Object.keys(api).filter(k => typeof api[k] === 'function').length} 个函数`, true)
}

// ===== 9. Conversation 函数导出 =====
console.log('\n\x1b[1m=== 9. Conversation 函数 ===\x1b[0m')
const conv = loaded.conversation
const convExpected = [
  'getConversationKey', 'getChannelKey', 'touchConversation',
  'readConversationDisk', 'writeConversationDisk',
  'getConversationHistory', 'saveConversationTurn', 'generateConversationSummary',
  'saveSharedChannelTurn', 'saveUserProfile', 'saveSensitiveCache',
  'analyzeChannelSensitive', 'clearConversationHistory', 'clearUserConversationHistory',
  'getReplyFingerprintHistory', 'saveReplyFingerprint',
  'getRecentAssistantReplies', 'getRecentUserMessages',
  'findChannelMessageById', 'collectReplyChain',
  'getQuotedMessageNote', 'getSharedContextNote',
]
const convMissing = convExpected.filter(k => typeof conv[k] !== 'function')
if (convMissing.length) {
  for (const k of convMissing) check(`conversation 缺失: ${k}`, false)
} else {
  check(`conversation: ${Object.keys(conv).filter(k => typeof conv[k] === 'function').length} 个函数`, true)
}

// ===== 9.5 Handler 函数 =====
console.log('\n\x1b[1m=== 9.5 Handler 函数 ===\x1b[0m')
const handler = loaded.handler
check('handler.handleCommand exported', typeof handler.handleCommand === 'function')

// ===== 10. 主 index.js 关键函数 =====
console.log('\n\x1b[1m=== 10. index.js 关键函数 ===\x1b[0m')
try {
  const main = require(path.join(LIB, 'index'))
  const mains = [
    'chat', 'chatJailbreak', 'callOpenAI',
    'sendReply', 'loadConfig', 'loadSkills', 'loadSkillsContentCache',
    'checkGroupRepeat', 'getRandomTriggerRate',
    'buildFriendlySystemPrompt', 'buildAbusiveSystemPrompt',
    'buildFriendlySafetyFramework', 'buildTestSystemPrompt',
    'shouldInjectLore', 'shouldInjectTerraLore',
    'enqueueForChannel', 'setRepeatEnabled',
  ]
  const mExported = mains.filter(k => typeof main[k] === 'function')
  // Most functions are internal (not exported), so just check exports.name
  check(`exports.name = "${main.name}"`, main.name === 'dongxuelian-ai')
} catch (e) {
  check('index.js 加载', false, e.message)
}

// ===== 10.5 Repo health =====
console.log('\n\x1b[1m=== 10.5 Repo health ===\x1b[0m')
try {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check('package scripts.test', !!rootPkg.scripts && rootPkg.scripts.test === 'node packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js')
  check('package scripts.check', !!rootPkg.scripts && typeof rootPkg.scripts.check === 'string' && rootPkg.scripts.check.includes('node -c packages/koishi-plugin-dongxuelian-ai/lib/index.js'))
  check('package scripts.start', !!rootPkg.scripts && rootPkg.scripts.start === 'node start.js')
} catch (e) {
  check('package scripts parse', false, e.message)
}
try {
  const aiPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/koishi-plugin-dongxuelian-ai/package.json'), 'utf8'))
  check('PLUGIN_VERSION matches package.json', c.PLUGIN_VERSION === aiPkg.version, `${c.PLUGIN_VERSION} !== ${aiPkg.version}`)
} catch (e) {
  check('AI package version parse', false, e.message)
}
try {
  const fallbackSteps = api.getFallbackSteps()
  const summary = fallbackSteps.map(s => `${s.provider}:${s.model}:${s.keyFile ? path.basename(s.keyFile) : ''}`).join('|')
  check('fallback order stable', summary === 'glm:glm-4.6v-flash:ai-glm-key.txt|opencode:deepseek-v4-flash:|dashscope:qwen3.5-plus:ai-dashscope-key.txt|dashscope:qwen3.6-plus:ai-dashscope-key.txt', summary)
} catch (e) {
  check('fallback order stable', false, e.message)
}
try {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  check('gitignore package txt data', gitignore.includes('packages/*/data/*.txt'))
  check('gitignore package key data', gitignore.includes('packages/*/data/*key*'))
  check('gitignore package user profiles', gitignore.includes('packages/*/data/user-profiles/'))
  check('gitignore package conversations', gitignore.includes('packages/*/data/conversations/'))
  check('gitignore keeps ai-skills', gitignore.includes('!packages/koishi-plugin-dongxuelian-ai/data/ai-skills/**'))
} catch (e) {
  check('gitignore parse', false, e.message)
}

// ===== 11. 跨文件引用校验 =====
console.log('\n\x1b[1m=== 11. 跨文件引用 ===\x1b[0m')
// 检查 conversation.js 是否引用了被删除的常量
const convSrc = fs.readFileSync(path.join(LIB, 'conversation.js'), 'utf8')
check('conversation.js 未引用 DATA_DIR', !convSrc.includes('DATA_DIR'))
check('conversation.js 未引用 POLITICAL_DETECT_FILE', !convSrc.includes('POLITICAL_DETECT_FILE'))

const utilsSrc = fs.readFileSync(path.join(LIB, 'utils.js'), 'utf8')
check('utils.js 未引用 ABUSIVE_FALLBACK_REPLIES', !utilsSrc.includes('ABUSIVE_FALLBACK_REPLIES'))
check('utils.js 未引用 REPEATED_FALLBACK_REPLIES', !utilsSrc.includes('REPEATED_FALLBACK_REPLIES'))

const apiSrc = fs.readFileSync(path.join(LIB, 'api.js'), 'utf8')
check('api.js 未引用 isOpenAIOfficialConfig', !apiSrc.includes('isOpenAIOfficialConfig'))

const msgSrc = fs.readFileSync(path.join(LIB, 'message-reader.js'), 'utf8')
// 确认死 export 已移除
check('message-reader 未导出 stripUrls', !msgSrc.match(/^\s{2}stripUrls,/m))
check('message-reader 未导出 sanitizeDisplayName', !msgSrc.match(/^\s{2}sanitizeDisplayName,/m))

const indexSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')
check('index.js 未引用 BANNED_OUTPUT_RE 本地常量', !indexSrc.includes('const BANNED_OUTPUT_RE'))
check('index.js 未引用 buildFriendlyPersona', !indexSrc.includes('buildFriendlyPersona'))
check('index.js 未引用 东雪莲嘴臭开', !indexSrc.includes('东雪莲嘴臭开'))

// ===== 总结 =====
console.log('\n\x1b[1m=== 总结 ===\x1b[0m')
console.log(`  通过: ${totalPassed}  失败: ${totalFailed}`)
process.exit(totalFailed > 0 ? 1 : 0)
