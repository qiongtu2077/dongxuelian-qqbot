/**
 * MODULE: Bilibili input and short-link boundary.
 * 职责: 归一化分享文本、生成稳定键，并在 DNS/重定向安全检查后解析 b23 短链。
 * 边界: 不下载媒体、不发送消息、不接触资源门禁。
 */
const dns = require('dns/promises') as typeof import('dns/promises')
const http = require('http') as typeof import('http')
const https = require('https') as typeof import('https')
const net = require('net') as typeof import('net')

export interface RedirectResponse {
  statusCode: number
  location: string
}

interface ResolvedHost {
  address: string
  family: number
}

type HostResolutionResult =
  | { ok: true, destination: ResolvedHost }
  | { ok: false, code: 'dns_empty' | 'dns_private_address' | 'redirect_outside_allowlist' }

export type ShortLinkFailureCode =
  | 'dns_empty'
  | 'dns_private_address'
  | 'request_timeout'
  | 'request_failed'
  | 'http_not_redirect'
  | 'missing_location'
  | 'redirect_limit'
  | 'redirect_outside_allowlist'
  | 'final_url_not_bv'

export type ShortLinkResolutionResult =
  | { ok: true, p1Url: string, hops: number }
  | { ok: false, code: ShortLinkFailureCode, hops: number, statusCode?: number }

export interface ShortLinkHopEvent {
  hop: number
  statusCode?: number
  finalHost: string
  finalPath: string
  failureCode?: ShortLinkFailureCode
  elapsedMs: number
}

export interface ShortLinkResolutionOptions {
  lookup?: (hostname: string) => Promise<ResolvedHost[]>
  requestRedirect?: (input: string, timeoutMs: number, destination: ResolvedHost) => Promise<RedirectResponse>
  now?: () => number
  onHop?: (event: ShortLinkHopEvent) => void
}

interface ShortLinkResolutionEntry {
  bvKey: string
  p1Url: string
  expiresAt: number
}

export interface ResolvedBiliInput {
  keys: string[]
  p1Url: string
  shortLink?: ShortLinkResolutionResult
}

export interface ResolveBiliInputOptions {
  url: string
  source: string
  resolveShortLink?: typeof resolveBiliShortLink
  onShortLinkHop?: (event: ShortLinkHopEvent) => void
  onError?: (failure: Extract<ShortLinkResolutionResult, { ok: false }>) => void
}

const SHORT_LINK_CACHE_TTL_MS = 10 * 60 * 1000
const SHORT_LINK_MAX_REDIRECTS = 5
const SHORT_LINK_TIMEOUT_MS = 5000
const SHORT_LINK_MAX_HEADER_BYTES = 16 * 1024
const shortLinkResolutionCache = new Map<string, ShortLinkResolutionEntry>()
const blockedIpv4Ranges = new net.BlockList()
const blockedIpv6Ranges = new net.BlockList()
const BLOCKED_IP_SUBNETS: Array<[string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]
for (const [network, prefix, type] of BLOCKED_IP_SUBNETS) {
  const blockList = type === 'ipv4' ? blockedIpv4Ranges : blockedIpv6Ranges
  blockList.addSubnet(network, prefix, type)
}

// --- 文本归一化与视频键 --- //

