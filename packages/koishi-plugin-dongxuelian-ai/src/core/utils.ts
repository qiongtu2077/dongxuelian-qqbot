/**
 * CODE REVIEW CHECKLIST（每次修改必须完成）:
 * 1. 是否引入了新的 require 循环依赖？（绝对禁止 require('./index')）
 * 2. 新增函数是否已在 cascade-test.js 的 expectedExports 注册？
 * 3. Promise 路径是否所有 reject 都有 catch？
 * 4. 修改的 Map/缓存是否有大小限制和过期机制？
 */
const {
  AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ,
  RESERVED_PREFIXES,
  JAILBREAK_INPUT_RE, JAILBREAK_FALLBACK_REPLIES,
  OVERUSED_REPLY_PATTERNS,
  BANNED_ACTION_OUTPUT_RE, EVALUATION_REQUEST_RE,
  RARE_PROVOCATION_RE, WIDE_RARE_PROVOKE_RE, HOSTILE_INPUT_RE, HOSTILE_SINGLE_TOKENS,
  PROVIDERS, MAX_OUTPUT_CHARS_FRIENDLY,
} = require('./constants') as typeof import('./constants')
const { isAdminUserId } = require('./runtime-config') as typeof import('./runtime-config')
const dns = require('dns')
const net = require('net')
const MAX_TEXT_FILE_BYTES = parseUtilsPositiveInt(process.env.DONGXUELIAN_UTIL_TEXT_MAX_BYTES, 256 * 1024, 4 * 1024, 4 * 1024 * 1024)
const MAX_JSON_FILE_BYTES = parseUtilsPositiveInt(process.env.DONGXUELIAN_UTIL_JSON_MAX_BYTES, 512 * 1024, 4 * 1024, 8 * 1024 * 1024)

interface BasicSession {
  userId?: string
  selfId?: string
  content?: string
  author?: { id?: string }
  event?: {
    user?: { id?: string }
    message?: unknown[] | { elements?: unknown[]; content?: unknown[] }
  }
  bot?: { selfId?: string }
}

interface MessageContainer {
  elements?: unknown[]
  content?: unknown[]
}

interface ReadFileOptions {
  maxBytes?: number | string
}

interface SearchConfig {
  provider?: string
  model?: string
  baseURL?: string
  searchEnabled?: boolean
}

interface ChannelMessageEntry {
  ts: number
}

interface SegmentLike {
  data?: unknown
  attrs?: unknown
}

interface SplitReplyOptions {
  softChars?: number
  maxParts?: number
}

interface DnsAddress {
  address: string
  family: number
}

