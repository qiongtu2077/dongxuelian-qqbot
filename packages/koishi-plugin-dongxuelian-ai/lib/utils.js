const { normalizeText } = require('./message-reader')
const {
  AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ,
  RESERVED_PREFIXES,
  RARE_PROVOCATION_RE, HOSTILE_INPUT_RE, HOSTILE_SINGLE_TOKENS,
  JAILBREAK_INPUT_RE,
  JAILBREAK_FALLBACK_REPLIES,
  ADMIN_USER_IDS,
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

function isJailbreakAttempt(plain = '') {
  return JAILBREAK_INPUT_RE.test(plain)
}

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

function getSenderUserId(session) {
  return String(session.userId || session.author?.id || session.event?.user?.id || '')
}

function hasAdminPermission(session) {
  return ADMIN_USER_IDS.has(getSenderUserId(session))
}

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
    .replace(/^\[.*?\]\s*/g, '')
    .replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '')
    .trim()
    .slice(0, 20)
}

function extractAtIds(text = '') {
  const ids = new Set()
  const xmlPattern = AT_ID_PATTERN_XML
  xmlPattern.lastIndex = 0
  let match
  while ((match = xmlPattern.exec(text)) !== null) ids.add(match[1])
  const cqPattern = AT_ID_PATTERN_CQ
  cqPattern.lastIndex = 0
  while ((match = cqPattern.exec(text)) !== null) ids.add(match[1])
  return [...ids]
}

function countAtIdOccurrences(text = '', targetId = '') {
  const source = String(text)
  const botId = String(targetId || '')
  if (!botId) return 0
  let count = 0
  const patterns = [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(source)) !== null) {
      if (m[1] === botId) count++
    }
  }
  return count
}

function isDirectAtBot(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  if (!botId) return false
  return extractAtIds(session.content || '').includes(botId)
}

function getBotMentionCount(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  return countAtIdOccurrences(session.content || '', botId)
}

function hasOtherMentions(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  const atIds = extractAtIds(session.content || '')
  if (!atIds.length) return false
  return atIds.some((userId) => userId !== botId)
}

function getBaseHostname(baseURL = '') {
  try { return new URL(baseURL).hostname } catch { return '' }
}

function isDashScopeConfig(config = {}) {
  const base = (config.baseURL || '').toLowerCase()
  return base.includes('dashscope') || config.provider === 'dashscope'
}

function isOpenAIOfficialConfig(config = {}) {
  const base = (config.baseURL || '').toLowerCase()
  return base.includes('api.openai.com') || base.includes('api.deepseek.com')
}

function normalizeUrl(raw) {
  if (!raw) return ''
  const str = String(raw).replace(/&amp;/g, '&')
  if (/^https?:\/\//i.test(str)) return str
  if (/^\/\//.test(str)) return 'https:' + str
  return ''
}

function extractImageUrls(content = '') {
  const urls = []
  const cqRegex = /\[CQ:image[^\]]*?url=([^,\]\s]+)[^\]]*\]/gi
  let match
  while ((match = cqRegex.exec(content)) !== null) {
    const u = normalizeUrl(match[1])
    if (u) urls.push(u)
  }
  const attrUrlRegex = /<(?:image|img|file)[^>]*?url\s*=\s*["']([^"']+)["'][^>]*\/?>/gi
  attrUrlRegex.lastIndex = 0
  while ((match = attrUrlRegex.exec(content)) !== null) {
    const u = normalizeUrl(match[1])
    if (u && !urls.includes(u)) urls.push(u)
  }
  return urls
}

function parseEnabledText(value = '') {
  return /^(?:1|true|on|yes|开|开启)$/i.test(String(value).trim())
}

function sanitizeFileToken(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown'
}

function safeJsonStringify(value) {
  try { return JSON.stringify(value) } catch { return '{}' }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRandomDelayMs() {
  return 200 + Math.random() * 800
}

module.exports = {
  isRareProvocation, isHostileInput,
  isJailbreakAttempt, pickJailbreakFallbackReply,
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserInput, sanitizeUserName,
  extractAtIds, countAtIdOccurrences,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  getBaseHostname, isDashScopeConfig, isOpenAIOfficialConfig,
  normalizeUrl, extractImageUrls,
  parseEnabledText, sanitizeFileToken, safeJsonStringify,
  sleep, getRandomDelayMs,
}
