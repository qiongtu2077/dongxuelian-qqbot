/**
 * MODULE: Agent 搜索结果清洗。
 * 职责: 把浏览器搜索页里的 DOM 候选转成可信搜索结果文本。
 * 边界: 不启动浏览器、不调用 AI API、不读写文件。
 * 状态: 无。
 */
const { sortSearchResults, isLowQualitySearchResult } = require('./search-query')

const SEARCH_NAV_TITLE_RE = /^(全部|搜索|图片|视频|地图|资讯|新闻|网页|更多|工具|时间不限|Any time|Tools|WEB|IMAGES|VIDEOS|MAPS|贴吧|知道|文库)$/i
const SEARCH_NOISE_RE = /(?:某些结果已被删除|Skip to content|Accessibility Feedback|辅助功能反馈|跳至内容|百度热搜|相关搜索|大家还在搜|广告|推广|免责声明)/
const SEARCH_INTERNAL_URL_RE = /(?:javascript:|\/search\?|\/images\/search|\/videos\/search|go\.microsoft\.com\/fwlink|baidu\.com\/s\?|bing\.com\/search\?|duckduckgo\.com\/html\/?)/i

function normalizeResultUrl(url = '') {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/ck/a') {
      const target = parsed.searchParams.get('u')
      if (target) {
        const decoded = target.startsWith('a1') ? Buffer.from(target.slice(2), 'base64').toString('utf8') : target
        return normalizeResultUrl(decoded)
      }
    }
    if (parsed.hostname.endsWith('baidu.com') && parsed.pathname.startsWith('/link')) return raw
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|spm|from|fr|tn|ie|wd|oq|rsv_|sa|ved|usg|form)$/i.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return raw
  }
}

function getResultKey(item = {}) {
  const url = normalizeResultUrl(item.url)
  if (url) return url.replace(/[?&](?:rut|sid|share_token)=[^&]+/gi, '')
  return String(item.title || '').trim().toLowerCase()
}

function getQueryTerms(query = '') {
  return String(query || '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
    .slice(0, 8)
}

function hasQuerySignal(item = {}, query = '') {
  const terms = getQueryTerms(query)
  if (!terms.length) return true
  const haystack = `${item.title || ''}\n${item.snippet || ''}\n${item.text || ''}\n${item.url || ''}`.toLowerCase()
  return terms.some(term => haystack.includes(term.toLowerCase()))
}

function normalizeSearchCandidate(item = {}) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim()
  const url = normalizeResultUrl(item.url)
  const snippet = String(item.snippet || item.text || '').replace(/\s+/g, ' ').trim()
  return {
    title: title.slice(0, 180),
    url,
    snippet: snippet.slice(0, 360),
    text: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 360),
  }
}

function isUsefulSearchResult(item = {}, query = '') {
  const normalized = normalizeSearchCandidate(item)
  if (!normalized.title || !normalized.url) return false
  if (SEARCH_NAV_TITLE_RE.test(normalized.title)) return false
  if (SEARCH_NOISE_RE.test(normalized.title) || SEARCH_NOISE_RE.test(normalized.snippet)) return false
  if (SEARCH_INTERNAL_URL_RE.test(normalized.url)) return false
  if (!/^https?:\/\//i.test(normalized.url)) return false
  if (isLowQualitySearchResult(normalized)) return false
  return hasQuerySignal(normalized, query)
}

function rankSearchCandidates(candidates = [], query = '', limit = 8) {
  const seen = new Set()
  const useful = []
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const item = normalizeSearchCandidate(raw)
    if (!isUsefulSearchResult(item, query)) continue
    const key = getResultKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    useful.push(item)
  }
  return sortSearchResults(useful, query).slice(0, limit)
}

function formatSearchResults(query = '', results = []) {
  const ranked = Array.isArray(results) ? results : []
  if (!ranked.length) return ''
  const lines = ranked.map((item, index) => {
    const snippet = item.snippet || item.text || '(无摘要)'
    return `${index + 1}. ${item.title}\n   ${item.url}\n   可信度分：${item.score}\n   ${snippet}`
  })
  return `已搜索：${query}\n搜索结果：\n${lines.join('\n')}`
}

function buildSearchFailureText(query = '', failures = []) {
  const detail = Array.isArray(failures) && failures.length ? '\n' + failures.join('\n') : ''
  return `已搜索：${query}\n未提取到有效搜索结果。搜索页结果抽取失败或结果质量过低，已拒绝把广告、导航、侧栏正文当作搜索事实。${detail}`
}

module.exports = {
  normalizeResultUrl,
  normalizeSearchCandidate,
  isUsefulSearchResult,
  rankSearchCandidates,
  formatSearchResults,
  buildSearchFailureText,
}