function parseUtilsPositiveInt(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

// 统一压缩消息里的多余空白，避免后续匹配被格式噪音影响。
function normalizeText(text: unknown = ''): string {
  return String(text).replace(/\s+/g, ' ').trim()
}

function isRareProvocation(text: string = ''): boolean {
  const value = String(text).trim()
  if (!value) return false
  return RARE_PROVOCATION_RE.test(value)
}

function isWideRareProvocation(text: string = ''): boolean {
  const value = String(text).trim()
  if (!value) return false
  return WIDE_RARE_PROVOKE_RE.test(value)
}

function isHostileInput(text: string = ''): boolean {
  const value = String(text).trim()
  if (!value) return false
  if (HOSTILE_INPUT_RE.test(value)) return true
  if (isRareProvocation(value)) return true
  if (value.length <= 3 && HOSTILE_SINGLE_TOKENS.has(value.toLowerCase())) return true
  return false
}

function isJailbreakAttempt(plain: string = ''): boolean { return JAILBREAK_INPUT_RE.test(plain) }

function pickJailbreakFallbackReply(): string {
  return JAILBREAK_FALLBACK_REPLIES[Math.floor(Math.random() * JAILBREAK_FALLBACK_REPLIES.length)]
}

function isReservedCommand(plain: string = ''): boolean {
  const value = normalizeText(plain)
  if (!value) return false
  if (value.startsWith('昵称') && value !== '昵称') return true
  if (/^at\s*\S+/i.test(value)) return true
  return RESERVED_PREFIXES.some((prefix) => value === prefix || value.startsWith(prefix + ' '))
}

function getSenderUserId(session: BasicSession): string { return String(session.userId || session.author?.id || session.event?.user?.id || '') }

function hasAdminPermission(session: BasicSession): boolean { return isAdminUserId(getSenderUserId(session)) }

function stripMentions(text: string = ''): string {
  return String(text)
    .replace(/<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collapseRepeatedBotCalls(text: string = ''): string {
  return String(text)
    .replace(/(?:\s*@?(?:东雪莲(?:opus)?|莲莲)\s*){2,}/gi, ' @东雪莲 ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeUserInput(text: string = ''): string {
  return String(text)
    .replace(/[\u2800-\u28FF\u3164\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .replace(/\[SYSTEM\]|\[\/SYSTEM\]|\[INST\]|\[\/INST\]|\[SYS\]|\[\/SYS\]|\[ASSISTANT\]|\[\/ASSISTANT\]/gi, '')
    .replace(/<\|(?:system|user|assistant|begin_of_text|end_header_id|end_of_turn|im_start|im_end)\|>/gi, '')
    .replace(/^#{1,6}\s*(?:system|instruction|prompt|override|new role)[:\s]/gim, '')
    .replace(/\n[-=]{4,}\s*\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeUserName(name: string = ''): string {
  return String(name)
    .replace(/[【】《》「」\[\]<>{}（）()|～]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) || '用户'
}

function extractAtIds(text: string = ''): string[] {
  const seen = new Set<string>(); const ids: string[] = []; const patterns = [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0; let match
    while ((match = pattern.exec(text))) { if (!seen.has(match[1])) { seen.add(match[1]); ids.push(match[1]) } }
  }
  return ids
}

function countAtIdOccurrences(text: string = '', targetId: string = ''): number {
  const botId = String(targetId || ''); if (!botId) return 0; let count = 0
  const patterns = [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]
  for (const pattern of patterns) { pattern.lastIndex = 0; let m; while ((m = pattern.exec(text))) { if (m[1] === botId) count++ } }
  return count
}

function isDirectAtBot(session: BasicSession): boolean {
  const botId = String(session.selfId || session.bot?.selfId || '')
  if (!botId) return false
  return extractAtIds(session.content || '').includes(botId)
}

function getBotMentionCount(session: BasicSession): number { return countAtIdOccurrences(session.content || '', String(session.selfId || session.bot?.selfId || '')) }

function hasOtherMentions(session: BasicSession): boolean {
  const botId = String(session.selfId || session.bot?.selfId || '')
  const atIds = extractAtIds(session.content || '')
  if (!atIds.length) return false
  return atIds.some((userId) => userId !== botId)
}

function formatPercent(rate: number = 0): string { return `${Number(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%` }

async function readTextFile(file: string, options: ReadFileOptions = {}): Promise<string> {
  try {
    const fs = require('fs/promises')
    const maxBytes = Math.max(1, parseInt(String(options.maxBytes), 10) || MAX_TEXT_FILE_BYTES)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > maxBytes) return ''
    return (await fs.readFile(file, 'utf8')).trim()
  } catch { /* non-critical: optional text file read falls back to empty content */ return '' }
}

async function writeFileAtomic(file: string, value: unknown): Promise<void> {
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
        if (!['EEXIST', 'EPERM'].includes(errorCode(error)) || attempt === 7) throw error
        try { await fs.unlink(file) } catch { /* non-critical: best-effort overwrite cleanup before async rename retry */ }
        await new Promise(resolve => setTimeout(resolve, attempt + 1))
      }
    }
  } catch (error) {
    try { await fs.unlink(tmp) } catch { /* non-critical: best-effort temp cleanup after async write failure */ }
    throw error
  }
}

async function writeTextFile(file: string, value: unknown): Promise<void> { await writeFileAtomic(file, String(value)) }

function writeFileAtomicSync(file: string, value: unknown): void {
  const fs = require('fs')
  const path = require('path')
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(tmp, String(value), 'utf8')
    try {
      fs.renameSync(tmp, file)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(errorCode(error))) throw error
      try { fs.unlinkSync(file) } catch { /* non-critical: best-effort overwrite cleanup before sync rename retry */ }
      fs.renameSync(tmp, file)
    }
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* non-critical: best-effort temp cleanup after sync write failure */ }
    throw error
  }
}

async function readJsonFile<T>(file: string, fallback: T, options: ReadFileOptions = {}): Promise<T> {
  try {
    const fs = require('fs/promises')
    const maxBytes = Math.max(1, parseInt(String(options.maxBytes), 10) || MAX_JSON_FILE_BYTES)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > maxBytes) return fallback
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch { /* non-critical: optional JSON file read falls back to caller default */ return fallback }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> { await writeFileAtomic(file, JSON.stringify(value, null, 2)) }

function readJsonFileSync<T>(file: string, fallback: T, options: ReadFileOptions = {}): T {
  try {
    const fs = require('fs')
    const maxBytes = Math.max(1, parseInt(String(options.maxBytes), 10) || MAX_JSON_FILE_BYTES)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* non-critical: optional sync JSON file read falls back to caller default */ return fallback }
}

function writeJsonFileSync(file: string, value: unknown): void { writeFileAtomicSync(file, JSON.stringify(value, null, 2)) }

async function safeUnlink(file: string): Promise<boolean> { try { await require('fs/promises').unlink(file); return true } catch { /* non-critical: safe unlink reports false when target is missing or locked */ return false } }

async function getFileFingerprint(filePath: string): Promise<string> {
  try {
    const fs = require('fs/promises')
    const stat = await fs.stat(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch { /* non-critical: missing optional settings file is represented by a stable fingerprint */
    return 'missing'
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function getRandomDelayMs(): number { return 1000 + Math.floor(Math.random() * 501) }

function shouldTriggerRandom(rate: number, randomFn: () => number = Math.random): boolean {
  return randomFn() < Number(rate)
}

function parseEnabledText(value: string = ''): boolean { return /^(?:1|true|on|yes|开|开启)$/i.test(String(value).trim()) }

function getBaseHostname(baseURL: string = ''): string { try { return new URL(String(baseURL || '')).hostname.toLowerCase() } catch { /* non-critical: malformed base URL means unknown hostname */ return '' } }

function isDashScopeConfig(config: SearchConfig = {}): boolean { const hostname = getBaseHostname(config.baseURL); return hostname.includes('dashscope') || hostname.endsWith('aliyuncs.com') }

function isOpenAIOfficialConfig(config: SearchConfig = {}): boolean { const hostname = getBaseHostname(config.baseURL); return hostname === 'api.openai.com' || hostname.endsWith('.openai.com') }

function normalizeUrl(raw: string): string { if (!raw) return ''; let url = String(raw).replace(/&amp;/g, '&'); if (/^https?:\/\//i.test(url)) return url; if (/^\/\//.test(url)) return 'https:' + url; return '' }

function normalizeHostname(hostname: unknown = ''): string {
  return String(hostname || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isPrivateHostname(hostname: unknown = ''): boolean {
  const host = normalizeHostname(hostname)
  return !host || host === 'localhost' || host.endsWith('.localhost')
}

function isPrivateIp(ip: unknown = ''): boolean {
  const value = String(ip || '').trim()
  const family = net.isIP(value)
  if (!family) return false
  if (family === 4) {
    const parts = value.split('.').map(part => parseInt(part, 10))
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return true
    const [a, b] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  const lower = value.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true
  const mapped = lower.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateIp(mapped[1])
  return false
}

function validatePublicHttpUrl(rawUrl: unknown): URL {
  let parsed: URL
  try {
    parsed = new URL(String(rawUrl || '').trim())
  } catch {
    throw new Error('URL 格式无效')
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只允许读取 http/https URL')
  if (parsed.username || parsed.password) throw new Error('拒绝包含用户名或密码的 URL')
  const hostname = normalizeHostname(parsed.hostname)
  if (isPrivateHostname(hostname)) throw new Error('拒绝访问本机、内网或保留地址')
  if (net.isIP(hostname) && isPrivateIp(hostname)) throw new Error('拒绝访问本机、内网或保留地址')
  parsed.hash = ''
  return parsed
}

function lookupHostname(hostname: string): Promise<DnsAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (error: Error | null, addresses: DnsAddress[]) => {
      if (error) return reject(error)
      resolve(Array.isArray(addresses) ? addresses : [])
    })
  })
}

async function resolveAndValidateHostname(url: string | URL): Promise<DnsAddress[]> {
  const parsed = typeof url === 'string' ? validatePublicHttpUrl(url) : validatePublicHttpUrl(url.toString())
  const hostname = normalizeHostname(parsed.hostname)
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }]
  const addresses = await lookupHostname(hostname)
  if (!addresses.length) throw new Error('DNS 未返回可用地址')
  for (const item of addresses) {
    if (!item || !item.address || isPrivateIp(item.address)) {
      throw new Error('拒绝访问 DNS 指向的本机、内网或保留地址')
    }
  }
  return addresses
}

function extractImageUrls(content: string = ''): string[] {
  const urls: string[] = []; const cqRegex = /\[CQ:image[^\]]*?url=([^,\]\s]+)[^\]]*\]/gi; let match
  while ((match = cqRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u) urls.push(u) }
  const htmlSrcRegex = /<img[^>]*?src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi; htmlSrcRegex.lastIndex = 0
  while ((match = htmlSrcRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u && !urls.includes(u)) urls.push(u) }
  const attrUrlRegex = /<(?:image|img|file)[^>]*?url\s*=\s*["']([^"']+)["'][^>]*\/?>/gi; attrUrlRegex.lastIndex = 0
  while ((match = attrUrlRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u && !urls.includes(u)) urls.push(u) }
  return [...new Set(urls)]
}

function extractVoiceUrls(content: string = ''): string[] {
  const urls: string[] = []; let match
  const cqRegex = /\[CQ:record[^\]]*?url=([^,\]\s]+)[^\]]*\]/gi
  while ((match = cqRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u) urls.push(u) }
  const attrRegex = /<record[^>]*?url\s*=\s*["']([^"']+)["'][^>]*\/?>/gi
  while ((match = attrRegex.exec(content)) !== null) { const u = normalizeUrl(match[1]); if (u && !urls.includes(u)) urls.push(u) }
  return [...new Set(urls)]
}

function sanitizeFileToken(value: string = ''): string { return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown' }

function safeChannelKey(value: string = ''): string {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
}

function safeUserId(value: string = ''): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'unknown'
}

function legacySafeUserId(value: string = ''): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 100) || 'unknown'
}