// 反复解码常见分享转义，保留无法解码的原始文本。
export function normalizeSharedText(input: string = ''): string {
  let text = String(input)
  for (let index = 0; index < 3; index++) {
    const previous = text
    text = text
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#123;/g, '{')
      .replace(/&#125;/g, '}')
      .replace(/&#58;/g, ':')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    try {
      const decoded = decodeURIComponent(text)
      if (decoded !== text) text = decoded
    } catch { /* malformed shared text remains usable without URI decoding */ }
    if (text === previous) break
  }
  return text
}

// 去重并删除空字符串，保持首次出现顺序。
export function uniqueStrings(values: unknown[] = []): string[] {
  return [...new Set(values.filter(Boolean).map(value => String(value)))]
}

// 将 BV 号转换为大小写无关的缓存键。
function normalizeBiliIdentifier(identifier: string = ''): string {
  const value = String(identifier).trim()
  if (!value) return ''
  return `bv:${value.replace(/^bv/i, '').toLowerCase()}`
}

// 将 B 站地址转换为忽略查询和尾斜杠的缓存键。
function normalizeBiliUrlKey(input: string = ''): string {
  const value = normalizeSharedText(input).trim()
  if (!value) return ''
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return host ? `url:${host}${pathname.toLowerCase()}` : ''
  } catch {
    return `url:${value.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()}`
  }
}

// 从普通文字中提取 B 站视频 URL 或裸 BV 号。
function extractBiliUrlFromText(input: string = ''): string | null {
  const text = normalizeSharedText(input)
  const urlMatch = text.match(/https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|bilibili\.com|b23\.tv)\/[^\s"'<>\\\]}),，。！？、]+/i)
  if (urlMatch) return urlMatch[0]
  const bvMatch = text.match(/\bBV[0-9A-Za-z]{10}\b/i)
  return bvMatch ? `https://www.bilibili.com/video/${bvMatch[0]}` : null
}

// 从序列化消息或其 JSON 子串中解析一个结构化卡片对象。
function parseSharedCardJson(input: string = ''): Record<string, unknown> | null {
  const text = normalizeSharedText(input).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

// 只遍历卡片中语义明确的 URL/link 字段，拒绝从标题、prompt 或 desc 提取 BV。
function extractBiliUrlFromCardValue(value: unknown, fieldName: string = ''): string | null {
  if (typeof value === 'string') return /(?:url|link)$/i.test(fieldName) ? extractBiliUrlFromText(value) : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractBiliUrlFromCardValue(item, fieldName)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = extractBiliUrlFromCardValue(child, key)
    if (found) return found
  }
  return null
}

// 判断消息是否为带 B 站品牌标识的结构化 QQ 卡片。
export function isBilibiliCardInput(input: string = ''): boolean {
  const card = parseSharedCardJson(input)
  return !!card && /(?:bilibili|哔哩哔哩|b23\.tv)/i.test(JSON.stringify(card))
}

// 从普通文字或结构化卡片的链接字段提取 B 站视频地址。
export function extractBiliUrl(input: string = ''): string | null {
  const card = parseSharedCardJson(input)
  return card ? extractBiliUrlFromCardValue(card) : extractBiliUrlFromText(input)
}

// 为去重和缓存生成 BV 键与 URL 键。
export function buildBiliKeys(input: string = ''): string[] {
  const text = normalizeSharedText(input)
  const keys = (text.match(/\bBV[0-9A-Za-z]{10}\b/gi) || []).map(normalizeBiliIdentifier)
  const url = extractBiliUrl(text)
  if (url) keys.push(normalizeBiliUrlKey(url))
  return uniqueStrings(keys)
}

// 从任意 B 站文本或地址中提取规范化 BV 缓存键。
function extractBvKey(input: string = ''): string {
  const match = normalizeSharedText(input).match(/\bBV[0-9A-Za-z]{10}\b/i)
  return match ? normalizeBiliIdentifier(match[0]) : ''
}

// 从任意 B 站文本或地址中提取保留原始大小写的 BV 号。
export function extractBvId(input: string = ''): string {
  const match = normalizeSharedText(input).match(/\bBV[0-9A-Za-z]{10}\b/i)
  return match ? match[0] : ''
}

// 将 BV 或普通视频地址统一为只指向第一分 P 的规范地址。
export function normalizeBiliP1Url(input: string = ''): string {
  const value = normalizeSharedText(input).trim()
  const bvId = extractBvId(value)
  if (bvId) return `https://www.bilibili.com/video/${bvId}?p=1`
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) return ''
    const identifier = parsed.pathname.match(/^\/video\/(av\d+)\/?$/i)?.[1]
    return identifier ? `https://www.bilibili.com/video/${identifier}?p=1` : ''
  } catch {
    return ''
  }
}

