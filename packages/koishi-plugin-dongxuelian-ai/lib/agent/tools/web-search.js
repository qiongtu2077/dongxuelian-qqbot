/**
 * MODULE: 联网搜索工具。
 * 优先使用 LLM API 内置搜索，不可用时降级到轻量 HTTP 搜索；Chromium 兜底需要显式启用。
 */
const { requestChatCompletions } = require('../../api')
const { loadConfig } = require('../../runtime-config')
const { getSearchCapability } = require('../../utils')
const { buildSearchQueries, isLowQualitySearchResult, getSearchHostname } = require('../search-query')
const { runHttpSearch } = require('../http-search')

const API_SEARCH_TIMEOUT_MS = 12000
const BROWSER_SEARCH_QUERY_LIMIT = 2
const CHROMIUM_SEARCH_ENV = 'DONGXUELIAN_AGENT_BROWSER_SEARCH'
const BROWSER_SEARCH_MIN_AVAILABLE_MB = 700
function searchWithTimeout(promise, timeoutMs, label) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(`${label}超时（${timeoutMs}ms）`), timeoutMs)
      if (timer.unref) timer.unref()
    }),
  ])
}

function hasSearchSourceSignal(text = '') {
  const value = String(text || '')
  if (/https?:\/\/[^\s)）]+/i.test(value)) return true
  if (/(?:来源|参考|出处|链接)[:：\s]|(?:kurogames|wutheringwaves|bilibili|weibo|TapTap|GameKee)|(?:库洛|鸣潮官网)|官方(?:公告|新闻|资讯|微博|B站|bilibili)/i.test(value)) return true
  return false
}

function apiSearchLooksUnreliable(text = '') {
  const value = String(text || '').trim()
  if (value.length < 30) return true
  if (!hasSearchSourceSignal(value)) return true
  if (/未搜索到|没有找到|无法确认|无可靠结果|不能确定|搜索失败|素材|模板|图片下载|免费下载|图库|设计素材/.test(value)) return true
  const urls = value.match(/https?:\/\/[^\s)）]+/gi) || []
  if (urls.length > 0 && urls.every(url => isLowQualitySearchResult({ url, title: getSearchHostname(url) }))) return true
  return false
}

function normalizeQueryList(params = {}) {
  const raw = Array.isArray(params.queries) ? params.queries : []
  const query = String(params.query || '').trim()
  const planned = raw.length ? raw : buildSearchQueries(query)
  const seen = new Set()
  return planned.concat(query ? [query] : []).map(item => String(item || '').trim()).filter(item => {
    if (!item || item.length > 220) return false
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 4)
}

function isEnvEnabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim())
}

function isBrowserSearchEnabled() {
  return isEnvEnabled(CHROMIUM_SEARCH_ENV) || isEnvEnabled('DONGXUELIAN_ALLOW_CHROMIUM_SEARCH')
}

function getAvailableMemoryMb() {
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

async function browserSearch(queries, reason) {
  const browserAction = require('./browser-action')
  const results = []
  const failures = []
  try {
    for (const query of queries.slice(0, BROWSER_SEARCH_QUERY_LIMIT)) {
      try {
        const result = await browserAction.execute({ action: 'search_and_read', query })
        results.push(result)
        if (!/未提取到有效搜索结果|搜索结果质量较低|素材|模板/.test(String(result || ''))) break
      } catch (error) {
        failures.push(`${query}: ${error.message || String(error)}`)
        break
      }
    }
  } finally {
    await browserAction.execute({ action: 'stop' }).catch(() => {})
  }
  if (results.length) return `${reason}\n${results.join('\n\n---\n')}`
  return `${reason}\nChromium 浏览器搜索失败：${failures.join('\n') || '未返回结果'}`
}

async function fallbackSearch(queries, reason) {
  const httpResult = await runHttpSearch(queries)
  if (httpResult.ok) return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}`
  if (isBrowserSearchEnabled()) {
    const blockReason = getBrowserSearchBlockReason()
    if (blockReason) return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}\n${blockReason}`
    return browserSearch(queries, `${reason}\n轻量 HTTP 搜索未拿到可靠结果，已按 ${CHROMIUM_SEARCH_ENV}=1 启用 Chromium 浏览器兜底。`)
  }
  return `${reason}\n已改用轻量 HTTP 搜索（未启动 Chromium）。\n${httpResult.text}\n为避免低内存服务器 OOM，web_search 默认跳过 Chromium 浏览器搜索。若确需浏览器兜底，请设置 ${CHROMIUM_SEARCH_ENV}=1，并确保内存充足。`
}

module.exports = {
  definition: {
    name: 'web_search',
    description: '联网搜索最新信息。用户问实时新闻、天气、游戏更新、最新资讯时使用；API 搜索不可用时内部降级到轻量 HTTP 搜索，并优先打开可信候选页正文；默认不会启动 Chromium。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如 "鸣潮 2026 新角色"' },
        queries: { type: 'array', description: '可选，多组搜索关键词；工具会按顺序尝试并去重。' },
      },
      required: ['query'],
    },
  },
  async execute(params = {}) {
    const query = String(params.query || '').trim()
    if (!query) throw new Error('query 不能为空')
    const queries = normalizeQueryList(params)

    const config = await loadConfig()
    const capability = getSearchCapability(config)

    if (!config.searchEnabled || !capability.supported) {
      return fallbackSearch(queries, `API 联网搜索不可用（${capability.label}）。`)
    }

    try {
      const resultObj = await searchWithTimeout(
        requestChatCompletions(
          [{ role: 'user', content: `搜索当前最新信息，不要凭训练数据编造。优先官方或高可信来源，忽略素材/模板/图片下载站。查询：${queries.join('；')}` }],
          config,
          { enable_search: true, search_options: { forced_search: true }, max_tokens: 800, _fallbackSet: 'chat', _timeoutMs: API_SEARCH_TIMEOUT_MS },
        ),
        API_SEARCH_TIMEOUT_MS,
        'API 搜索',
      )
      const result = typeof resultObj === 'string' ? resultObj : resultObj.content
      if (typeof result === 'string' && /超时/.test(result)) return fallbackSearch(queries, `${result}。`)
      if (result && typeof result === 'string' && !apiSearchLooksUnreliable(result)) return result
      return fallbackSearch(queries, 'API 搜索没有返回可靠来源。')
    } catch (e) {
      return fallbackSearch(queries, `API 搜索请求失败：${e.message || '未知错误'}。`)
    }

    return fallbackSearch(queries, 'API 搜索没有返回可用结果。')
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
  getAvailableMemoryMb,
  getBrowserSearchBlockReason,
}