function truncateTextValue(value: string, maxLen: number): string {
  const text = String(value || '')
  const limit = Math.max(0, Math.floor(Number(maxLen) || 0))
  return limit > 0 ? text.slice(0, limit) : ''
}

function safeJsonStringify(value: unknown): string {
  const visited = new WeakSet()
  return JSON.stringify(value, (key, current) => {
    if (typeof current === 'bigint') return current.toString()
    if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`
    if (current && typeof current === 'object') { if (visited.has(current)) return '[Circular]'; visited.add(current) }
    return current
  }, 2)
}

function normalizeReplyFingerprint(text: string = ''): string {
  return String(text).toLowerCase().replace(/\s+/g, '').replace(/[，。！？!?,、：:；;“”"'‘’·`~～\-]/g, '').trim()
}

function longestCommonSubstringLength(a: string, b: string, threshold: number = Infinity): number {
  const maxLen = Math.min(a.length, b.length, threshold)
  for (let len = maxLen; len > 0; len--) {
    for (let i = 0; i + len <= a.length; i++) {
      const sub = a.slice(i, i + len)
      if (b.includes(sub)) return len
    }
  }
  return 0
}

function charSetJaccardOverlap(a: string, b: string): number {
  const setA = new Set(a); const setB = new Set(b); let overlap = 0
  for (const char of setA) { if (setB.has(char)) overlap++ }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : overlap / union
}

