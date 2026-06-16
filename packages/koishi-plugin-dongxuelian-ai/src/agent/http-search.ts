/**
 * MODULE: Agent 轻量 HTTP 搜索。
 * 职责: 用普通 HTTP 拉取搜索结果 HTML，并抽取候选结果；必要时读取候选网页正文。
 * 边界: 不启动浏览器、不调用 AI API、不读写文件。
 * 状态: 无。
 */
const { rankSearchCandidates, formatSearchResults, buildSearchFailureText, classifySearchResult, extractRetryKeywords, detectFailurePattern, buildStrategyQueries } = require('./search-results') as typeof import('./search-results')
const { getDirectSearchCandidates } = require('./search-query') as typeof import('./search-query')
const { readCandidatePage } = require('./fetch-reader') as typeof import('./fetch-reader')

interface HttpSearchEndpoint {
  name: string
  url: (query: string) => string
}

interface HttpSearchLimitOptions {
  timeoutMs?: unknown
  totalTimeoutMs?: unknown
  maxBytes?: unknown
  queryLimit?: unknown
  pageLimit?: unknown
  pageMaxBytes?: unknown
  pageTextChars?: unknown
}

interface HttpSearchLimits {
  timeoutMs: number
  totalTimeoutMs: number
  maxBytes: number
  queryLimit: number
  pageLimit: number
  pageMaxBytes: number
  pageTextChars: number
}

interface SearchCandidate {
  title?: string
  url?: string
  snippet?: string
  text?: string
  score?: number
  sourceType?: string
}

interface OpenedSearchPage {
  title?: string
  url?: string
  finalUrl?: string
  status?: number
  contentType?: string
  text?: string
  textQuality?: string
  reason?: string
  truncated?: boolean
  sourceType?: string
  error?: string
}

interface PageReadResult {
  pages: OpenedSearchPage[]
  failures: string[]
}

interface HttpSearchRunResult {
  ok: boolean
  text: string
  failures: string[]
  status: 'usable_hit' | 'weak_hit' | 'hard_fail'
  query?: string
  engine?: string
  pages?: OpenedSearchPage[]
  candidates?: SearchCandidate[]
}

interface SearchPassResult {
  usable: boolean
  weak: boolean
  text?: string
  query?: string
  engine?: string
  pages: OpenedSearchPage[]
  ranked: SearchCandidate[]
  allCandidates: SearchCandidate[]
  score?: number
}

interface ResponseBodyReader {
  read: () => Promise<{ done?: boolean; value?: Uint8Array }>
  cancel: () => Promise<unknown> | unknown
}

interface HttpSearchResponseLike {
  ok?: boolean
  status?: number
  text: () => Promise<string>
  body?: {
    getReader?: () => ResponseBodyReader
  } | null
}

const HTTP_SEARCH_ENDPOINTS: HttpSearchEndpoint[] = [
  { name: 'Bing HTTP', url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
  { name: 'Sogou', url: query => `https://www.sogou.com/web?query=${encodeURIComponent(query)}` },
  { name: 'DuckDuckGo HTML', url: query => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
]
const HTTP_SEARCH_DEFAULT_TIMEOUT_MS = 5000
const HTTP_SEARCH_DEFAULT_TOTAL_TIMEOUT_MS = 45000
const HTTP_SEARCH_DEFAULT_MAX_BYTES = 512 * 1024
const HTTP_SEARCH_DEFAULT_QUERY_LIMIT = 6
const HTTP_SEARCH_DEFAULT_PAGE_LIMIT = 2
const HTTP_SEARCH_DEFAULT_PAGE_MAX_BYTES = 512 * 1024
const HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS = 3200
const HTTP_SEARCH_MIN_PAGE_TEXT_CHARS = 20
const HTTP_SEARCH_MAX_CANDIDATES = 100
const HTTP_SEARCH_CANDIDATE_OUTPUT_LIMIT = 6
const HTTP_SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function getHttpSearchErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message || '') : String(error || '')
}

function isHttpSearchAbortError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

function parseHttpSearchPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function getHttpSearchLimits(options: HttpSearchLimitOptions = {}): HttpSearchLimits {
  return {
    timeoutMs: parseHttpSearchPositiveInt(options.timeoutMs || process.env.DONGXUELIAN_HTTP_SEARCH_TIMEOUT_MS, HTTP_SEARCH_DEFAULT_TIMEOUT_MS, 1000, 15000),
    totalTimeoutMs: parseHttpSearchPositiveInt(options.totalTimeoutMs || process.env.DONGXUELIAN_HTTP_SEARCH_TOTAL_TIMEOUT_MS, HTTP_SEARCH_DEFAULT_TOTAL_TIMEOUT_MS, 2000, 90000),
    maxBytes: parseHttpSearchPositiveInt(options.maxBytes || process.env.DONGXUELIAN_HTTP_SEARCH_MAX_BYTES, HTTP_SEARCH_DEFAULT_MAX_BYTES, 64 * 1024, 2 * 1024 * 1024),
    queryLimit: parseHttpSearchPositiveInt(options.queryLimit || process.env.DONGXUELIAN_HTTP_SEARCH_QUERY_LIMIT, HTTP_SEARCH_DEFAULT_QUERY_LIMIT, 1, 6),
    pageLimit: parseHttpSearchPositiveInt(options.pageLimit || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_LIMIT, HTTP_SEARCH_DEFAULT_PAGE_LIMIT, 0, 4),
    pageMaxBytes: parseHttpSearchPositiveInt(options.pageMaxBytes || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_MAX_BYTES, HTTP_SEARCH_DEFAULT_PAGE_MAX_BYTES, 32 * 1024, 1024 * 1024),
    pageTextChars: parseHttpSearchPositiveInt(options.pageTextChars || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_TEXT_CHARS, HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS, 300, 4000),
  }
}

function decodeHttpSearchEntities(value: unknown = ''): string {
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|ndash|mdash|hellip);/gi, (match, entity) => {
    const key = String(entity || '').toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    if (key === 'nbsp' || key === 'ensp' || key === 'emsp' || key === 'thinsp') return ' '
    if (key === 'ndash') return '-'
    if (key === 'mdash') return '-'
    if (key === 'hellip') return '...'
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return match
  })
}

