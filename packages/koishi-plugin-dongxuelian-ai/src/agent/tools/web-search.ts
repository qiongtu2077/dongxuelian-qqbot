/**
 * MODULE: 联网搜索工具。
 * 优先使用 LLM API 内置搜索，不可用时降级到轻量 HTTP 搜索；Chromium 兜底需要显式启用。
 */
const { requestChatCompletions } = require('../../core/api') as typeof import('../../core/api')
const { loadConfig } = require('../../core/runtime-config') as typeof import('../../core/runtime-config')
const { getSearchCapability } = require('../../core/utils') as typeof import('../../core/utils')
const { buildSearchQueries, isLowQualitySearchResult, getSearchHostname } = require('../search-query') as typeof import('../search-query')
const { runHttpSearch, mergeHttpSearchCandidates, formatCandidateList } = require('../http-search') as typeof import('../http-search')
const { rankSearchCandidates } = require('../search-results') as typeof import('../search-results')
const { readCandidatePage } = require('../fetch-reader') as typeof import('../fetch-reader')
const { normalizeFetchedText } = require('./web-fetch') as typeof import('./web-fetch')
const { withTimeout } = require('../../core/utils') as typeof import('../../core/utils')

interface WebSearchParams {
  query?: unknown
  queries?: unknown
  [key: string]: unknown
}

interface SearchCandidate {
  title?: string
  url?: string
  snippet?: string
  sourceType?: string
}

interface FetchedSearchPage {
  ok: boolean
  title?: string
  url?: string
  finalUrl?: string
  status?: number
  contentType?: string
  text?: string
  textQuality?: string
  reason?: string
  truncated?: boolean
}

interface ApiSearchPageReadResult {
  pages: FetchedSearchPage[]
  failures: string[]
}

interface ApiSearchVerificationResult {
  ok: boolean
  status: 'usable_hit' | 'weak_hit'
  text: string
  candidates?: SearchCandidate[]
  pages?: FetchedSearchPage[]
  failures?: string[]
}

interface ChatCompletionResult {
  content?: string
}

interface BrowserActionTool {
  execute: (params?: Record<string, unknown>) => Promise<string>
}

const API_SEARCH_TIMEOUT_MS = 12000
const BROWSER_SEARCH_QUERY_LIMIT = 2
const CHROMIUM_SEARCH_ENV = 'DONGXUELIAN_AGENT_BROWSER_SEARCH'
const BROWSER_SEARCH_MIN_AVAILABLE_MB = 700
const API_SEARCH_FETCH_PAGE_LIMIT = 2
const API_SEARCH_URL_LIMIT = 8
const URL_RE = /https?:\/\/[^\s"'<>）)\]]+/ig

function runWebSearchWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | string> {
  return withTimeout(() => promise, timeoutMs).catch((error: unknown) => {
    if (error && (error as { code?: string }).code === 'TIMEOUT') return `${label}超时（${timeoutMs}ms）`
    throw error
  }) as Promise<T | string>
}

function hasSearchSourceSignal(text: unknown = ''): boolean {
  const value = String(text || '')
  if (/https?:\/\/[^\s)）]+/i.test(value)) return true
  if (/(?:来源|参考|出处|链接)[:：\s]|(?:kurogames|wutheringwaves|bilibili|weibo|TapTap|GameKee)|(?:库洛|鸣潮官网)|官方(?:公告|新闻|资讯|微博|B站|bilibili)/i.test(value)) return true
  return false
}

function apiSearchLooksUnreliable(text: unknown = ''): boolean {
  const value = String(text || '').trim()
  if (value.length < 30) return true
  if (!hasSearchSourceSignal(value)) return true
  if (/未搜索到|没有找到|无法确认|无可靠结果|不能确定|搜索失败|素材|模板|图片下载|免费下载|图库|设计素材/.test(value)) return true
  const urls = value.match(/https?:\/\/[^\s)）]+/gi) || []
  if (urls.length > 0 && urls.every(url => isLowQualitySearchResult({ url, title: getSearchHostname(url) }))) return true
  return false
}

function cleanExtractedSearchUrl(url: unknown = ''): string {
  return String(url || '')
    .replace(/[),.;:!?，。；：！？、]+$/g, '')
    .trim()
}

function extractUrlsFromSearchText(text: unknown = ''): string[] {
  const matches = String(text || '').match(URL_RE) || []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const raw of matches) {
    const url = cleanExtractedSearchUrl(raw)
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
    if (urls.length >= API_SEARCH_URL_LIMIT) break
  }
  return urls
}

