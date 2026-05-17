/**
 * MODULE: Agent 搜索查询规划。
 * 职责: 规范化用户显式搜索请求，生成更可靠的搜索 query 和结果可信度排序。
 * 边界: 不执行联网搜索、不调用浏览器、不调用 AI API。
 * 状态: 无。
 */

const TRUSTED_DOMAIN_RULES = [
  { re: /(^|\.)9game\.cn$/i, score: 85, label: '资讯' },
  { re: /(^|\.)17173\.com$/i, score: 80, label: '资讯' },
  { re: /(^|\.)taptap\.cn$/i, score: 78, label: '平台' },
  { re: /(^|\.)bilibili\.com$/i, score: 72, label: '平台' },
  { re: /(^|\.)biligame\.com$/i, score: 72, label: '平台' },
  { re: /(^|\.)weibo\.com$/i, score: 68, label: '社媒' },
  { re: /(^|\.)kurogames\.com$/i, score: 60, label: '官方' },
  { re: /(^|\.)wutheringwaves\.kurogames\.com$/i, score: 55, label: '官方' },
  { re: /(^|\.)minecraft\.net$/i, score: 90, label: '官方' },
  { re: /(^|\.)mojang\.com$/i, score: 85, label: '官方' },
  { re: /(^|\.)gamekee\.com$/i, score: 50, label: '社区资料' },
  { re: /(^|\.)fandom\.com$/i, score: 30, label: '社区资料' },
]

const LOW_QUALITY_DOMAIN_RE = /(?:699pic|588ku|ibaotu|nipic|vcg|shutterstock|freepik|pngtree|58pic|lovepik|ooopic|素材|模板|壁纸|下载|图片|图库|站酷|千图|觅知|摄图|包图|昵图|推广|广告)/i
const WUWA_RE = /(?:鸣潮|wuthering\s*waves|wutheringwaves|库洛|kuro)/i
const MINECRAFT_RE = /(?:我的世界|minecraft|mojang)/i
const LATEST_ROLE_RE = /(?:最新|新|当前|现在).{0,8}(?:角色|共鸣者|卡池)|(?:角色|共鸣者).{0,8}(?:最新|新|是谁)/i
const LATEST_VERSION_RE = /(?:最新|当前|现在|更新|版本|update|release|snapshot|pre-release|正式版).{0,12}(?:版本|更新|版|version|update|release)|(?:版本|version).{0,12}(?:最新|当前|现在)/i
const GENERAL_LATEST_RE = /(?:最新|当前|现在|今天|新闻|资讯|公告|版本|更新|角色|卡池|release|released|update|latest|news|official|source)/i