function isReplyTooSimilar(left: string = '', right: string = ''): boolean {
  if (!left || !right) return false
  const nl = normalizeReplyFingerprint(left); const nr = normalizeReplyFingerprint(right)
  if (!nl || !nr) return false
  const lcs = longestCommonSubstringLength(nl, nr, Math.ceil(Math.min(nl.length, nr.length) * 0.85))
  if (lcs >= Math.ceil(Math.min(nl.length, nr.length) * 0.85)) return true
  if (charSetJaccardOverlap(nl, nr) > 0.85) return true
  return false
}

function isOverusedReply(reply: string = ''): boolean {
  if (!reply) return false
  return OVERUSED_REPLY_PATTERNS.some(p => p.test(reply))
}

function hasBannedOutput(text: string): boolean { return BANNED_ACTION_OUTPUT_RE.test(text) || OVERUSED_REPLY_PATTERNS.some(p => p.test(text)) }

const THINKING_LEAK_INPUT_MAX_CHARS = 4000
const TOOL_PLAN_NAME_RE = '(?:web_fetch|web_search|read_image_history|analyze_historical_image|analyze_file|read_group_context|create_reminder|list_reminders|cancel_reminder|create_uploaded_file_variant)'
const THINKING_LEAK_PATTERNS = [
  /(?:^|[\n。！？!?]\s*)(?:好的[，,]?)?用户.{0,30}发了个消息说[“"].{0,120}[”"].{0,60}(?:这应该是|应该是在|是在回应)/,
  /我(?:得|要|来)?(?:先)?看看(?:现在)?是什么情况/,
  /我记得.{0,30}(?:性格设定|人设|设定)/,
  /这个(?:场景|情况|上下文).{0,30}(?:看起来|应该是)/,
  /我应该.{0,40}(?:回应|回复|接话|吐槽)/,
  /我(?:需要|得|要|应该).{0,60}(?:解释|确认|安抚|承认|提供|给出|保持|避免|调用|读取)/,
  /我(?:会|将|要|需要|尝试|可以先|来).{0,20}(?:调用|使用|执行)\s*[a-zA-Z_][\w.:-]*\s*(?:函数|工具)?/,
  new RegExp(TOOL_PLAN_NAME_RE + '\\s*(?:函数|工具|来|获取|查看|分析|检查|读取|执行|调用)', 'i'),
  new RegExp('(?:调用|使用|执行).{0,20}' + TOOL_PLAN_NAME_RE + '(?:函数|工具)?', 'i'),
  new RegExp('(?:^|[\\n\\r])\\s*' + TOOL_PLAN_NAME_RE + '\\b\\s*(?:url|query|messageId|keyword|limit|参数|args|arguments|\\{|:)', 'i'),
  new RegExp('(?:^|[\\n\\r])\\s*(?:tool|function|函数|工具)\\s*[:：]\\s*' + TOOL_PLAN_NAME_RE + '\\b', 'i'),
  /用户问的是.{0,120}(?:文件内容|历史记录|相关文件|图片内容|链接内容|工具|调用|检查)/,
  /历史记录中没有.{0,120}(?:文件|图片|链接|相关记录|相关信息)/,
  /如果找不到.{0,80}(?:说明|就说明|回复|告诉用户)/,
  /之后我会.{0,80}(?:根据结果|给出回复|回答)/,
  /用户(?:现在)?(?:是在|在|刚刚|可能|应该|想|需要|质疑).{0,80}(?:引用|重复|测试|问|说|让我|评价|质疑|遇到|觉得)/,
  /(?:保持|使用|用).{0,20}(?:人设|人格|口吻|语气|风格)/,
  /(?:避免使用|不要使用).{0,20}(?:专业术语|markdown|代码块|工具|搜索过程)/,
  /(?:首先|然后|接着|最后)[，,].{0,80}(?:我|应该|需要|可以)/,
  /(?:这可能是|他们可能|用户可能).{0,80}(?:测试|遇到|觉得|没有|想要)/,
  /我得.{0,30}(?:接上|顺着).{0,30}(?:话茬|意思)/,
  /可以顺着.{0,30}(?:意思|话茬).{0,30}(?:说|回复)/,
  /我现在(?:处于|是).{0,30}(?:模式|人设|角色)/,
  /对方没有敌意/,
  /正常聊天/,
  /（[^）]{0,80}?(?:收到.{0,40}新消息|这是什么意思|只有昵称|用户[发说]了|从上下文看|这应该是在|是在回应|是不是在).{0,60}）/,
]