function buildApiSearchCandidates(text: unknown = '', query: string = ''): SearchCandidate[] {
  const sourceText = String(text || '')
  const urls = extractUrlsFromSearchText(text)
  const candidates = urls.map(url => {
    const host = getSearchHostname(url)
    const titleMatch = new RegExp(`([^\\n。；;]{0,80})${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(sourceText)
    return {
      title: titleMatch && titleMatch[1] ? titleMatch[1].replace(/(?:来源|参考|链接|URL)[:：\s]*$/i, '').trim() || host : host || url,
      url,
      snippet: sourceText.slice(0, 360),
      sourceType: 'api_search_candidate',
    }
  })
  return rankSearchCandidates(candidates, query, API_SEARCH_URL_LIMIT)
}

async function readApiSearchCandidatePages(candidates: SearchCandidate[] = []): Promise<ApiSearchPageReadResult> {
  const pages: FetchedSearchPage[] = []
  const failures: string[] = []
  for (const item of candidates.slice(0, API_SEARCH_URL_LIMIT)) {
    if (pages.length >= API_SEARCH_FETCH_PAGE_LIMIT) break
    const url = String(item.url || '').trim()
    if (!url) continue
    const page = await readCandidatePage(url, {
      maxChars: 3600,
      minTextChars: 80,
      extractText: (body: string, maxChars: number, fetchedPage: { contentType?: string }) => normalizeFetchedText(body, fetchedPage.contentType || '', maxChars),
    })
    if (!page.ok || page.textQuality !== 'usable') {
      failures.push(`${item.title || item.url}: ${page.reason || '读取失败'}`)
      continue
    }
    pages.push({
      ok: true,
      title: page.title || item.title || url,
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      contentType: page.contentType,
      text: page.text,
      textQuality: page.textQuality,
      reason: page.reason,
      truncated: page.truncated,
    })
  }
  return { pages, failures }
}

function formatFetchedApiSearchResult(query: string, apiText: unknown, candidates: SearchCandidate[], pageReads: ApiSearchPageReadResult): string {
  const pages = Array.isArray(pageReads.pages) ? pageReads.pages : []
  const failures = Array.isArray(pageReads.failures) ? pageReads.failures : []
  const candidateText = formatCandidateList(candidates)
  const candidateSection = candidateText
    ? `API 搜索候选 URL（标题/摘要只用于选链接）：\n${candidateText}`
    : 'API 搜索未提取到可读候选 URL。'
  const failureText = failures.length
    ? `\n候选网页打开失败/跳过记录（低确信线索，不作为正文依据）：\n${failures.slice(0, 3).map(item => `- ${item}`).join('\n')}`
    : ''
  if (!pages.length) {
    return [
      '搜索状态：weak_hit（API 搜索返回了候选，但 web_fetch 未读到可用正文）',
      `已搜索：${query}`,
      candidateSection,
      failureText,
      'API 搜索原文摘要（低确信度，只能辅助选 URL，不能作为事实依据）：',
      String(apiText || '').slice(0, 1200),
      '下一步：继续换 query，或对可信候选 URL 调用 web_fetch。',
    ].filter(Boolean).join('\n')
  }
  const pageText = pages.map((item, index) => [
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
  return [
    '搜索状态：usable_hit（API 找到候选 URL，已用 web_fetch 读取正文）',
    `已搜索：${query}`,
    candidateSection,
    '打开候选网页继续读取（已打开候选网页正文；只有本段正文可作为主要依据，API 摘要仍只是候选线索）：',
    pageText,
    failureText,
  ].filter(Boolean).join('\n')
}

async function verifyApiSearchWithFetch(apiText: unknown = '', queries: string[] = []): Promise<ApiSearchVerificationResult> {
  const query = queries[0] || ''
  const candidates = rankSearchCandidates(
    mergeHttpSearchCandidates(...queries.map(item => buildApiSearchCandidates(apiText, item))),
    query,
    API_SEARCH_URL_LIMIT,
  )
  if (!candidates.length) {
    return {
      ok: false,
      status: 'weak_hit',
      text: [
        '搜索状态：weak_hit（API 搜索有文本但没有可读取候选 URL）',
        `已搜索：${query}`,
        'API 搜索原文摘要（低确信度，不能作为事实依据）：',
        String(apiText || '').slice(0, 1200),
        '下一步：继续换 query，或让用户给出可读取的公开 URL。',
      ].join('\n'),
    }
  }
  const pageReads = await readApiSearchCandidatePages(candidates)
  return {
    ok: pageReads.pages.length > 0,
    status: pageReads.pages.length > 0 ? 'usable_hit' : 'weak_hit',
    text: formatFetchedApiSearchResult(query, apiText, candidates, pageReads),
    candidates,
    pages: pageReads.pages,
    failures: pageReads.failures,
  }
}

function normalizeQueryList(params: WebSearchParams = {}): string[] {
  const raw = Array.isArray(params.queries) ? params.queries : []
  const query = String(params.query || '').trim()
  const planned = raw.length ? raw : buildSearchQueries(query)
  const seen = new Set<string>()
  return planned.concat(query ? [query] : []).map(item => String(item || '').trim()).filter(item => {
    if (!item || item.length > 220) return false
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 6)
}

function isEnvEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim())
}

function isBrowserSearchEnabled() {
  return isEnvEnabled(CHROMIUM_SEARCH_ENV) || isEnvEnabled('DONGXUELIAN_ALLOW_CHROMIUM_SEARCH')
}

function getAvailableMemoryMb(): number {
  try {
    const os = require('os')
    return Math.floor(os.freemem() / 1024 / 1024)
  } catch {
    return 0
  }
}

function getBrowserSearchBlockReason() {
  const minMb = parseInt(process.env.DONGXUELIAN_AGENT_BROWSER_MIN_AVAILABLE_MB || '', 10) || BROWSER_SEARCH_MIN_AVAILABLE_MB
  const availableMb = getAvailableMemoryMb()
  if (availableMb > 0 && availableMb < minMb) {
    return `Chromium 浏览器兜底已跳过：当前可用内存约 ${availableMb}MB，低于安全阈值 ${minMb}MB。`
  }
  return ''
}

function getWebSearchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

async function browserSearch(queries: string[], reason: string): Promise<string> {
  const browserAction = require('./browser-action') as typeof import('./browser-action')
  const results: string[] = []
  const failures: string[] = []
  try {
    for (const query of queries.slice(0, BROWSER_SEARCH_QUERY_LIMIT)) {
      try {
        const result = await browserAction.execute({ action: 'search_and_read', query })
        results.push(result)
        if (!/未提取到有效搜索结果|搜索结果质量较低|素材|模板/.test(String(result || ''))) break
      } catch (error) {
        failures.push(`${query}: ${getWebSearchErrorMessage(error)}`)
        break
      }
    }
  } finally {
    await browserAction.execute({ action: 'stop' }).catch(() => {
      /* non-critical: browser fallback cleanup should not hide search result */
    })
  }
  if (results.length) return `${reason}\n${results.join('\n\n---\n')}`
  return `${reason}\nChromium 浏览器搜索失败：${failures.join('\n') || '未返回结果'}`
}

async function fallbackSearch(queries: string[], reason: string): Promise<string> {
  const httpResult = await runHttpSearch(queries)
  if (httpResult.ok) return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}`
  if (isBrowserSearchEnabled()) {
    const blockReason = getBrowserSearchBlockReason()
    if (blockReason) return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}\n${blockReason}`
    return browserSearch(queries, `${reason}\n轻量 HTTP 搜索未拿到可靠结果，已按 ${CHROMIUM_SEARCH_ENV}=1 启用 Chromium 浏览器兜底。`)
  }
  return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}\n为避免低内存服务器 OOM，web_search 默认跳过 Chromium 浏览器搜索。若确需浏览器兜底，请设置 ${CHROMIUM_SEARCH_ENV}=1，并确保内存充足。`
}

export = {
  definition: {
    name: 'web_search',
    description: '联网搜索最新、最近、热门、趋势、排行、推荐、视频、新闻、天气、游戏更新等会过期的信息。内部最多尝试 6 组关键词，优先打开可信候选页正文；API 搜索不可用时降级到轻量 HTTP 搜索；默认不会启动 Chromium。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如 "鸣潮 2026 新角色"' },
        queries: { type: 'array', description: '可选，多组搜索关键词；工具会按顺序尝试并去重。' },
      },
      required: ['query'],
    },
  },
  async execute(params: WebSearchParams = {}): Promise<string> {
    const query = String(params.query || '').trim()
    if (!query) throw new Error('query 不能为空')
    const queries = normalizeQueryList(params)

    const config = await loadConfig()
    const capability = getSearchCapability(config)

    if (!config.searchEnabled || !capability.supported) {
      return fallbackSearch(queries, `API 联网搜索不可用（${capability.label}）。`)
    }

    try {
      const resultObj = await runWebSearchWithTimeout(
        requestChatCompletions(
          [{ role: 'user', content: `搜索当前最新信息，不要凭训练数据编造。优先官方或高可信来源，忽略素材/模板/图片下载站。查询：${queries.join('；')}` }],
          config,
          { enable_search: true, search_options: { forced_search: true }, max_tokens: 800, _timeoutMs: API_SEARCH_TIMEOUT_MS },
        ),
        API_SEARCH_TIMEOUT_MS,
        'API 搜索',
      )
      const result = typeof resultObj === 'string' ? resultObj : (resultObj as ChatCompletionResult).content
      if (typeof result === 'string' && /超时/.test(result)) return fallbackSearch(queries, `${result}。`)
      if (result && typeof result === 'string' && !apiSearchLooksUnreliable(result)) {
        const verified = await verifyApiSearchWithFetch(result, queries)
        if (verified.ok) return `API 搜索返回了候选来源，已用 web_fetch 验证正文。\n${verified.text}`
        return fallbackSearch(queries, `API 搜索只返回候选/摘要，web_fetch 未读到可靠正文。\n${verified.text}`)
      }
      return fallbackSearch(queries, 'API 搜索没有返回可靠来源。')
    } catch (e) {
      return fallbackSearch(queries, `API 搜索请求失败：${getWebSearchErrorMessage(e) || '未知错误'}。`)
    }

    return fallbackSearch(queries, 'API 搜索没有返回可用结果。')
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
  getAvailableMemoryMb,
  getBrowserSearchBlockReason,
  extractUrlsFromSearchText,
  buildApiSearchCandidates,
  verifyApiSearchWithFetch,
}
