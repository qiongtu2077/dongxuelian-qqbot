const { normalizeText } = require('./message-reader')
const {
  AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ,
  RESERVED_PREFIXES, ADMIN_USER_IDS,
  JAILBREAK_INPUT_RE, JAILBREAK_FALLBACK_REPLIES,
  OVERUSED_REPLY_PATTERNS,
  BANNED_ACTION_OUTPUT_RE, EVALUATION_REQUEST_RE,
  RARE_PROVOCATION_RE, HOSTILE_INPUT_RE, HOSTILE_SINGLE_TOKENS,
  PROVIDERS, MAX_OUTPUT_CHARS_FRIENDLY,
} = require('./constants')

function isRareProvocation(text = '') {
  const value = String(text).trim()
  if (!value) return false
  return RARE_PROVOCATION_RE.test(value)
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

function hasAdminPermission(session) { return ADMIN_USER_IDS.has(getSenderUserId(session)) }

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

async function writeTextFile(file, value) { const fs = require('fs/promises'); await fs.mkdir(require('path').dirname(file), { recursive: true }); await fs.writeFile(file, String(value), 'utf8') }

async function readJsonFile(file, fallback) { try { return JSON.parse(await require('fs/promises').readFile(file, 'utf8')) } catch { return fallback } }

async function writeJsonFile(file, value) { const fs = require('fs/promises'); await fs.mkdir(require('path').dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8') }

async function safeUnlink(file) { try { await require('fs/promises').unlink(file); return true } catch { return false } }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function getRandomDelayMs() { return 1000 + Math.floor(Math.random() * 501) }

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
  if (userName) t = t.replace(new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '你')
  return t || text
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

module.exports = {
  isRareProvocation, isHostileInput,
  isJailbreakAttempt, pickJailbreakFallbackReply,
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserInput, sanitizeUserName,
  extractAtIds, countAtIdOccurrences,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  formatPercent,
  readTextFile, writeTextFile, readJsonFile, writeJsonFile,
  safeUnlink,
  sleep, getRandomDelayMs,
  parseEnabledText,
  getBaseHostname, isDashScopeConfig, isOpenAIOfficialConfig,
  normalizeUrl, extractImageUrls,
  sanitizeFileToken, safeJsonStringify,
  normalizeReplyFingerprint,
  longestCommonSubstringLength, charSetJaccardOverlap,
  isReplyTooSimilar, isOverusedReply, hasBannedOutput,
  isEvaluationRequest,
  getModelDisplayName, getSearchCapability, formatSearchStatus,
  trimReply, sanitizeReply, splitSentences,
}
