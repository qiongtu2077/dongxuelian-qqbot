/**
 * MODULE: QQ Agent retell guard.
 * Keeps Agent output routed through chat persona while preventing failed tool
 * reports from being retold as fabricated success.
 */

const SEARCH_FAILURE_RE = /(?:搜索失败|未提取到有效搜索结果|没有拿到可靠结果|没有返回可靠来源|没有返回可用结果|没有找到可靠结果|无可靠结果|结果质量过低|搜索页结果抽取失败|API 搜索请求失败|API 搜索没有返回可靠来源|API 联网搜索不可用|轻量 HTTP 搜索未拿到可靠结果)/i
const SEARCH_SUCCESS_RE = /(?:搜索结果：|打开候选网页继续读取|【来源\s*\d+】|可信度分：|https?:\/\/|官方公告|来源[:：]|URL[:：])/i
const FAILURE_REPLY_RE = /(?:没(?:有)?(?:拿到|查到|找到|搜到)|未(?:提取|找到|查到|搜到)|搜索失败|查不到|搜不到|结果不可靠|可靠结果|有效结果|没法确认|不能确认|不确定)/i

function collectAgentMaterial(agentResult = {}) {
  const parts = []
  if (agentResult && agentResult.reply) parts.push(String(agentResult.reply))
  for (const item of Array.isArray(agentResult && agentResult.toolResults) ? agentResult.toolResults : []) {
    if (!item) continue
    if (item.name) parts.push(`[${item.name}]`)
    if (item.result) parts.push(String(item.result))
  }
  return parts.join('\n').trim()
}

function hasSearchFailureMaterial(agentResult = {}) {
  const material = collectAgentMaterial(agentResult)
  if (!material) return false
  return SEARCH_FAILURE_RE.test(material) && !SEARCH_SUCCESS_RE.test(material)
}

function replyAcknowledgesSearchFailure(reply = '') {
  return FAILURE_REPLY_RE.test(String(reply || ''))
}

function buildSearchFailureRetellFallback() {
  return '这次没有拿到可靠结果，我就不硬编了。'
}

function guardAgentRetellReply(reply = '', agentResult = {}) {
  const value = String(reply || '').trim()
  if (!hasSearchFailureMaterial(agentResult)) return value
  if (replyAcknowledgesSearchFailure(value)) return value
  return buildSearchFailureRetellFallback()
}

module.exports = {
  collectAgentMaterial,
  hasSearchFailureMaterial,
  replyAcknowledgesSearchFailure,
  buildSearchFailureRetellFallback,
  guardAgentRetellReply,
}
