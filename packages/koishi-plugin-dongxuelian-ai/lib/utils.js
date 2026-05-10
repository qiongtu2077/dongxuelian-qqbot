/**
 * CODE REVIEW CHECKLIST（每次修改必须完成）:
 * 1. 是否引入了新的 require 循环依赖？（绝对禁止 require('./index')）
 * 2. 新增函数是否已在 cascade-test.js 的 expectedExports 注册？
 * 3. Promise 路径是否所有 reject 都有 catch？
 * 4. 修改的 Map/缓存是否有大小限制和过期机制？
 */
const { normalizeText } = require('./message-reader')
const {
  AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ,
  RESERVED_PREFIXES,
  JAILBREAK_INPUT_RE, JAILBREAK_FALLBACK_REPLIES,
  OVERUSED_REPLY_PATTERNS,
  BANNED_ACTION_OUTPUT_RE, EVALUATION_REQUEST_RE,
  RARE_PROVOCATION_RE, WIDE_RARE_PROVOKE_RE, HOSTILE_INPUT_RE, HOSTILE_SINGLE_TOKENS,
  PROVIDERS, MAX_OUTPUT_CHARS_FRIENDLY,
} = require('./constants')
const { isAdminUserId } = require('./runtime-config')

function isRareProvocation(text = '') {
  const value = String(text).trim()
  if (!value) return false
  return RARE_PROVOCATION_RE.test(value)
}

function isWideRareProvocation(text = '') {
  const value = String(text).trim()
  if (!value) return false
  return WIDE_RARE_PROVOKE_RE.test(value)
}

function isHostileInput(text = '') {
  const value = String(text).trim()
  if (!value) return false
  if (HOSTILE_INPUT_RE.test(value)) return true
  if (isRareProvocation(value)) return true
  if (value.length <= 3 && HOSTILE_SINGLE_TOKENS.has(value.toLowerCase())) return true
  return false
}

function isJailbreakAttempt(plain = '') { return JAILBREAK_INPUT_RE.test(plain) }

function pickJailbreakFallbackReply() {
  return JAILBREAK_FALLBACK_REPLIES[Math.floor(Math.random() * JAILBREAK_FALLBACK_REPLIES.length)]
}

function isReservedCommand(plain = '') {
  const value = normalizeText(plain)
  if (!value) return false
  if (value.startsWith('昵称') && value !== '昵称') return true
  if (/^at\s*\S+/i.test(value)) return true
  return RESERVED_PREFIXES.some((prefix) => value === prefix || value.startsWith(prefix + ' '))
}

function getSenderUserId(session) { return String(session.userId || session.author?.id || session.event?.user?.id || '') }

function hasAdminPermission(session) { return isAdminUserId(getSenderUserId(session)) }

