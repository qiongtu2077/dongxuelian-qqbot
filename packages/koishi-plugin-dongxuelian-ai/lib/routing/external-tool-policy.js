/**
 * MODULE: External tool policy.
 * 职责: 判断当前用户消息是否明确禁止联网/检索/读链接。
 * 边界: 只做无状态文本判断，不执行工具、不读写文件。
 * 状态: 无。
 */

const EXTERNAL_TOOL_DENY_RE = /(?:禁止|不要|别|无需|不用|不准|不许|别用|不要用|不进行|不要进行|禁止进行).{0,16}(?:联网|外部检索|外部搜索|上网|搜索|搜|检索|查网页|查资料|web_search|web_fetch|fetch)|(?:不要|别|不用|无需|禁止).{0,8}(?:查|搜|搜索|联网|检索)|(?:凭你自己|用常识|靠常识|别查|不用查|不要查|不要搜|别搜).{0,18}(?:回答|告诉我|说|聊|就行|即可)?/i

function externalToolsDenied(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return false
  return EXTERNAL_TOOL_DENY_RE.test(value)
}

function filterExternalToolDefinitions(tools = [], text = '') {
  const list = Array.isArray(tools) ? tools : []
  if (!externalToolsDenied(text)) return list
  return list.filter(item => {
    const name = item && item.function && item.function.name
    return name !== 'web_search' && name !== 'web_fetch'
  })
}

function buildExternalToolPolicyHint(text = '') {
  if (!externalToolsDenied(text)) return ''
  return '用户当前明确要求不要联网、不要外部检索或直接回答。本轮必须尊重：不要调用 web_search/web_fetch，不要说“换个工具”，直接基于已有知识和当前上下文回答；如果信息可能过期，只简短说明未做实时核验。'
}

module.exports = {
  externalToolsDenied,
  filterExternalToolDefinitions,
  buildExternalToolPolicyHint,
}