function isThinkingLeak(text: string = ''): boolean {
  const value = normalizeText(text).slice(0, THINKING_LEAK_INPUT_MAX_CHARS)
  if (!value || value.length < 6) return false
  return THINKING_LEAK_PATTERNS.some(pattern => pattern.test(value))
}

function isEvaluationRequest(text: string = ''): boolean { return EVALUATION_REQUEST_RE.test(normalizeText(text)) }

function getModelDisplayName(providerId: string, modelId: string): string {
  const prov = PROVIDERS[providerId]; if (!prov) return modelId
  const found = prov.models.find(m => m.id === modelId || m.name === modelId)
  return found ? found.name : modelId
}

function getSearchCapability(config: SearchConfig = {}): { supported: boolean; mode: string; label: string } {
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

function formatSearchStatus(config: SearchConfig = {}): string {
  const c = getSearchCapability(config)
  return `东雪莲联网：${config.searchEnabled ? '开' : '关'}\n当前模型：${getModelDisplayName(config.provider, config.model)}\n接口模式：${c.label}\n搜索能力：${c.supported ? '支持' : '不支持'}`
}

function trimReply(text: string = '', maxChars: number = MAX_OUTPUT_CHARS_FRIENDLY): string {
  let value = String(text).trim()
  if (value.length <= maxChars) return value
  const parts = splitSentences(value); const result = []
  let total = 0
  for (const part of parts) { if (total + part.length > maxChars) break; result.push(part); total += part.length }
  return result.join('').trim() || value.slice(0, maxChars).trim()
}

function sanitizeReply(text: string = '', userName: string = ''): string {
  let t = String(text).replace(/^(根据|作为|我是|我的角色)\S{0,20}[:：，。\s]?/g, '').trim()
  t = t.replace(/https?:\/\/multimedia\.nt\.qq\.com\.cn\/[^\s）)》\]]*\s*/g, '').trim()
  t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
  t = t.replace(/<tool_call>\s*<function=[^>]*>[\s\S]*?<\/function>\s*<\/tool_call>/gi, '').trim()
  t = t.replace(/<tool_call>[^<]*<function=[^<]*<\/function>[^<]*<\/tool_call>/gi, '').trim()
  if (!t) t = String(text).replace(/<tool_call>[\s\S]*$/gi, '').trim()
  if (userName) {
    const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp('(?<!的)' + esc + '(?=[，,。！!？?]?\\s*$)'), '')
    t = t.replace(new RegExp('(?<!的)' + esc + '(?![，,、。！!？?]?\\s*你)', 'g'), '你')
  }
  return t || text
}