function stripMentions(text = '') {
  return String(text)
    .replace(/<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collapseRepeatedBotCalls(text = '') {
  return String(text)
    .replace(/(?:\s*@?(?:东雪莲(?:opus)?|莲莲)\s*){2,}/gi, ' @东雪莲 ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeUserInput(text = '') {
  return String(text)
    .replace(/[\u2800-\u28FF\u3164\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .replace(/\[SYSTEM\]|\[\/SYSTEM\]|\[INST\]|\[\/INST\]|\[SYS\]|\[\/SYS\]|\[ASSISTANT\]|\[\/ASSISTANT\]/gi, '')
    .replace(/<\|(?:system|user|assistant|begin_of_text|end_header_id|end_of_turn|im_start|im_end)\|>/gi, '')
    .replace(/^#{1,6}\s*(?:system|instruction|prompt|override|new role)[:\s]/gim, '')
    .replace(/\n[-=]{4,}\s*\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeUserName(name = '') {
  return String(name)
    .replace(/[【】《》「」\[\]<>{}（）()|～]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) || '用户'
}

function extractAtIds(text = '') {
  const seen = new Set(); const ids = []; const patterns = [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0; let match
    while ((match = pattern.exec(text))) { if (!seen.has(match[1])) { seen.add(match[1]); ids.push(match[1]) } }
  }
  return ids
}

function countAtIdOccurrences(text = '', targetId = '') {
  const botId = String(targetId || ''); if (!botId) return 0; let count = 0
  const patterns = [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]
  for (const pattern of patterns) { pattern.lastIndex = 0; let m; while ((m = pattern.exec(text))) { if (m[1] === botId) count++ } }
  return count
}

function isDirectAtBot(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  if (!botId) return false
  return extractAtIds(session.content || '').includes(botId)
}

function getBotMentionCount(session) { return countAtIdOccurrences(session.content || '', String(session.selfId || session.bot?.selfId || '')) }

function hasOtherMentions(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  const atIds = extractAtIds(session.content || '')
  if (!atIds.length) return false
  return atIds.some((userId) => userId !== botId)
}

function formatPercent(rate = 0) { return `${Number(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%` }

async function readTextFile(file) { try { return (await require('fs/promises').readFile(file, 'utf8')).trim() } catch { return '' } }

async function writeFileAtomic(file, value) {
  const fs = require('fs/promises')
  const path = require('path')
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  await fs.mkdir(dir, { recursive: true })
  try {
    await fs.writeFile(tmp, String(value), 'utf8')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rename(tmp, file)
        return
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error && error.code) || attempt === 7) throw error
        try { await fs.unlink(file) } catch {}
        await new Promise(resolve => setTimeout(resolve, attempt + 1))
      }
    }
  } catch (error) {
    try { await fs.unlink(tmp) } catch {}
    throw error
  }
}

async function writeTextFile(file, value) { await writeFileAtomic(file, String(value)) }

async function readJsonFile(file, fallback) { try { return JSON.parse(await require('fs/promises').readFile(file, 'utf8')) } catch { return fallback } }

async function writeJsonFile(file, value) { await writeFileAtomic(file, JSON.stringify(value, null, 2)) }

async function safeUnlink(file) { try { await require('fs/promises').unlink(file); return true } catch { return false } }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function getRandomDelayMs() { return 1000 + Math.floor(Math.random() * 501) }

function shouldTriggerRandom(rate, randomFn = Math.random) {
  return randomFn() < Number(rate)
}

function parseEnabledText(value = '') { return /^(?:1|true|on|yes|开|开启)$/i.test(String(value).trim()) }

function getBaseHostname(baseURL = '') { try { return new URL(String(baseURL || '')).hostname.toLowerCase() } catch { return '' } }

function isDashScopeConfig(config = {}) { const hostname = getBaseHostname(config.baseURL); return hostname.includes('dashscope') || hostname.endsWith('aliyuncs.com') }

function isOpenAIOfficialConfig(config = {}) { const hostname = getBaseHostname(config.baseURL); return hostname === 'api.openai.com' || hostname.endsWith('.openai.com') }

function normalizeUrl(raw) { if (!raw) return ''; let url = String(raw).replace(/&amp;/g, '&'); if (/^https?:\/\//i.test(url)) return url; if (/^\/\//.test(url)) return 'https:' + url; return '' }

function extractImageUrls(content = '') {
  const urls = []; const cqRegex = /\[CQ:image[^\]]*?url=([^,\]\s]+)[^\]]*\]/gi; let match
  while ((match = cqRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u) urls.push(u) }
  const htmlSrcRegex = /<img[^>]*?src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi; htmlSrcRegex.lastIndex = 0
  while ((match = htmlSrcRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u && !urls.includes(u)) urls.push(u) }
  const attrUrlRegex = /<(?:image|img|file)[^>]*?url\s*=\s*["']([^"']+)["'][^>]*\/?>/gi; attrUrlRegex.lastIndex = 0
  while ((match = attrUrlRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u && !urls.includes(u)) urls.push(u) }
  return [...new Set(urls)]
}

function sanitizeFileToken(value = '') { return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown' }

function safeJsonStringify(value) {
  const visited = new WeakSet()
  return JSON.stringify(value, (key, current) => {
    if (typeof current === 'bigint') return current.toString()
    if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`
    if (current && typeof current === 'object') { if (visited.has(current)) return '[Circular]'; visited.add(current) }
    return current
  }, 2)
}

function normalizeReplyFingerprint(text = '') {
  return String(text).toLowerCase().replace(/\s+/g, '').replace(/[，。！？!?,、：:；;“”"'‘’·`~～\-]/g, '').trim()
}

function longestCommonSubstringLength(a, b, threshold = Infinity) {
  const maxLen = Math.min(a.length, b.length, threshold)
  for (let len = maxLen; len > 0; len--) {
    for (let i = 0; i + len <= a.length; i++) {
      const sub = a.slice(i, i + len)
      if (b.includes(sub)) return len
    }
  }
  return 0
}

function charSetJaccardOverlap(a, b) {
  const setA = new Set(a); const setB = new Set(b); let overlap = 0
  for (const char of setA) { if (setB.has(char)) overlap++ }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : overlap / union
}

function isReplyTooSimilar(left = '', right = '') {
  if (!left || !right) return false
  const nl = normalizeReplyFingerprint(left); const nr = normalizeReplyFingerprint(right)
  if (!nl || !nr) return false
  const lcs = longestCommonSubstringLength(nl, nr, Math.ceil(Math.min(nl.length, nr.length) * 0.85))
  if (lcs >= Math.ceil(Math.min(nl.length, nr.length) * 0.85)) return true
  if (charSetJaccardOverlap(nl, nr) > 0.85) return true
  return false
}

function isOverusedReply(reply = '') {
  if (!reply) return false
  return OVERUSED_REPLY_PATTERNS.some(p => p.test(reply))
}

function hasBannedOutput(text) { return BANNED_ACTION_OUTPUT_RE.test(text) || OVERUSED_REPLY_PATTERNS.some(p => p.test(text)) }

const THINKING_LEAK_RE = /(?:^|[\n。！？!?]\s*)(?:好的[，,]?)?用户.{0,30}发了个消息说[“"].{0,120}[”"].{0,60}(?:这应该是|应该是在|是在回应)|我(?:得|要|来)?(?:先)?看看(?:现在)?是什么情况|我记得.{0,30}(?:性格设定|人设|设定)|这个(?:场景|情况|上下文).{0,30}(?:看起来|应该是)|我应该.{0,40}(?:回应|回复|接话|吐槽)|我得.{0,30}(?:接上|顺着).{0,30}(?:话茬|意思)|可以顺着.{0,30}(?:意思|话茬).{0,30}(?:说|回复)|我现在(?:处于|是).{0,30}(?:模式|人设|角色)|对方没有敌意|正常聊天/

function isThinkingLeak(text = '') {
  const value = normalizeText(text)
  if (!value || value.length < 6) return false
  return THINKING_LEAK_RE.test(value)
}

function isEvaluationRequest(text = '') { return EVALUATION_REQUEST_RE.test(normalizeText(text)) }

function getModelDisplayName(providerId, modelId) {
  const prov = PROVIDERS[providerId]; if (!prov) return modelId
  const found = prov.models.find(m => m.id === modelId || m.name === modelId)
  return found ? found.name : modelId
}

function getSearchCapability(config = {}) {
  const model = String(config.model || '').trim()
  if (isDashScopeConfig(config)) return { supported: true, mode: 'dashscope-chat', label: 'DashScope Chat Completions enable_search' }
  if (isOpenAIOfficialConfig(config)) {
    if (/^(gpt-5-search-api|gpt-4o-search-preview|gpt-4o-mini-search-preview)$/i.test(model)) return { supported: true, mode: 'openai-chat-search', label: 'OpenAI Chat Completions web_search_options' }
    if (/^gpt-4\.1-nano$/i.test(model)) return { supported: false, mode: 'openai-unsupported-model', label: 'OpenAI web_search 不支持 gpt-4.1-nano' }
    return { supported: true, mode: 'openai-responses', label: 'OpenAI Responses API web_search' }
  }
  if (/qwen/i.test(model)) return { supported: true, mode: 'dashscope-chat', label: 'DashScope Chat Completions enable_search (via OpenCode)' }
  return { supported: false, mode: 'unknown', label: '当前 Base URL 未识别为支持的搜索接口' }
}

function formatSearchStatus(config = {}) {
  const c = getSearchCapability(config)
  return `东雪莲联网：${config.searchEnabled ? '开' : '关'}\n当前模型：${getModelDisplayName(config.provider, config.model)}\n接口模式：${c.label}\n搜索能力：${c.supported ? '支持' : '不支持'}`
}

function trimReply(text = '', maxChars = MAX_OUTPUT_CHARS_FRIENDLY) {
  let value = String(text).trim()
  if (value.length <= maxChars) return value
  const parts = splitSentences(value); const result = []
  let total = 0
  for (const part of parts) { if (total + part.length > maxChars) break; result.push(part); total += part.length }
  return result.join('').trim() || value.slice(0, maxChars).trim()
}

function sanitizeReply(text = '', userName = '') {
  let t = String(text).replace(/^(根据|作为|我是|我的角色)\S{0,20}[:：，。\s]?/g, '').trim()
  if (userName) {
    const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp('(?<!的)' + esc + '(?=[，,。！!？?]?\\s*$)'), '')
    t = t.replace(new RegExp('(?<!的)' + esc + '(?![，,、。！!？?]?\\s*你)', 'g'), '你')
  }
  return t || text
}

function calculateWillFactor(channelKey, personaName, channelSharedCache, personaContent) {
  const msgCount = (channelSharedCache.get(channelKey) || []).filter(function(m) { return Date.now() - m.ts < 60000 }).length
  const crowdFactor = msgCount > 20 ? 0.3 : msgCount > 10 ? 0.6 : msgCount > 5 ? 0.9 : msgCount > 2 ? 1.2 : 1.5
  let personaFactor = null
  if (personaContent) {
    const willMatch = personaContent.match(/^will:\s*([\d.]+)$/m)
    if (willMatch) personaFactor = parseFloat(willMatch[1])
  }
  if (personaFactor === null) {
    personaFactor = { '长离': 0.8, '椿': 1.3, '特蕾西娅': 0.9 }[personaName] || 1.0
  }
  return Math.round(Math.min(crowdFactor * personaFactor, 2.0) * 100) / 100
}

function isSemanticProfile(text) {
  const hasRegionHint = /韩国|南韩|朝鲜|北方|隔壁|半岛|三八线|韩美|平壤|首尔|韩朝/.test(text)
  const hasNameHint = /姓金|金家|金氏|朴|崔|将军|元帅|领袖|最高领导人|元首|委员长/.test(text)
  const hasInsult = /狗屎|垃圾|废物|傻逼|狗屁|恶心|粪|屎|反动|独裁|暴政|可笑|荒唐|病态/.test(text)
  return hasRegionHint && hasNameHint && hasInsult
}

function getSegmentData(segment) {
  return segment?.data || segment?.attrs || {}
}

function getSessionMessageSegments(session) {
  const message = session?.event?.message
  if (Array.isArray(message)) return message
  if (Array.isArray(message?.elements)) return message.elements
  if (Array.isArray(session?.event?.message?.content)) return session.event.message.content
  return []
}

function splitSentences(text) {
  const raw = normalizeText(text)
  if (!raw) return [raw]
  const segments = raw.split(/(?<=[。！？!?]+|\.{6,})/)
  const parts = []
  let carry = ''
  let lastSkippedSplit = false
  for (const segment of segments) {
    if (/\.{6,}/.test(segment)) {
      if (carry) { parts.push(carry); carry = '' }
      parts.push(segment)
      lastSkippedSplit = false
      continue
    }
    if (/^[。！？!?\n]+$/.test(segment)) {
      carry += segment
      lastSkippedSplit = true
      continue
    }
    if (/^[，,、：:；;]/.test(segment) && lastSkippedSplit) {
      carry += segment
      lastSkippedSplit = false
      continue
    }
    if (carry) { parts.push(carry); carry = '' }
    carry = segment
    lastSkippedSplit = false
  }
  if (carry) parts.push(carry)
  return parts.filter(Boolean)
}

/** 中国（上海）日历日 YYYY-MM-DD，与 TODAY_CACHE / 群日报对齐 */
const SHANGHAI_TZ = 'Asia/Shanghai'

function todayCst(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const pickYmd = (t) => parts.find((p) => p.type === t)?.value
  return `${pickYmd('year')}-${pickYmd('month')}-${pickYmd('day')}`
}

/** 上海时区 24 小时制 HH:mm:ss，供 today-cache 展示与兼容旧解析 */
function formatShanghaiTime24h(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts))
  const pickHms = (t) => p.find((x) => x.type === t)?.value
  return `${pickHms('hour')}:${pickHms('minute')}:${pickHms('second')}`
}

/** 0–23，供 24 小时分布图 */
function getShanghaiHourFromTs(ts) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts)).find((x) => x.type === 'hour')?.value
  return h !== undefined ? parseInt(h, 10) : NaN
}

