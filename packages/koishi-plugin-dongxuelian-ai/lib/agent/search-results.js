/**
 * MODULE: Agent 搜索结果清洗。
 * 职责: 把浏览器搜索页里的 DOM 候选转成可信搜索结果文本。
 * 边界: 不启动浏览器、不调用 AI API、不读写文件。
 * 状态: 无。
 */
const { sortSearchResults, isLowQualitySearchResult, getSearchHostname } = require('./search-query')

const SEARCH_NAV_TITLE_RE = /^(全部|搜索|图片|视频|地图|资讯|新闻|网页|更多|工具|时间不限|Any time|Tools|WEB|IMAGES|VIDEOS|MAPS|贴吧|知道|文库)$/i
const SEARCH_NOISE_RE = /(?:某些结果已被删除|Skip to content|Accessibility Feedback|辅助功能反馈|跳至内容|百度热搜|相关搜索|大家还在搜|广告|推广|免责声明)/
const SEARCH_INTERNAL_URL_RE = /(?:javascript:|\/search\?|\/images\/search|\/videos\/search|go\.microsoft\.com\/fwlink|baidu\.com\/s\?|bing\.com\/search\?|duckduckgo\.com\/html\/?)/i
const DICTIONARY_RESULT_RE = /(?:字典|百科|汉典|汉语|词典|说文|康熙|释义|笔画|部首|拼音|字义|字源|字汇)/i
const HOMEPAGE_RESULT_RE = /(?:首页|官网首页|主页|home\s*page|index|portal|welcome)/i
const MIN_SEARCH_RESULT_SCORE = 5

const TRUSTED_DOMAIN_FOR_PASS_RE = /(?:kurogames|wutheringwaves|minecraft|mojang|bilibili|weibo|taptap|gamekee|17173|9game|\.gov|\.edu|github|developer|docs|official|news|support|changelog|release)/i
const HIGH_VALUE_ENTITY_RE = /(?:[一-鿿]{2,6}(?:版本|公告|更新|角色|共鸣者|卡池|活动|前瞻|直播))|(?:v?\d+\.\d+(?:\.\d+)?)|(?:[A-Z][a-z]+(?:[A-Z][a-z]+)+)|(?:(?:release|version|update|patch|snapshot|pre-release)\s*[\d.]+)/gi

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
      if (/^(utm_.*|spm|from|fr|tn|ie|wd|oq|rsv_.*|sa|ved|usg|form)$/i.test(key)) parsed.searchParams.delete(key)
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
    .filter(item => item.length >= 2 && !/^(最新|当前|现在|是谁|什么|怎么|一下|查询|搜索|官方)$/.test(item))
    .slice(0, 8)
}

function hasTrustedSearchSignal(item = {}, query = '') {
  const haystack = `${item.title || ''}\n${item.snippet || ''}\n${item.text || ''}\n${item.url || ''}`
  if (/鸣潮|wuthering\s*waves|wutheringwaves|kuro|库洛/i.test(query)) {
    return /鸣潮|wuthering\s*waves|wutheringwaves|kuro|库洛|共鸣者|角色|版本|前瞻|公告/i.test(haystack)
  }
  if (/minecraft|我的世界|mojang/i.test(query)) {
    return /minecraft|我的世界|mojang|release|version|update|snapshot/i.test(haystack)
  }
  return false
}

function hasQuerySignal(item = {}, query = '') {
  const terms = getQueryTerms(query)
  if (!terms.length) return true
  const haystack = `${item.title || ''}\n${item.snippet || ''}\n${item.text || ''}\n${item.url || ''}`.toLowerCase()
  if (terms.some(term => haystack.includes(term.toLowerCase()))) return true
  if (hasTrustedSearchSignal(item, query)) return true
  const host = getSearchHostname(item.url)
  if (TRUSTED_DOMAIN_FOR_PASS_RE.test(host) && getResultDomainSignal(item)) return true
  return false
}