function stripHttpSearchTags(html: unknown = ''): string {
  return decodeHttpSearchEntities(String(html || '')
    .replace(/<script\b[^>]{0,500}>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]{0,500}>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]{0,500}>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractHttpPageText(html: unknown = '', maxChars: number = HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS): string {
  // 这些有界量词必须用非贪婪（?），否则贪婪匹配会从第一个开标签一路吃到最后一个闭标签，
  // 把夹在多个 <script>/<nav> 等块之间的正文全部吞掉，导致正文只剩标题（实测央视页 39111 字符
  // HTML 被吞到只剩 43 字）。改非贪婪后只匹配到最近的闭标签，正文得以保留。
  const withoutNoise = String(html || '')
    .replace(/<script\b[^>]{0,500}>[\s\S]{0,50000}?<\/script>/gi, ' ')
    .replace(/<style\b[^>]{0,500}>[\s\S]{0,50000}?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]{0,500}>[\s\S]{0,20000}?<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]{0,500}>[\s\S]{0,30000}?<\/nav>/gi, ' ')
    .replace(/<footer\b[^>]{0,500}>[\s\S]{0,30000}?<\/footer>/gi, ' ')
    .replace(/<aside\b[^>]{0,500}>[\s\S]{0,30000}?<\/aside>/gi, ' ')
  const text = stripHttpSearchTags(withoutNoise)
  return text
    .replace(/(?:版权所有|Copyright|ICP备案|隐私政策|用户协议).{0,200}/gi, ' ')
    .replace(/data-[\w-]{1,40}="[^"]{0,200}"/g, ' ')
    .replace(/data-[\w-]{1,40}='[^']{0,200}'/g, ' ')
    .replace(/\bt?\w+_\d+-t?\w+_\d+:\d+(?:\.\d+)?/g, ' ')
    .replace(/data-(?:spm|aplus|tracker|log|exp|beacon|click|report|stat|trace|monitor)[\w-]{0,60}/gi, ' ')
    .replace(/\b(?:spm|aplus|tracker|beacon)[A-Za-z0-9._-]{5,80}\b/g, ' ')
    .replace(/(?:tmodule_\w+_\d+|module_\w+_\d+)/g, ' ')
    .replace(/\b[a-f0-9]{24,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function pickHttpSearchAttr(attrs: unknown = '', name: string = ''): string {
  const source = String(attrs || '')
  const doubleQuoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]{0,2000})"`, 'i').exec(source)
  if (doubleQuoted) return doubleQuoted[1]
  const singleQuoted = new RegExp(`\\b${name}\\s*=\\s*'([^']{0,2000})'`, 'i').exec(source)
  if (singleQuoted) return singleQuoted[1]
  const unquoted = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]{1,2000})`, 'i').exec(source)
  return unquoted ? unquoted[1] : ''
}

function resolveHttpSearchUrl(rawUrl: unknown = '', baseUrl: string = 'https://duckduckgo.com/'): string {
  const decoded = decodeHttpSearchEntities(rawUrl).trim()
  if (!decoded || decoded.startsWith('#') || /^javascript:/i.test(decoded)) return ''
  try {
    const parsed = new URL(decoded, baseUrl)
    if (parsed.hostname.endsWith('duckduckgo.com')) {
      const redirected = parsed.searchParams.get('uddg')
      if (redirected) return resolveHttpSearchUrl(redirected, baseUrl)
    }
    parsed.hash = ''
    return parsed.toString()
  } catch { /* non-critical: malformed search result URL is ignored */
    return ''
  }
}

function extractHttpSearchCandidates(html: unknown = '', baseUrl: string = 'https://duckduckgo.com/'): SearchCandidate[] {
  const source = String(html || '')
  const candidates: SearchCandidate[] = []
  const anchorRe = /<a\b([^>]{0,2000})>([\s\S]{0,4000}?)<\/a>/gi
  let match = null
  while ((match = anchorRe.exec(source)) && candidates.length < HTTP_SEARCH_MAX_CANDIDATES) {
    const attrs = match[1] || ''
    const title = stripHttpSearchTags(match[2] || '')
    if (!title || title.length < 2) continue
    const url = resolveHttpSearchUrl(pickHttpSearchAttr(attrs, 'href'), baseUrl)
    if (!url) continue
    const start = Math.max(0, match.index - 800)
    const end = Math.min(source.length, match.index + match[0].length + 1600)
    const nearbyText = stripHttpSearchTags(source.slice(start, end))
    const snippet = nearbyText
      .replace(title, '')
      .replace(/https?:\/\/[^\s"'<>]{5,200}/g, ' ')
      .replace(/[a-zA-Z0-9_-]{20,}\.(?:css|js|png|jpg|gif|svg|woff2?)\b/g, ' ')
      .replace(/type="text\/css"\/?>?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 420)
    candidates.push({
      title: title.slice(0, 180),
      url,
      snippet,
      text: nearbyText.slice(0, 500),
    })
  }
  return candidates
}

async function readHttpSearchResponseText(response: HttpSearchResponseLike, maxBytes: number): Promise<string> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    return String(text || '').slice(0, maxBytes)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value instanceof Uint8Array ? value : Buffer.from(value || '')
    const remaining = maxBytes - total
    if (remaining <= 0) {
      try { await reader.cancel() } catch { /* non-critical: stream may already be closed */ }
      break
    }
    const part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
    total += part.length
    output += decoder.decode(part, { stream: total < maxBytes })
    if (chunk.length > remaining) {
      try { await reader.cancel() } catch { /* non-critical: stream may already be closed */ }
      break
    }
    if (total >= maxBytes) {
      try { await reader.cancel() } catch { /* non-critical: stream may already be closed */ }
      break
    }
  }
  output += decoder.decode()
  return output
}

async function fetchHttpSearchEndpoint(endpoint: HttpSearchEndpoint, query: string, limits: HttpSearchLimits, remainingMs: number): Promise<string> {
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 不支持 fetch，无法执行轻量 HTTP 搜索')
  const controller = new AbortController()
  const timeoutMs = Math.max(500, Math.min(limits.timeoutMs, remainingMs))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.url(query), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': HTTP_SEARCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return readHttpSearchResponseText(response as HttpSearchResponseLike, limits.maxBytes)
  } catch (error) {
    if (isHttpSearchAbortError(error)) throw new Error(`超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readHttpResultPage(url: unknown, limits: HttpSearchLimits, remainingMs: number): Promise<OpenedSearchPage & { ok: boolean }> {
  const timeoutMs = Math.max(500, Math.min(limits.timeoutMs, remainingMs))
  return readCandidatePage(url, {
    limits: {
      timeoutMs,
      maxBytes: limits.pageMaxBytes,
      maxChars: limits.pageTextChars,
      redirects: 5,
    },
    maxChars: limits.pageTextChars,
    minTextChars: HTTP_SEARCH_MIN_PAGE_TEXT_CHARS,
    extractText: (body: string) => extractHttpPageText(body, limits.pageTextChars),
  })
}