function calculateWillFactor(channelKey: string, personaName: string, channelSharedCache: Map<string, ChannelMessageEntry[]>, personaContent?: string): number {
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

function isSemanticProfile(text: string): boolean {
  const hasRegionHint = /韩国|南韩|朝鲜|北方|隔壁|半岛|三八线|韩美|平壤|首尔|韩朝/.test(text)
  const hasNameHint = /姓金|金家|金氏|朴|崔|将军|元帅|领袖|最高领导人|元首|委员长/.test(text)
  const hasInsult = /狗屎|垃圾|废物|傻逼|狗屁|恶心|粪|屎|反动|独裁|暴政|可笑|荒唐|病态/.test(text)
  return hasRegionHint && hasNameHint && hasInsult
}

function getSegmentData(segment: SegmentLike | null | undefined): unknown {
  return segment?.data || segment?.attrs || {}
}

function getSessionMessageSegments(session: BasicSession): unknown[] {
  const message = session?.event?.message
  if (Array.isArray(message)) return message
  const container = message as MessageContainer | undefined
  if (Array.isArray(container?.elements)) return container.elements
  if (Array.isArray(container?.content)) return container.content
  return []
}

function stripMarkdownForQQ(text: string): string {
  let t = String(text)
  t = t.replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, '$1')
  t = t.replace(/^```[a-zA-Z0-9_-]*\s*/g, '')
  t = t.replace(/```/g, '')
  t = t.replace(/^#{1,6}\s+/gm, '')
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/`([^`]+)`/g, '$1')
  t = t.replace(/^[-*+]\s+/gm, '')
  t = t.replace(/^\d+\.\s+/gm, '')
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

function splitSentences(text: string): string[] {
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

const QQ_BUBBLE_SOFT_CHARS = 190
const QQ_BUBBLE_HARD_CHARS = 420
const QQ_BUBBLE_HARD_MAX_PARTS = 5
const QQ_BUBBLE_FALLBACK_SENTENCES = 2

function pushWrappedBubble(parts: string[], text: string, softChars: number = QQ_BUBBLE_SOFT_CHARS): void {
  const value = String(text || '').trim()
  if (!value) return
  if (value.length <= QQ_BUBBLE_HARD_CHARS) {
    parts.push(value)
    return
  }
  let current = ''
  for (const sentence of splitSentences(value)) {
    const piece = sentence.trim()
    if (!piece) continue
    if (!current) {
      current = piece
    } else if (current.length + piece.length <= softChars) {
      current += piece
    } else {
      parts.push(current.trim())
      current = piece
    }
    while (current.length > QQ_BUBBLE_HARD_CHARS) {
      parts.push(current.slice(0, QQ_BUBBLE_HARD_CHARS).trim())
      current = current.slice(QQ_BUBBLE_HARD_CHARS).trim()
    }
  }
  if (current) parts.push(current.trim())
}

function pushSentenceGroupedBubbles(parts: string[], text: string, groupSize: number = QQ_BUBBLE_FALLBACK_SENTENCES): void {
  const value = String(text || '').trim()
  if (!value) return
  const sentences = splitSentences(value).map(part => part.trim()).filter(Boolean)
  if (sentences.length <= Math.max(1, groupSize) && value.length <= QQ_BUBBLE_HARD_CHARS) {
    parts.push(value)
    return
  }

  let current = ''
  let sentenceCount = 0
  const flush = () => {
    if (!current.trim()) return
    parts.push(current.trim())
    current = ''
    sentenceCount = 0
  }

  for (const sentence of sentences.length ? sentences : [value]) {
    const piece = sentence.trim()
    if (!piece) continue
    if (!current) {
      current = piece
      sentenceCount = 1
    } else if (sentenceCount < groupSize && current.length + piece.length <= QQ_BUBBLE_HARD_CHARS) {
      current += piece
      sentenceCount += 1
    } else {
      flush()
      current = piece
      sentenceCount = 1
    }
    while (current.length > QQ_BUBBLE_HARD_CHARS) {
      parts.push(current.slice(0, QQ_BUBBLE_HARD_CHARS).trim())
      current = current.slice(QQ_BUBBLE_HARD_CHARS).trim()
      sentenceCount = current ? 1 : 0
    }
  }
  flush()
}

function mergeQQBubbles(parts: string[], targetMax: number = QQ_BUBBLE_HARD_MAX_PARTS): string[] {
  const clean = parts.map(part => String(part || '').trim()).filter(Boolean)
  if (clean.length <= targetMax) return clean
  const merged = []
  let current = ''
  for (const part of clean) {
    const next = current ? `${current}\n${part}` : part
    if (current && next.length > QQ_BUBBLE_HARD_CHARS) {
      merged.push(current)
      current = part
    } else {
      current = next
    }
  }
  if (current) merged.push(current)
  if (merged.length <= QQ_BUBBLE_HARD_MAX_PARTS) return merged
  return rebalanceQQBubbles(clean, QQ_BUBBLE_HARD_MAX_PARTS)
}

function rebalanceQQBubbles(parts: string[], maxParts: number): string[] {
  const total = parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1)
  const targetChars = Math.max(QQ_BUBBLE_HARD_CHARS, Math.ceil(total / Math.max(1, maxParts)))
  const result = []
  let current = ''
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    const next = current ? `${current}\n${part}` : part
    const groupsLeft = maxParts - result.length
    if (current && next.length > targetChars && groupsLeft > 1) {
      result.push(current)
      current = part
    } else {
      current = next
    }
  }
  if (current) result.push(current)
  return result
}

function splitReplyForQQBubbles(text: string, options: SplitReplyOptions = {}): string[] {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return []
  const softChars = Number(options.softChars) > 0 ? Number(options.softChars) : QQ_BUBBLE_SOFT_CHARS
  const targetMax = Number(options.maxParts) > 0 ? Number(options.maxParts) : QQ_BUBBLE_HARD_MAX_PARTS
  const paragraphs = raw
    .split(/\n+/)
    .map(part => part.replace(/[ \t]*\n[ \t]*/g, '\n').trim())
    .filter(Boolean)
  const natural = paragraphs.length ? paragraphs : [raw]
  const parts = []
  if (natural.length > 1) {
    for (const paragraph of natural) {
      if (paragraph.length > QQ_BUBBLE_HARD_CHARS) pushWrappedBubble(parts, paragraph, softChars)
      else parts.push(paragraph)
    }
  } else {
    pushSentenceGroupedBubbles(parts, natural[0], QQ_BUBBLE_FALLBACK_SENTENCES)
  }
  return mergeQQBubbles(parts, targetMax)
}

/** 中国（上海）日历日 YYYY-MM-DD，与 TODAY_CACHE / 群日报对齐 */
const SHANGHAI_TZ = 'Asia/Shanghai'

function todayCst(date: Date = new Date()): string {
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
function formatShanghaiTime24h(ts: number = Date.now()): string {
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
function getShanghaiHourFromTs(ts: number): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts)).find((x) => x.type === 'hour')?.value
  return h !== undefined ? parseInt(h, 10) : NaN
}

/** 上海日历上 todayYmd 往前 n 天（字符串 YYYY-MM-DD），用于情绪历史截断 */
function todayCstMinusDays(daysBack: number): string {
  const ymd = todayCst()
  const d = new Date(`${ymd}T12:00:00+08:00`)
  d.setDate(d.getDate() - daysBack)
  return todayCst(d)
}

/** 从 catch 到的未知错误里安全取出文本消息（catch 变量在 strict 下是 unknown） */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return error === undefined || error === null ? '' : String(error)
}

/** 从 catch 到的未知错误里安全取出 Node errno code（如 EEXIST/EPERM） */
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : ''
  }
  return ''
}

export = {
  isRareProvocation, isWideRareProvocation, isHostileInput,
  normalizeText,
  isJailbreakAttempt, pickJailbreakFallbackReply,
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserInput, sanitizeUserName,
  extractAtIds, countAtIdOccurrences,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  formatPercent,
  readTextFile, writeTextFile, readJsonFile, writeJsonFile, readJsonFileSync, writeJsonFileSync,
  safeUnlink,
  getFileFingerprint,
  sleep, getRandomDelayMs, shouldTriggerRandom,
  parseEnabledText,
  getBaseHostname, isDashScopeConfig, isOpenAIOfficialConfig,
  normalizeUrl, normalizeHostname, isPrivateHostname, isPrivateIp, validatePublicHttpUrl, resolveAndValidateHostname,
  extractImageUrls, extractVoiceUrls,
  sanitizeFileToken, safeChannelKey, safeUserId, legacySafeUserId, truncateText: truncateTextValue, safeJsonStringify,
  normalizeReplyFingerprint,
  longestCommonSubstringLength, charSetJaccardOverlap,
  isReplyTooSimilar, isOverusedReply, hasBannedOutput,
  isThinkingLeak, isEvaluationRequest,
  calculateWillFactor, isSemanticProfile,
  getSegmentData, getSessionMessageSegments,
  getModelDisplayName, getSearchCapability, formatSearchStatus,
  trimReply, sanitizeReply, stripMarkdownForQQ, splitSentences, splitReplyForQQBubbles,
  todayCst, formatShanghaiTime24h, getShanghaiHourFromTs, todayCstMinusDays,
  errorMessage, errorCode,
}