// 判断 URL 是否为需要轻量解析的 b23.tv 短链。
function isB23ShortUrl(input: string = ''): boolean {
  try {
    return new URL(input).hostname.toLowerCase() === 'b23.tv'
  } catch {
    return false
  }
}

// --- 短链网络安全与重定向 --- //

// 限定短链跳转只能留在 B 站公开域名内。
export function isAllowedBiliRedirectUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com')
  } catch {
    return false
  }
}

// 判断 DNS 结果是否属于本机、私网、链路本地或保留地址。
export function isPrivateIpAddress(address: string): boolean {
  const normalized = String(address || '').toLowerCase().split('%')[0]
  const version = net.isIP(normalized)
  if (version === 4) return blockedIpv4Ranges.check(normalized, 'ipv4')
  if (version === 6) return blockedIpv6Ranges.check(normalized, 'ipv6')
  return true
}

// 解析并验证白名单域名，返回已通过公网检查的固定连接地址。
async function resolvePublicBiliHost(input: string, lookup: ShortLinkResolutionOptions['lookup']): Promise<HostResolutionResult> {
  if (!isAllowedBiliRedirectUrl(input)) return { ok: false, code: 'redirect_outside_allowlist' }
  const hostname = new URL(input).hostname
  const resolveHost = lookup || (async (value: string) => dns.lookup(value, { all: true, verbatim: true }))
  const addresses = await resolveHost(hostname)
  if (!addresses.length) return { ok: false, code: 'dns_empty' }
  if (addresses.some(item => isPrivateIpAddress(item.address))) return { ok: false, code: 'dns_private_address' }
  return { ok: true, destination: addresses[0] }
}

// 固定到已校验 IP 读取短链响应，保留原域名 Host 和 TLS SNI。
async function requestRedirectLocation(input: string, timeoutMs: number, destination: ResolvedHost): Promise<RedirectResponse> {
  const parsed = new URL(input)
  const transport = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: destination.address,
      family: destination.family,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'HEAD',
      servername: parsed.hostname,
      maxHeaderSize: SHORT_LINK_MAX_HEADER_BYTES,
      headers: { host: parsed.host, 'user-agent': 'dongxuelian-local-video-sender/0.2' },
    }, response => {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location || ''
      response.resume()
      resolve({ statusCode: Number(response.statusCode || 0), location: String(location) })
    })
    request.setTimeout(Math.max(1, timeoutMs), () => {
      const error = Object.assign(new Error('short link redirect timeout'), { code: 'ETIMEDOUT' })
      request.destroy(error)
    })
    request.on('error', reject)
    request.end()
  })
}

// 返回日志允许记录的 host/path，主动丢弃完整查询参数。
function getSafeUrlParts(input: string): { finalHost: string, finalPath: string } {
  try {
    const parsed = new URL(input)
    return { finalHost: parsed.hostname.toLowerCase(), finalPath: parsed.pathname }
  } catch {
    return { finalHost: 'invalid', finalPath: '/' }
  }
}

// 判断网络异常是否属于计划允许的一次性重试范围。
function isRetryableNetworkError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | null)?.code || '').toUpperCase()
  return ['EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT'].includes(code)
}

// 把请求异常收敛为对外稳定的短链失败代码。
function classifyRequestFailure(error: unknown): ShortLinkFailureCode {
  const code = String((error as NodeJS.ErrnoException | null)?.code || '').toUpperCase()
  return code === 'ETIMEDOUT' ? 'request_timeout' : 'request_failed'
}