async function fetchHttpResultPage(url: unknown, limits: HttpSearchLimits, remainingMs: number): Promise<string> {
  const page = await readHttpResultPage(url, limits, remainingMs)
  if (!page.ok) throw new Error(page.reason || '候选网页读取失败')
  if (page.textQuality !== 'usable') throw new Error(page.reason || '正文不可用')
  return page.text || ''
}

function formatCandidateReadFailure(item: SearchCandidate = {}, page: OpenedSearchPage = {}): string {
  const label = item.title || item.url || page.url || '候选网页'
  const reason = page.reason || page.error || '读取失败'
  const status = page.status ? `HTTP ${page.status}` : ''
  const finalUrl = page.finalUrl && page.finalUrl !== item.url ? `最终 URL: ${page.finalUrl}` : ''
  return [label, reason, status, finalUrl].filter(Boolean).join(' / ')
}

async function readTopResultPages(results: SearchCandidate[] = [], limits: HttpSearchLimits, startedAt: number): Promise<PageReadResult> {
  const pages: OpenedSearchPage[] = []
  const failures: string[] = []
  const candidates = (Array.isArray(results) ? results : []).slice(0, limits.pageLimit + 2)
  let attempts = 0
  const maxAttempts = Math.min(candidates.length, limits.pageLimit + 2)
  for (const item of candidates) {
    if (pages.length >= limits.pageLimit) break
    if (attempts >= maxAttempts) break
    if (isHomepageUrl(item.url)) {
      failures.push(`${item.title || item.url}: 跳过（首页/SPA）`)
      continue
    }
    const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs < 500) {
      failures.push('候选网页读取总超时')
      break
    }
    attempts++
    const page = await readHttpResultPage(item.url, limits, remainingMs)
    if (!page.ok || page.textQuality !== 'usable') {
      failures.push(formatCandidateReadFailure(item, page))
      continue
    }
    pages.push({
      title: page.title || item.title || item.url,
      url: item.url,
      finalUrl: page.finalUrl,
      status: page.status,
      contentType: page.contentType,
      text: page.text,
      textQuality: page.textQuality,
      reason: page.reason,
      truncated: page.truncated,
      sourceType: 'opened_body',
    })
  }
  return { pages, failures }
}

function isGarbagePageText(text: unknown = ''): boolean {
  const sample = String(text || '').slice(0, 500)
  if (/^<img\s|^<svg\s|track_ua\.gif/i.test(sample)) return true
  const pathCount = (sample.match(/<path\s/gi) || []).length
  if (pathCount >= 3) return true
  return false
}

function isHomepageUrl(url: unknown = ''): boolean {
  try {
    const parsed = new URL(String(url || ''))
    const path = parsed.pathname.replace(/\/+$/, '')
    if (!path || path === '/index' || path === '/index.html' || path === '/home') return true
    if (/kurogames\.com$/i.test(parsed.hostname) && /^\/(main|zh-Hans\/main)$/i.test(path)) return true
    if (/baike\.baidu\.com/i.test(parsed.hostname)) return true
    if (/zdic\.net|chagushici\.com|dict\./i.test(parsed.hostname)) return true
    return false
  } catch { /* non-critical: malformed URL is treated as non-homepage */
    return false
  }
}