function cleanExplicitSearchQuery(text = '') {
  return String(text || '')
    .replace(/(?:调用\s*(?:搜索工具|web_search)|web_search|上网查(?:一下|查)?|联网查(?:一下|查)?|联网搜索(?:一下)?|网上查(?:一下|查)?|搜一下|搜索一下|帮我查(?:一下|查)?|查一下)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function isWuwaLatestRoleQuery(query = '') {
  const value = String(query || '')
  return WUWA_RE.test(value) && LATEST_ROLE_RE.test(value)
}

function pushSearchQuery(queries, value) {
  const query = String(value || '').replace(/\s+/g, ' ').trim()
  if (query) queries.push(query)
}

function isMinecraftUpdateQuery(query = '') {
  const value = String(query || '')
  return MINECRAFT_RE.test(value) && /(?:最新|当前|现在|更新|版本|update|release|snapshot|pre-release|正式版|latest|version)/i.test(value)
}

function buildSearchQueries(rawQuery = '') {
  const query = cleanExplicitSearchQuery(rawQuery) || String(rawQuery || '').trim().slice(0, 180)
  const queries = []
  const year = new Date().getFullYear()
  if (isWuwaLatestRoleQuery(query)) {
    pushSearchQuery(queries, `鸣潮游戏 新角色 ${year}`)
    pushSearchQuery(queries, '鸣潮 新共鸣者 上线 公告')
    pushSearchQuery(queries, `Wuthering Waves new character ${year}`)
    pushSearchQuery(queries, '鸣潮 最新版本 新角色')
  }
  if (isMinecraftUpdateQuery(query)) {
    pushSearchQuery(queries, 'Minecraft latest update official release notes')
    pushSearchQuery(queries, `Minecraft latest version ${year} official`)
    pushSearchQuery(queries, 'Minecraft Java Edition latest release official')
  }
  if (!isWuwaLatestRoleQuery(query) && !isMinecraftUpdateQuery(query) && GENERAL_LATEST_RE.test(query)) {
    pushSearchQuery(queries, `${query} 官方 公告 来源`)
    pushSearchQuery(queries, `${query} 最新 官方`)
    if (/[a-z]/i.test(query)) pushSearchQuery(queries, `${query} official source latest`)
  }
  if (query) pushSearchQuery(queries, query)
  const seen = new Set()
  return queries.filter(item => {
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 4)
}

function getDirectSearchCandidates(query = '') {
  const value = String(query || '')
  const candidates = []
  if (WUWA_RE.test(value)) {
    candidates.push(
      {
        title: '鸣潮攻略资讯 - 九游',
        url: 'https://www.9game.cn/mingchao/',
        snippet: '鸣潮最新攻略、新角色、版本更新资讯。',
      },
      {
        title: '鸣潮新闻 - TapTap',
        url: 'https://www.taptap.cn/app/228783/topic',
        snippet: '鸣潮社区讨论、新角色爆料、版本前瞻。',
      },
      {
        title: '鸣潮官方新闻公告',
        url: 'https://wutheringwaves.kurogames.com/zh-Hans/main/news',
        snippet: '鸣潮官方新闻公告页面。',
      }
    )
  }
  if (MINECRAFT_RE.test(value)) {
    candidates.push(
      {
        title: 'Minecraft Official News',
        url: 'https://www.minecraft.net/en-us/articles',
        snippet: 'Minecraft official news, release notes and update articles.',
      },
      {
        title: 'Minecraft Release Changelogs',
        url: 'https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs',
        snippet: 'Official Minecraft release changelogs and version notes.',
      }
    )
  }
  return candidates
}

function getSearchHostname(url = '') {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function scoreSearchResult(item = {}, query = '') {
  const title = String(item.title || '')
  const snippet = String(item.snippet || item.text || '')
  const url = String(item.url || '')
  const host = getSearchHostname(url)
  let score = 0
  for (const rule of TRUSTED_DOMAIN_RULES) {
    if (rule.re.test(host)) score += rule.score
  }
  const haystack = `${title}\n${snippet}\n${url}`
  if (WUWA_RE.test(query) && WUWA_RE.test(haystack)) score += 20
  if (MINECRAFT_RE.test(query) && MINECRAFT_RE.test(haystack)) score += 20
  if (LATEST_ROLE_RE.test(query) && /(?:角色|共鸣者|卡池|公告|版本|前瞻|更新|新(?:角色|共鸣者))/.test(haystack)) score += 18
  if (LATEST_VERSION_RE.test(query) && /(?:版本|更新|release|released|update|snapshot|pre-release|changelog|patch notes)/i.test(haystack)) score += 18
  if (/官方|公告|新闻|资讯|版本|更新|前瞻|共鸣者/.test(haystack)) score += 12
  if (LOW_QUALITY_DOMAIN_RE.test(host) || LOW_QUALITY_DOMAIN_RE.test(title)) score -= 120
  if (/素材|模板|图片|壁纸|免抠|海报|设计|下载/.test(haystack)) score -= 60
  return score
}

function isLowQualitySearchResult(item = {}) {
  const host = getSearchHostname(item.url)
  const title = String(item.title || '')
  const text = `${title}\n${item.snippet || ''}\n${item.text || ''}`
  return LOW_QUALITY_DOMAIN_RE.test(host) || /素材|模板|免抠|图库|图片下载|设计素材/.test(text)
}

function sortSearchResults(results = [], query = '') {
  return results
    .map(item => ({ ...item, score: scoreSearchResult(item, query) }))
    .filter(item => !isLowQualitySearchResult(item) || item.score > 0)
    .sort((a, b) => b.score - a.score)
}

module.exports = {
  cleanExplicitSearchQuery,
  buildSearchQueries,
  getDirectSearchCandidates,
  isWuwaLatestRoleQuery,
  isMinecraftUpdateQuery,
  getSearchHostname,
  scoreSearchResult,
  isLowQualitySearchResult,
  sortSearchResults,
}
