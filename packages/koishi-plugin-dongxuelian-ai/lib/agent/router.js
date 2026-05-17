/**
 * MODULE: Agent 自动路由判定。
 * 职责: 判断是否需要进入 Agent 工具链（仅显式搜索请求）。
 * 边界: 不执行工具、不发送消息、不写对话历史。
 * 状态: 无。
 */
const { cleanExplicitSearchQuery, buildSearchQueries } = require('./search-query')
const { getAgentConfig } = require('./config')

const EXPLICIT_AGENT_RE = /(?:调用\s*(?:搜索工具|web_search)|web_search|上网查|联网查|联网搜索|网上查|搜一下|搜索一下|帮我查|查一下).{0,80}(?:最新|现在|当前|版本|角色|新闻|资料|是谁|是什么)|(?:最新角色|当前版本|现在是什么版本)/i
const EXPLICIT_SEARCH_RE = /(?:调用\s*(?:搜索工具|web_search)|web_search|上网查|联网查|联网搜索|网上查|搜一下|搜索一下|帮我查|查一下|最新角色|当前版本|现在是什么版本)/i

function heuristicRoute(userText = '', channel = 'qq') {
  const text = String(userText || '').trim()
  if (!text) return { useAgent: false, reason: 'empty' }
  if (EXPLICIT_AGENT_RE.test(text)) return { useAgent: true, reason: 'explicit-tool-request' }
  const config = getAgentConfig()
  const autoRoute = config.autoRoute && config.autoRoute[channel]
  if (!autoRoute || !autoRoute.enabled) return { useAgent: false, reason: 'auto-route-disabled' }
  return { useAgent: false, reason: 'chat-with-tools' }
}

function buildExplicitSearchRunOptions(userText = '') {
  if (!EXPLICIT_SEARCH_RE.test(String(userText || ''))) return {}
  return {
    systemExtra: [{ role: 'system', content: '用户明确要求联网搜索。必须先调用 web_search 获取最新信息。如果第一轮搜索没拿到可靠结果（只有标题/首页、正文太短、全是百科/字典），不要直接放弃，从已有结果中提取新关键词（如角色名、版本号、活动名），换 query 再搜一次，最多再搜 2 轮。可信度分 ≥ 50 的结果必须打开正文。只能根据工具结果回答，不要凭记忆回答。候选页足够可信时，要以工具打开到的候选网页正文为主要依据；只有标题/摘要时必须降低确信度。若工具结果为空、明显不相关、或主要是素材/模板/图片/下载站，必须说\u201c这次搜索没有拿到可靠结果\u201d，并简要说明搜索链路问题，不要编造答案。用户追问\u201c你怎么知道/是搜索到的吗\u201d时，要诚实说明依据来自本轮工具结果。不要混淆不同来源的信息，每个角色的属性必须关联到具体来源链接。注意：工具内部已实现自动重试和关键词提取，如果工具返回的结果标注为\u201c弱命中\u201d或\u201c未打开正文\u201d，你仍然可以再次调用 web_search 并传入从上次结果中提取的新关键词。' }],
    forceTools: ['web_search'],
  }
}

module.exports = { heuristicRoute, buildExplicitSearchRunOptions, isExplicitSearchRequest: (text = '') => EXPLICIT_SEARCH_RE.test(String(text || '')) }