// 用剩余总预算包住 DNS 或请求 Promise，防止注入实现绕过五秒总时限。
async function runWithinShortLinkDeadline<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw Object.assign(new Error('short link redirect timeout'), { code: 'ETIMEDOUT' })
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('short link redirect timeout'), { code: 'ETIMEDOUT' })), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 沿受限重定向链把一个 b23 短链归一化为第一分 P 地址。
export async function resolveBiliShortLink(input: string, options: ShortLinkResolutionOptions = {}): Promise<ShortLinkResolutionResult> {
  let current = String(input || '').trim()
  const direct = normalizeBiliP1Url(current)
  if (!isB23ShortUrl(current)) return direct
    ? { ok: true, p1Url: direct, hops: 0 }
    : { ok: false, code: 'final_url_not_bv', hops: 0 }

  const now = options.now || Date.now
  const startedAt = now()
  const deadline = startedAt + SHORT_LINK_TIMEOUT_MS
  const requestRedirect = options.requestRedirect || requestRedirectLocation
  let hops = 0

  while (hops < SHORT_LINK_MAX_REDIRECTS) {
    const existing = normalizeBiliP1Url(current)
    if (existing) return { ok: true, p1Url: existing, hops }
    if (!isAllowedBiliRedirectUrl(current)) return { ok: false, code: 'redirect_outside_allowlist', hops }

    let response: RedirectResponse | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - now()
      if (remaining <= 0) return { ok: false, code: 'request_timeout', hops }

      try {
        const hostResult = await runWithinShortLinkDeadline(() => resolvePublicBiliHost(current, options.lookup), remaining)
        if (!hostResult.ok) {
          const failure = { ...hostResult, hops }
          const safe = getSafeUrlParts(current)
          options.onHop?.({ hop: hops + 1, ...safe, failureCode: failure.code, elapsedMs: now() - startedAt })
          return failure
        }
        const requestRemaining = deadline - now()
        response = await runWithinShortLinkDeadline(() => requestRedirect(current, requestRemaining, hostResult.destination), requestRemaining)
      } catch (error) {
        const failureCode = classifyRequestFailure(error)
        const safe = getSafeUrlParts(current)
        options.onHop?.({ hop: hops + 1, ...safe, failureCode, elapsedMs: now() - startedAt })
        if (attempt === 0 && isRetryableNetworkError(error)) continue
        return { ok: false, code: failureCode, hops }
      }

      if (response.statusCode >= 500 && response.statusCode <= 599) {
        const safe = getSafeUrlParts(current)
        options.onHop?.({ hop: hops + 1, ...safe, statusCode: response.statusCode, failureCode: 'request_failed', elapsedMs: now() - startedAt })
        if (attempt === 0) continue
        return { ok: false, code: 'request_failed', hops, statusCode: response.statusCode }
      }
      break
    }

    if (!response) return { ok: false, code: 'request_failed', hops }
    const redirectStatuses = [301, 302, 303, 307, 308]
    if (!redirectStatuses.includes(response.statusCode)) {
      const code: ShortLinkFailureCode = hops > 0 && response.statusCode >= 200 && response.statusCode < 300
        ? 'final_url_not_bv'
        : 'http_not_redirect'
      const safe = getSafeUrlParts(current)
      options.onHop?.({ hop: hops + 1, ...safe, statusCode: response.statusCode, failureCode: code, elapsedMs: now() - startedAt })
      return { ok: false, code, hops, statusCode: response.statusCode }
    }
    if (!response.location) {
      const safe = getSafeUrlParts(current)
      options.onHop?.({ hop: hops + 1, ...safe, statusCode: response.statusCode, failureCode: 'missing_location', elapsedMs: now() - startedAt })
      return { ok: false, code: 'missing_location', hops, statusCode: response.statusCode }
    }

    let nextUrl = ''
    try { nextUrl = new URL(response.location, current).toString() } catch { /* invalid Location is rejected below */ }
    if (!nextUrl || !isAllowedBiliRedirectUrl(nextUrl)) {
      const safe = getSafeUrlParts(nextUrl)
      options.onHop?.({ hop: hops + 1, ...safe, statusCode: response.statusCode, failureCode: 'redirect_outside_allowlist', elapsedMs: now() - startedAt })
      return { ok: false, code: 'redirect_outside_allowlist', hops, statusCode: response.statusCode }
    }
    hops += 1
    const safe = getSafeUrlParts(nextUrl)
    options.onHop?.({ hop: hops, ...safe, statusCode: response.statusCode, elapsedMs: now() - startedAt })
    current = nextUrl
  }

  const finalP1Url = normalizeBiliP1Url(current)
  return finalP1Url
    ? { ok: true, p1Url: finalP1Url, hops }
    : { ok: false, code: 'redirect_limit', hops }
}