function mergeHttpSearchCandidates(...groups: SearchCandidate[][]): SearchCandidate[] {
  const seen = new Set<string>()
  const merged: SearchCandidate[] = []
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const key = String(item && item.url || item && item.title || '').trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
}

function formatCandidateList(candidates: SearchCandidate[] = []): string {
  const items = (Array.isArray(candidates) ? candidates : []).slice(0, HTTP_SEARCH_CANDIDATE_OUTPUT_LIMIT)
  if (!items.length) return ''
  return items.map((item, index) => {
    const title = item.title || item.url || `candidate-${index + 1}`
    const score = Number.isFinite(item.score) ? `可信度分：${item.score}` : ''
    const snippet = item.snippet || item.text || ''
    return [
      `${index + 1}. ${title}`,
      `   ${item.url || ''}`,
      score ? `   ${score}` : '',
      snippet ? `   候选摘要：${String(snippet).slice(0, 220)}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n')
}

function formatSearchWithPages(query: unknown = '', ranked: SearchCandidate[] = [], pageReads: Partial<PageReadResult> = {}): string {
  const base = formatSearchResults(query, ranked)
  const pages = Array.isArray(pageReads.pages) ? pageReads.pages : []
  const failureText = Array.isArray(pageReads.failures) && pageReads.failures.length
    ? `\n候选网页打开失败/跳过记录（低确信线索，不作为正文依据）：\n${pageReads.failures.slice(0, 3).map(item => `- ${item}`).join('\n')}`
    : ''
  if (!base) return ''
  if (!pages.length) {
    const candidateText = formatCandidateList(ranked)
    const candidateSection = candidateText
      ? `\n\n候选 URL（可交给 web_fetch 继续读取；未读取正文前不要当事实）：\n${candidateText}`
      : ''
    const weakNotice = '\n\n读取状态：未打开到可用正文。以上只有候选链接和搜索页摘要，不能作为事实依据。请继续换 query 或对可信候选 URL 使用 web_fetch。'
    return `${base}${candidateSection}${failureText}${weakNotice}`
  }
  const pageText = pages.slice(0, 2).map((item, index) => [
    `【来源 ${index + 1}】标题：${item.title}`,
    `URL：${item.url}`,
    item.finalUrl && item.finalUrl !== item.url ? `最终 URL：${item.finalUrl}` : '',
    item.status ? `状态：HTTP ${item.status}` : '',
    item.contentType ? `类型：${item.contentType}` : '',
    `正文质量：${item.textQuality || 'usable'}（${item.reason || '已读取可用正文'}）`,
    item.truncated ? '提示：响应体已截断，正文可能不完整。' : '',
    `正文：${item.text}`,
    '---',
  ].filter(Boolean).join('\n')).join('\n')
  return `搜索状态：usable_hit（已读到可用候选正文）\n${base}\n\n打开候选网页继续读取（已打开候选网页正文；只有本段正文可作为主要依据，搜索页摘要仍只是候选线索；轻量 HTTP，未启动 Chromium）：\n${pageText}${failureText}`
}

async function runHttpSearch(queries: unknown[] | unknown = [], options: HttpSearchLimitOptions = {}): Promise<HttpSearchRunResult> {
  const limits = getHttpSearchLimits(options)
  const queryList = (Array.isArray(queries) ? queries : [queries])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limits.queryLimit)
  const firstQuery = queryList[0] || ''
  const failures: string[] = []
  if (!firstQuery) return { ok: false, text: buildSearchFailureText('', ['query 为空']), failures, status: 'hard_fail' }

  const startedAt = Date.now()
  const maxRetries = 5
  const usedQueries = new Set(queryList.map(q => q.toLowerCase()))
  let currentQueries = queryList
  let bestWeakResult: SearchPassResult | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const passResult = await runSearchPass(currentQueries, limits, startedAt, failures)
    if (passResult.usable) {
      return { ok: true, text: passResult.text || '', query: passResult.query || firstQuery, engine: passResult.engine, failures, pages: passResult.pages, candidates: passResult.ranked || [], status: 'usable_hit' }
    }
    if (passResult.weak && (!bestWeakResult || (passResult.score || 0) > (bestWeakResult.score || 0))) {
      bestWeakResult = passResult
    }
    if (attempt >= maxRetries) break
    const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs < 2000) break

    const failurePattern = detectFailurePattern(passResult.ranked || [], passResult.pages || [], passResult.allCandidates || [])
    const strategyQueries = buildStrategyQueries(failurePattern, firstQuery, usedQueries)
    const retryKeywords = extractRetryKeywords(passResult.ranked || [], passResult.pages || [], firstQuery)
    const keywordQueries = buildRetryQueries(retryKeywords, firstQuery, usedQueries)
    const newQueries = [...strategyQueries, ...keywordQueries].filter(q => !usedQueries.has(q.toLowerCase())).slice(0, 3)
    if (!newQueries.length) break
    for (const q of newQueries) usedQueries.add(q.toLowerCase())
    currentQueries = newQueries
    failures.push(`重试第${attempt + 1}轮（失败模式: ${failurePattern}）: ${newQueries.join(' | ')}`)
  }

  if (!bestWeakResult) {
    const directResult = await runDirectCandidatesFallback(queryList, limits, startedAt, failures)
    if (directResult) return directResult
    return { ok: false, text: buildSearchFailureText(firstQuery, failures), failures, status: 'hard_fail' }
  }
  return {
    ok: true,
    text: `搜索状态：weak_hit（弱命中，未读到可用正文）\n${bestWeakResult.text}\n\n（注：以上为候选 URL 与搜索页摘要，未打开候选网页正文，不能作为事实依据。应继续换词搜索，或对可信候选 URL 调用 web_fetch。）`,
    query: bestWeakResult.query,
    engine: bestWeakResult.engine,
    failures,
    pages: [],
    candidates: bestWeakResult.ranked || [],
    status: 'weak_hit',
  }
}

function buildRetryQueries(keywords: unknown[] = [], originalQuery: unknown, usedQueries: Set<string>): string[] {
  const result: string[] = []
  for (const kw of keywords) {
    const candidate = `${originalQuery} ${kw}`.trim()
    if (candidate.length > 180) continue
    if (usedQueries.has(candidate.toLowerCase())) continue
    result.push(candidate)
    if (result.length >= 2) break
  }
  return result
}

async function runSearchPass(queryList: string[], limits: HttpSearchLimits, startedAt: number, failures: string[]): Promise<SearchPassResult> {
  let bestSearchOnlyResult: SearchPassResult | null = null
  let lastRanked: SearchCandidate[] = []
  let lastPages: OpenedSearchPage[] = []
  let allCandidates: SearchCandidate[] = []
  let directMerged = false

  for (const query of queryList) {
    if (!directMerged) {
      const directCandidates = getDirectSearchCandidates(query)
      if (directCandidates.length) {
        allCandidates = allCandidates.concat(directCandidates)
        directMerged = true
      }
    }
    for (const endpoint of HTTP_SEARCH_ENDPOINTS) {
      const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt)
      if (remainingMs < 500) {
        failures.push('轻量 HTTP 搜索总超时')
        return { usable: false, weak: !!bestSearchOnlyResult, text: bestSearchOnlyResult?.text, query: bestSearchOnlyResult?.query, engine: bestSearchOnlyResult?.engine, score: bestSearchOnlyResult?.score, ranked: lastRanked, pages: lastPages, allCandidates }
      }
      try {
        const html = await fetchHttpSearchEndpoint(endpoint, query, limits, remainingMs)
        const candidates = extractHttpSearchCandidates(html, endpoint.url(query))
        allCandidates = allCandidates.concat(candidates.slice(0, 20))
        const directCandidates = directMerged ? getDirectSearchCandidates(query) : []
        const merged = mergeHttpSearchCandidates(candidates, directCandidates)
        const ranked = rankSearchCandidates(merged, query)
        lastRanked = ranked.length ? ranked : lastRanked
        const pageReads = ranked.length && limits.pageLimit > 0 ? await readTopResultPages(ranked, limits, startedAt) : { pages: [], failures: [] }
        failures.push(...pageReads.failures.map(item => `候选网页: ${item}`))
        lastPages = pageReads.pages.length ? pageReads.pages : lastPages
        const text = formatSearchWithPages(query, ranked, pageReads)
        const hitStatus = classifySearchResult(ranked, pageReads.pages)
        if (text && hitStatus === 'usable_hit') {
          return { usable: true, weak: false, text, query, engine: endpoint.name, pages: pageReads.pages, ranked, allCandidates, score: ranked[0]?.score || 0 }
        }
        if (text) {
          const topScore = ranked[0]?.score
          const score = typeof topScore === 'number' && Number.isFinite(topScore) ? topScore : 0
          if (!bestSearchOnlyResult || score > (bestSearchOnlyResult.score || 0)) {
            bestSearchOnlyResult = { usable: false, weak: true, text, query, engine: endpoint.name, pages: pageReads.pages, ranked, allCandidates, score }
          }
          failures.push(`${endpoint.name}: 弱命中（${hitStatus}），继续尝试`)
          break
        } else {
          failures.push(`${endpoint.name}: 未提取到有效搜索结果`)
        }
      } catch (error) {
        failures.push(`${endpoint.name}: ${getHttpSearchErrorMessage(error)}`)
      }
    }
  }
  return { usable: false, weak: !!bestSearchOnlyResult, text: bestSearchOnlyResult?.text, query: bestSearchOnlyResult?.query, engine: bestSearchOnlyResult?.engine, score: bestSearchOnlyResult?.score, ranked: lastRanked, pages: lastPages, allCandidates }
}

async function runDirectCandidatesFallback(queryList: string[], limits: HttpSearchLimits, startedAt: number, failures: string[]): Promise<HttpSearchRunResult | null> {
  for (const query of queryList) {
    const directCandidates = getDirectSearchCandidates(query)
    if (!directCandidates.length) continue
    const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs < 500) {
      failures.push('轻量 HTTP 搜索总超时')
      return null
    }
    try {
      const ranked = rankSearchCandidates(directCandidates, query)
      const pageReads = ranked.length && limits.pageLimit > 0 ? await readTopResultPages(ranked, limits, startedAt) : { pages: [], failures: [] }
      failures.push(...pageReads.failures.map(item => `直达官网候选: ${item}`))
      const text = formatSearchWithPages(query, ranked, pageReads)
      if (text && pageReads.pages.length) {
        return { ok: true, text, query, engine: 'Direct official candidates', failures, pages: pageReads.pages, candidates: ranked, status: 'usable_hit' }
      }
      if (text) {
        return {
          ok: true,
          text: `搜索状态：weak_hit（弱命中，未读到可用正文）\n${text}\n\n（注：以上为候选 URL 与搜索页摘要，未打开候选网页正文，不能作为事实依据。应继续换词搜索，或对可信候选 URL 调用 web_fetch。）`,
          query,
          engine: 'Direct official candidates',
          failures,
          pages: [],
          candidates: ranked,
          status: 'weak_hit',
        }
      }
    } catch (error) {
      failures.push(`direct candidates: ${getHttpSearchErrorMessage(error)}`)
    }
  }
  return null
}

export = {
  HTTP_SEARCH_ENDPOINTS,
  decodeHttpSearchEntities,
  stripHttpSearchTags,
  resolveHttpSearchUrl,
  extractHttpSearchCandidates,
  extractHttpPageText,
  readHttpResultPage,
  fetchHttpResultPage,
  readTopResultPages,
  mergeHttpSearchCandidates,
  formatCandidateList,
  formatSearchWithPages,
  runHttpSearch,
  runSearchPass,
  buildRetryQueries,
}