function getResultDomainSignal(item = {}) {
  try {
    const host = new URL(String(item.url || '')).hostname.replace(/^www\./i, '')
    if (/\.(gov|edu)$/i.test(host)) return true
    if (/(?:official|news|support|developer|docs|blog|help|changelog|release|minecraft|mojang|kurogames|wutheringwaves|bilibili|weibo|taptap|gamekee)/i.test(host)) return true
  } catch {}
  const text = `${item.title || ''}\n${item.snippet || ''}\n${item.text || ''}`
  return /(?:官方|公告|新闻|资讯|版本|更新|前瞻|release|released|update|latest|changelog|patch notes|source|official)/i.test(text)
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
  if (DICTIONARY_RESULT_RE.test(normalized.title)) return false
  if (DICTIONARY_RESULT_RE.test(normalized.url)) return false
  return hasQuerySignal(normalized, query) || getResultDomainSignal(normalized)
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
  return sortSearchResults(useful, query)
    .filter(item => (item.score || 0) >= MIN_SEARCH_RESULT_SCORE)
    .slice(0, limit)
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

function classifySearchResult(ranked = [], pages = []) {
  if (!ranked.length) return 'hard_fail'
  const hasPageContent = pages.some(p => p.text && p.text.length >= 80)
  const hasHighScore = ranked.some(r => (r.score || 0) >= 50)
  const hasVeryHighScore = ranked.some(r => (r.score || 0) >= 80)
  const hasTrustedDirect = ranked.some(r => (r.score || 0) >= 100)
  if (hasPageContent && hasHighScore) return 'usable_hit'
  if (hasVeryHighScore && pages.some(p => p.text && p.text.length >= 40)) return 'usable_hit'
  if (hasTrustedDirect && pages.some(p => p.text && p.text.length >= 20)) return 'usable_hit'
  if (ranked.length > 0) return 'weak_hit'
  return 'hard_fail'
}

function extractRetryKeywords(ranked = [], pages = [], originalQuery = '') {
  const seen = new Set(getQueryTerms(originalQuery).map(t => t.toLowerCase()))
  const candidates = []
  const allText = [
    ...ranked.map(r => `${r.title || ''} ${r.snippet || ''}`),
    ...pages.map(p => p.text || ''),
  ].join(' ')
  const entityMatches = allText.match(HIGH_VALUE_ENTITY_RE) || []
  for (const m of entityMatches) {
    const word = m.trim()
    if (word.length < 2 || word.length > 30) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(word)
    if (candidates.length >= 6) break
  }
  return candidates.slice(0, 4)
}

function detectFailurePattern(ranked = [], pages = [], allCandidates = []) {
  if (!ranked.length && !allCandidates.length) return 'no_results'
  const items = [...ranked, ...allCandidates]
  const total = items.length
  let dictCount = 0
  let homeCount = 0
  for (const item of items) {
    const text = `${item.title || ''} ${item.snippet || ''}`
    if (DICTIONARY_RESULT_RE.test(text)) dictCount++
    if (HOMEPAGE_RESULT_RE.test(text)) homeCount++
  }
  if (dictCount >= total * 0.4) return 'dictionary_ambiguity'
  if (homeCount >= total * 0.3) return 'homepage_only'
  if (ranked.length && pages.every(p => !p.text || p.text.length < 80)) return 'shallow_content'
  if (ranked.length) return 'low_relevance'
  return 'no_results'
}

function buildStrategyQueries(failurePattern, originalQuery, usedQueries) {
  const result = []
  const year = new Date().getFullYear()
  const push = (q) => {
    const trimmed = q.trim().slice(0, 180)
    if (trimmed && !usedQueries.has(trimmed.toLowerCase())) result.push(trimmed)
  }
  if (failurePattern === 'dictionary_ambiguity') {
    push(`${originalQuery} 游戏 新闻`)
    push(`${originalQuery} 游戏 最新 ${year}`)
    const enMatch = originalQuery.match(/鸣潮/i) ? 'Wuthering Waves' : originalQuery.match(/我的世界/i) ? 'Minecraft' : ''
    if (enMatch) push(`${enMatch} latest news ${year}`)
  } else if (failurePattern === 'homepage_only') {
    push(`${originalQuery} 公告 新闻 ${year}`)
    push(`${originalQuery} 最新 更新 版本`)
  } else if (failurePattern === 'shallow_content') {
    push(`${originalQuery} 详情 攻略`)
    push(`${originalQuery} 公告 详细`)
  } else if (failurePattern === 'low_relevance') {
    push(`${originalQuery} 官方 ${year}`)
    push(`"${originalQuery}" 最新`)
  } else {
    push(`${originalQuery} ${year}`)
    push(`${originalQuery} 最新消息`)
  }
  return result.slice(0, 3)
}

module.exports = {
  normalizeResultUrl,
  normalizeSearchCandidate,
  isUsefulSearchResult,
  hasQuerySignal,
  getResultDomainSignal,
  rankSearchCandidates,
  formatSearchResults,
  buildSearchFailureText,
  classifySearchResult,
  extractRetryKeywords,
  detectFailurePattern,
  buildStrategyQueries,
}