// --- 短链结果缓存与统一输入 --- //

// 清理过期短链缓存并返回仍有效的第一分 P 结果。
function getCachedShortLinkResolution(urlKey: string, now: number = Date.now()): ShortLinkResolutionEntry | null {
  for (const [key, entry] of shortLinkResolutionCache) if (entry.expiresAt <= now) shortLinkResolutionCache.delete(key)
  const entry = shortLinkResolutionCache.get(urlKey)
  return entry && entry.expiresAt > now ? entry : null
}

// 在媒体探测前生成统一的第一分 P 地址，并补齐去重和缓存查询键。
export async function resolveBiliInput(options: ResolveBiliInputOptions): Promise<ResolvedBiliInput> {
  const { url, source } = options
  const keys = uniqueStrings(buildBiliKeys(source).concat(buildBiliKeys(url)))
  const directP1Url = normalizeBiliP1Url(url) || normalizeBiliP1Url(source)
  if (directP1Url) return { keys: uniqueStrings(keys.concat(buildBiliKeys(directP1Url))), p1Url: directP1Url }
  if (!isB23ShortUrl(url)) return { keys, p1Url: '' }
  const urlKey = normalizeBiliUrlKey(url)
  const cached = getCachedShortLinkResolution(urlKey)
  if (cached) return {
    keys: uniqueStrings(keys.concat(cached.bvKey).concat(buildBiliKeys(cached.p1Url))),
    p1Url: cached.p1Url,
    shortLink: { ok: true, p1Url: cached.p1Url, hops: 0 },
  }
  try {
    const resolver = options.resolveShortLink || resolveBiliShortLink
    const shortLink = await resolver(url, { onHop: options.onShortLinkHop })
    if (!shortLink.ok) {
      options.onError?.(shortLink)
      return { keys, p1Url: '', shortLink }
    }
    const p1Url = normalizeBiliP1Url(shortLink.p1Url)
    const bvKey = extractBvKey(p1Url)
    if (!p1Url || !bvKey) {
      const failure = { ok: false as const, code: 'final_url_not_bv' as const, hops: shortLink.hops }
      options.onError?.(failure)
      return { keys, p1Url: '', shortLink: failure }
    }
    shortLinkResolutionCache.set(urlKey, { bvKey, p1Url, expiresAt: Date.now() + SHORT_LINK_CACHE_TTL_MS })
    return { keys: uniqueStrings(keys.concat(bvKey).concat(buildBiliKeys(p1Url))), p1Url, shortLink }
  } catch (error) {
    const failure = { ok: false as const, code: classifyRequestFailure(error), hops: 0 }
    options.onError?.(failure)
    return { keys, p1Url: '', shortLink: failure }
  }
}

// 返回当前短链缓存数量，供运行状态展示。
export function getBiliInputCacheSize(): number {
  getCachedShortLinkResolution('', Date.now())
  return shortLinkResolutionCache.size
}

// 清空短链解析缓存，供插件 dispose 和测试隔离。
export function clearBiliInputCache(): void {
  shortLinkResolutionCache.clear()
}
