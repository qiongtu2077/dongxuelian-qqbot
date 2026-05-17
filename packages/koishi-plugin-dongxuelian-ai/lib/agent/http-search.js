/**
 * MODULE: Agent 轻量 HTTP 搜索。
 * 职责: 用普通 HTTP 拉取搜索结果 HTML，并抽取候选结果；必要时读取候选网页正文。
 * 边界: 不启动浏览器、不调用 AI API、不读写文件。
 * 状态: 无。
 */
const { rankSearchCandidates, formatSearchResults, buildSearchFailureText, classifySearchResult, extractRetryKeywords, detectFailurePattern, buildStrategyQueries } = require('./search-results')
const { getDirectSearchCandidates } = require('./search-query')

const HTTP_SEARCH_ENDPOINTS = [
  { name: 'Bing HTTP', url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
  { name: 'Sogou', url: query => `https://www.sogou.com/web?query=${encodeURIComponent(query)}` },
  { name: 'DuckDuckGo HTML', url: query => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
]
const HTTP_SEARCH_DEFAULT_TIMEOUT_MS = 5000
const HTTP_SEARCH_DEFAULT_TOTAL_TIMEOUT_MS = 25000
const HTTP_SEARCH_DEFAULT_MAX_BYTES = 512 * 1024
const HTTP_SEARCH_DEFAULT_QUERY_LIMIT = 4
const HTTP_SEARCH_DEFAULT_PAGE_LIMIT = 2
const HTTP_SEARCH_DEFAULT_PAGE_MAX_BYTES = 512 * 1024
const HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS = 3200
const HTTP_SEARCH_MIN_PAGE_TEXT_CHARS = 20
const HTTP_SEARCH_MAX_CANDIDATES = 100
const HTTP_SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function parseHttpSearchPositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function getHttpSearchLimits(options = {}) {
  return {
    timeoutMs: parseHttpSearchPositiveInt(options.timeoutMs || process.env.DONGXUELIAN_HTTP_SEARCH_TIMEOUT_MS, HTTP_SEARCH_DEFAULT_TIMEOUT_MS, 1000, 15000),
    totalTimeoutMs: parseHttpSearchPositiveInt(options.totalTimeoutMs || process.env.DONGXUELIAN_HTTP_SEARCH_TOTAL_TIMEOUT_MS, HTTP_SEARCH_DEFAULT_TOTAL_TIMEOUT_MS, 2000, 45000),
    maxBytes: parseHttpSearchPositiveInt(options.maxBytes || process.env.DONGXUELIAN_HTTP_SEARCH_MAX_BYTES, HTTP_SEARCH_DEFAULT_MAX_BYTES, 64 * 1024, 2 * 1024 * 1024),
    queryLimit: parseHttpSearchPositiveInt(options.queryLimit || process.env.DONGXUELIAN_HTTP_SEARCH_QUERY_LIMIT, HTTP_SEARCH_DEFAULT_QUERY_LIMIT, 1, 4),
    pageLimit: parseHttpSearchPositiveInt(options.pageLimit || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_LIMIT, HTTP_SEARCH_DEFAULT_PAGE_LIMIT, 0, 4),
    pageMaxBytes: parseHttpSearchPositiveInt(options.pageMaxBytes || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_MAX_BYTES, HTTP_SEARCH_DEFAULT_PAGE_MAX_BYTES, 32 * 1024, 1024 * 1024),
    pageTextChars: parseHttpSearchPositiveInt(options.pageTextChars || process.env.DONGXUELIAN_HTTP_SEARCH_PAGE_TEXT_CHARS, HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS, 300, 4000),
  }
}

function decodeHttpSearchEntities(value = '') {
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

function stripHttpSearchTags(html = '') {
  return decodeHttpSearchEntities(String(html || '')
    .replace(/<script\b[^>]{0,500}>[\s\S]{0,20000}<\/script>/gi, ' ')
    .replace(/<style\b[^>]{0,500}>[\s\S]{0,20000}<\/style>/gi, ' ')
    .replace(/<[^>]{0,500}>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractHttpPageText(html = '', maxChars = HTTP_SEARCH_DEFAULT_PAGE_TEXT_CHARS) {
  const withoutNoise = String(html || '')
    .replace(/<script\b[^>]{0,500}>[\s\S]{0,50000}<\/script>/gi, ' ')
    .replace(/<style\b[^>]{0,500}>[\s\S]{0,50000}<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]{0,500}>[\s\S]{0,20000}<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]{0,500}>[\s\S]{0,30000}<\/nav>/gi, ' ')
    .replace(/<footer\b[^>]{0,500}>[\s\S]{0,30000}<\/footer>/gi, ' ')
    .replace(/<aside\b[^>]{0,500}>[\s\S]{0,30000}<\/aside>/gi, ' ')
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

function pickHttpSearchAttr(attrs = '', name = '') {
  const source = String(attrs || '')
  const doubleQuoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]{0,2000})"`, 'i').exec(source)
  if (doubleQuoted) return doubleQuoted[1]
  const singleQuoted = new RegExp(`\\b${name}\\s*=\\s*'([^']{0,2000})'`, 'i').exec(source)
  if (singleQuoted) return singleQuoted[1]
  const unquoted = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]{1,2000})`, 'i').exec(source)
  return unquoted ? unquoted[1] : ''
}

function resolveHttpSearchUrl(rawUrl = '', baseUrl = 'https://duckduckgo.com/') {
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
  } catch {
    return ''
  }
}

function extractHttpSearchCandidates(html = '', baseUrl = 'https://duckduckgo.com/') {
  const source = String(html || '')
  const candidates = []
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

async function readHttpSearchResponseText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    return String(text || '').slice(0, maxBytes)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value instanceof Uint8Array ? value : Buffer.from(value)
    const remaining = maxBytes - total
    const part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
    total += part.length
    output += decoder.decode(part, { stream: total < maxBytes })
    if (chunk.length > remaining) {
      try { await reader.cancel() } catch {}
      break
    }
  }
  output += decoder.decode()
  return output
}

async function fetchHttpSearchEndpoint(endpoint, query, limits, remainingMs) {
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
    return readHttpSearchResponseText(response, limits.maxBytes)
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function getResponseHeader(response, name) {
  try {
    if (response.headers && typeof response.headers.get === 'function') return response.headers.get(name) || ''
  } catch {}
  return ''
}

async function fetchHttpResultPage(url, limits, remainingMs) {
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 不支持 fetch，无法读取候选网页')
  const controller = new AbortController()
  const timeoutMs = Math.max(500, Math.min(limits.timeoutMs, remainingMs))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': HTTP_SEARCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = getResponseHeader(response, 'content-type')
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain|application\/json)/i.test(contentType)) {
      throw new Error(`非文本页面（${contentType.slice(0, 60)}）`)
    }
    const html = await readHttpSearchResponseText(response, limits.pageMaxBytes)
    const text = extractHttpPageText(html, limits.pageTextChars)
    if (!text || text.length < HTTP_SEARCH_MIN_PAGE_TEXT_CHARS) throw new Error('正文过短')
    return text
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readTopResultPages(results = [], limits, startedAt) {
  const pages = []
  const failures = []
  const candidates = (Array.isArray(results) ? results : []).slice(0, limits.pageLimit + 2)
  let pagesRead = 0
  for (const item of candidates) {
    if (pagesRead >= limits.pageLimit) break
    if (isHomepageUrl(item.url)) {
      failures.push(`${item.title || item.url}: 跳过（首页/SPA）`)
      continue
    }
    const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs < 500) {
      failures.push('候选网页读取总超时')
      break
    }
    try {
      const text = await fetchHttpResultPage(item.url, limits, remainingMs)
      pagesRead++
      if (text.length < 50 || isGarbagePageText(text)) {
        failures.push(`${item.title || item.url}: 正文无效（SPA/tracking/非文本）`)
        continue
      }
      pages.push({
        title: item.title || item.url,
        url: item.url,
        text,
      })
    } catch (error) {
      pagesRead++
      failures.push(`${item.title || item.url}: ${error.message || String(error)}`)
    }
  }
  return { pages, failures }
}

function isGarbagePageText(text = '') {
  const sample = text.slice(0, 500)
  if (/^<img\s|^<svg\s|track_ua\.gif/i.test(sample)) return true
  const pathCount = (sample.match(/<path\s/gi) || []).length
  if (pathCount >= 3) return true
  const cjkCount = (sample.match(/[一-鿿]/g) || []).length
  if (cjkCount < 10 && text.length > 200) return true
  return false
}

function isHomepageUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''))
    const path = parsed.pathname.replace(/\/+$/, '')
    if (!path || path === '/index' || path === '/index.html' || path === '/home') return true
    if (/kurogames\.com$/i.test(parsed.hostname) && /^\/(main|zh-Hans\/main)$/i.test(path)) return true
    if (/baike\.baidu\.com/i.test(parsed.hostname)) return true
    if (/zdic\.net|chagushici\.com|dict\./i.test(parsed.hostname)) return true
    return false
  } catch {
    return false
  }
}

function mergeHttpSearchCandidates(...groups) {
  const seen = new Set()
  const merged = []
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

function formatSearchWithPages(query = '', ranked = [], pageReads = {}) {
  const base = formatSearchResults(query, ranked)
  const pages = Array.isArray(pageReads.pages) ? pageReads.pages : []
  if (!base || !pages.length) return base
  const pageText = pages.slice(0, 2).map((item, index) => [
    `【来源 ${index + 1}】标题：${item.title}`,
    `URL：${item.url}`,
    `正文：${item.text}`,
    '---',
  ].join('\n')).join('\n')
  return `${base}\n\n打开候选网页继续读取（轻量 HTTP，未启动 Chromium）：\n${pageText}`
}

async function runHttpSearch(queries = [], options = {}) {
  const limits = getHttpSearchLimits(options)
  const queryList = (Array.isArray(queries) ? queries : [queries])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limits.queryLimit)
  const firstQuery = queryList[0] || ''
  const failures = []
  if (!firstQuery) return { ok: false, text: buildSearchFailureText('', ['query 为空']), failures, status: 'hard_fail' }

  const startedAt = Date.now()
  const maxRetries = 2
  const usedQueries = new Set(queryList.map(q => q.toLowerCase()))
  let currentQueries = queryList
  let bestWeakResult = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const passResult = await runSearchPass(currentQueries, limits, startedAt, failures)
    if (passResult.usable) {
      return { ok: true, text: passResult.text, query: passResult.query, engine: passResult.engine, failures, pages: passResult.pages, status: 'usable_hit' }
    }
    if (passResult.weak && (!bestWeakResult || passResult.score > bestWeakResult.score)) {
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
    text: `${bestWeakResult.text}\n\n（注：以下为搜索页摘要，未打开候选网页正文，置信度低于已打开正文的结果。）`,
    query: bestWeakResult.query,
    engine: bestWeakResult.engine,
    failures,
    pages: [],
    status: 'weak_hit',
  }
}

function buildRetryQueries(keywords, originalQuery, usedQueries) {
  const result = []
  for (const kw of keywords) {
    const candidate = `${originalQuery} ${kw}`.trim()
    if (candidate.length > 180) continue
    if (usedQueries.has(candidate.toLowerCase())) continue
    result.push(candidate)
    if (result.length >= 2) break
  }
  return result
}

async function runSearchPass(queryList, limits, startedAt, failures) {
  let bestSearchOnlyResult = null
  let lastRanked = []
  let lastPages = []
  let allCandidates = []
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
        return { usable: false, weak: !!bestSearchOnlyResult, ...bestSearchOnlyResult, ranked: lastRanked, pages: lastPages, allCandidates }
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
          const score = ranked[0] && Number.isFinite(ranked[0].score) ? ranked[0].score : 0
          if (!bestSearchOnlyResult || score > bestSearchOnlyResult.score) {
            bestSearchOnlyResult = { text, query, engine: endpoint.name, pages: pageReads.pages, score }
          }
          failures.push(`${endpoint.name}: 弱命中（${hitStatus}），继续尝试`)
          break
        } else {
          failures.push(`${endpoint.name}: 未提取到有效搜索结果`)
        }
      } catch (error) {
        failures.push(`${endpoint.name}: ${error.message || String(error)}`)
      }
    }
  }
  return { usable: false, weak: !!bestSearchOnlyResult, ...bestSearchOnlyResult, ranked: lastRanked, pages: lastPages, allCandidates }
}

async function runDirectCandidatesFallback(queryList, limits, startedAt, failures) {
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
        return { ok: true, text, query, engine: 'Direct official candidates', failures, pages: pageReads.pages, status: 'usable_hit' }
      }
      if (text) {
        return {
          ok: true,
          text: `${text}\n\n（注：以下为搜索页摘要，未打开候选网页正文，置信度低于已打开正文的结果。）`,
          query,
          engine: 'Direct official candidates',
          failures,
          pages: [],
          status: 'weak_hit',
        }
      }
    } catch (error) {
      failures.push(`direct candidates: ${error.message || String(error)}`)
    }
  }
  return null
}

module.exports = {
  HTTP_SEARCH_ENDPOINTS,
  decodeHttpSearchEntities,
  stripHttpSearchTags,
  resolveHttpSearchUrl,
  extractHttpSearchCandidates,
  extractHttpPageText,
  fetchHttpResultPage,
  readTopResultPages,
  mergeHttpSearchCandidates,
  formatSearchWithPages,
  runHttpSearch,
  runSearchPass,
  buildRetryQueries,
}
