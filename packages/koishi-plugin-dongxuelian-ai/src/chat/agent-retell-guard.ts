/**
 * MODULE: QQ Agent retell guard.
 * Keeps Agent output routed through chat persona while preventing failed tool
 * reports from being retold as fabricated success.
 */

const SEARCH_FAILURE_RE: RegExp = /(?:搜索失败|weak_hit|弱命中|未提取到有效搜索结果|没有拿到可靠结果|没有返回可靠来源|没有返回可用结果|没有找到可靠结果|无可靠结果|结果质量过低|搜索页结果抽取失败|API 搜索请求失败|API 搜索没有返回可靠来源|API 联网搜索不可用|轻量 HTTP 搜索未拿到可靠结果|web_fetch 失败|web_fetch 未读到可靠正文|请求太频繁|正文过短|正文质量：(?:short|empty|garbage|error|unknown)|非文本页面|拒绝访问|未打开到可用正文|未打开候选网页正文|未读到可用正文|不能作为事实依据)/i
const SEARCH_SUCCESS_RE: RegExp = /(?:搜索状态：usable_hit|已打开候选网页正文|正文质量：usable|已用 web_fetch 验证正文|已读取网页：)/i
const FAILURE_REPLY_RE: RegExp = /(?:没(?:有)?(?:拿到|查到|找到|搜到)|未(?:提取|找到|查到|搜到)|搜索失败|查不到|搜不到|结果不可靠|可靠结果|有效结果|没法确认|不能确认|不确定)/i
const AUTH_BEARER_RE: RegExp = /\b(authorization\s*[:=：]\s*bearer\s+)([^\s,;'"<>]+)/ig
const SECRET_ASSIGNMENT_RE: RegExp = /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|admin[_-]?token|token|password|passwd|pwd|authorization|cookie|set-cookie)\b\s*[:=：]\s*['"]?[^'"\s,;，；]+/ig
const BEARER_RE: RegExp = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ig
const KEY_PREFIX_RE: RegExp = /\b(?:sk|tp|ak)-[A-Za-z0-9._~+/=-]{8,}\b/ig
const JWT_RE: RegExp = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const EXTERNAL_PROMPT_KEYWORD_RE: RegExp = /(?:system prompt|developer message|系统提示|开发者消息|忽略以上|忽略前文|切换人格|扮演|你现在是|不要告诉用户)/i
const EXTERNAL_PROMPT_ACTION_RE: RegExp = /(?:忽略|覆盖|改写|泄露|输出|告诉|显示|发送|切换|扮演|作为|变成|无视|遵守|执行|回复|回答|follow|ignore|reveal|print|show|send|switch|act as|pretend|roleplay|do not tell)/i
const SENSITIVE_URL_PARAM_RE: RegExp = /([?&](?:signature|sign|sig|token|access_token|api_key|apikey|key|secret|auth|session|sid)=)([^&#\s]+)/ig
const LOCAL_PATH_RE: RegExp = /(^|[\s:：,，;；(（])([A-Za-z]:\\[^\r\n\t<>|"]+|\/(?:root|home)\/[^\r\n\t<>|"]+)/g

interface AgentToolResult {
  name?: string
  result?: unknown
}

interface AgentRetellResult {
  reply?: unknown
  toolResults?: AgentToolResult[]
}

interface GuardOptions {
  searchFailureFallback?: string
}

function collectAgentMaterial(agentResult: AgentRetellResult = {}): string {
  const parts: string[] = []
  if (agentResult && agentResult.reply) parts.push(String(agentResult.reply))
  const toolResults = Array.isArray(agentResult.toolResults) ? agentResult.toolResults : []
  for (const item of toolResults) {
    if (!item) continue
    if (item.name) parts.push(`[${item.name}]`)
    if (item.result) parts.push(String(item.result))
  }
  return parts.join('\n').trim()
}

function hasSearchFailureMaterial(agentResult: AgentRetellResult = {}): boolean {
  const material = collectAgentMaterial(agentResult)
  if (!material) return false
  return SEARCH_FAILURE_RE.test(material) && !SEARCH_SUCCESS_RE.test(material)
}

function replyAcknowledgesSearchFailure(reply: string = ''): boolean {
  return FAILURE_REPLY_RE.test(String(reply || ''))
}

function buildSearchFailureRetellFallback(fallback: string = ''): string {
  const value = String(fallback || '').trim()
  return value || '这次搜索没有拿到可靠结果。'
}

function shouldFilterAgentMaterialLine(line: string = ''): boolean {
  const value = String(line || '')
  if (!EXTERNAL_PROMPT_KEYWORD_RE.test(value)) return false
  if (/^(?:system prompt|developer message|系统提示|开发者消息)\s*[:：]/i.test(value.trim())) return true
  return EXTERNAL_PROMPT_ACTION_RE.test(value)
}

function filterExternalPromptLines(text: string = ''): string {
  return String(text || '').split(/\r?\n/).map(line => (
    shouldFilterAgentMaterialLine(line) ? '[已过滤外部指令/提示词]' : line
  )).join('\n')
}

function redactLocalPathMatch(_match: string, prefix: string): string {
  return `${prefix}[本地路径]`
}

function redactAgentMaterial(text: string = ''): string {
  const value = String(text || '')
    .replace(AUTH_BEARER_RE, '$1[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(SECRET_ASSIGNMENT_RE, (match) => {
      const key = String(match).split(/[:=：]/)[0] || 'secret'
      return `${key}: [redacted]`
    })
    .replace(KEY_PREFIX_RE, '[redacted-key]')
    .replace(JWT_RE, '[redacted-token]')
    .replace(SENSITIVE_URL_PARAM_RE, '$1[redacted]')
    .replace(LOCAL_PATH_RE, redactLocalPathMatch)
  return filterExternalPromptLines(value)
}

function guardAgentRetellReply(reply: string = '', agentResult: AgentRetellResult = {}, options: GuardOptions = {}): string {
  const value = redactAgentMaterial(String(reply || '').trim())
  if (!hasSearchFailureMaterial(agentResult)) return value
  if (replyAcknowledgesSearchFailure(value)) return value
  return buildSearchFailureRetellFallback(options.searchFailureFallback)
}

export = {
  collectAgentMaterial,
  hasSearchFailureMaterial,
  replyAcknowledgesSearchFailure,
  buildSearchFailureRetellFallback,
  shouldFilterAgentMaterialLine,
  redactAgentMaterial,
  guardAgentRetellReply,
}