/** 上海日历上 todayYmd 往前 n 天（字符串 YYYY-MM-DD），用于情绪历史截断 */
function todayCstMinusDays(daysBack) {
  const ymd = todayCst()
  const d = new Date(`${ymd}T12:00:00+08:00`)
  d.setDate(d.getDate() - daysBack)
  return todayCst(d)
}

module.exports = {
  isRareProvocation, isWideRareProvocation, isHostileInput,
  isJailbreakAttempt, pickJailbreakFallbackReply,
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserInput, sanitizeUserName,
  extractAtIds, countAtIdOccurrences,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  formatPercent,
  readTextFile, writeTextFile, readJsonFile, writeJsonFile,
  safeUnlink,
  sleep, getRandomDelayMs, shouldTriggerRandom,
  parseEnabledText,
  getBaseHostname, isDashScopeConfig, isOpenAIOfficialConfig,
  normalizeUrl, extractImageUrls,
  sanitizeFileToken, safeJsonStringify,
  normalizeReplyFingerprint,
  longestCommonSubstringLength, charSetJaccardOverlap,
  isReplyTooSimilar, isOverusedReply, hasBannedOutput,
  isThinkingLeak, isEvaluationRequest,
  calculateWillFactor, isSemanticProfile,
  getSegmentData, getSessionMessageSegments,
  getModelDisplayName, getSearchCapability, formatSearchStatus,
  trimReply, sanitizeReply, splitSentences,
  todayCst, formatShanghaiTime24h, getShanghaiHourFromTs, todayCstMinusDays,
}
