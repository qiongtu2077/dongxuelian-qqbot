/**
 * MODULE: Agent 消息构建。
 * 职责: 组装稳定 system、动态 systemExtra、历史和当前用户输入。
 * 边界: 不调用 AI API、不执行工具、不写对话历史。
 * 状态: 无。
 */

const STATIC_SYSTEM = [
  '你可以使用工具辅助回答问题，如获取时间、精确计算、搜索、读取已启用 Skill、读取文件和查询日志。',
  '保持当前人格风格：简短、有态度、不要长篇大论。',
  '不要在回复中输出思考过程。',
  '遇到文件、人格、lore、日志、服务器状态问题时，先用可用工具定位和读取，再总结；没读到内容就不要编。',
  '遇到需要特定工作流的任务时（如读文件/日志、制定计划、搜索、文档生成、浏览器、源码索引等），先调用 read_agent_skill 读取对应 Skill 说明，再执行后续步骤。Skill 索引列在 system 消息中，根据任务关键词选择对应的 Skill 名称。',
  '遇到最新角色、新闻、版本、天气等实时问题时，优先使用 web_search；如果 Skill 索引列出 web_search_strategy，先读取它；搜索失败或没有结果就换关键词、读来源正文；仍无可靠来源再明确说不知道。当你记忆中没有确切答案、信息可能已经过时、或训练数据不包含该内容时，也必须用 web_search 而不是凭记忆编造答案。',
  '搜索时不要只看标题和摘要；候选页足够可信时必须以正文内容为主要依据，搜索页摘要只能作为低确信度线索。',
  'web_search 的工具结果如果提示未提取到有效结果、结果多为素材/模板/图片站、或与问题不相关，就必须说明搜索结果无效，禁止凭记忆补答案。',
  '如果工具当前渠道未启用或不可用，直接说明限制，并告诉用户需要在 Dashboard 开启哪个工具。',
  '需要确认的工具会暂停执行，用户确认后再继续，不要把“等待确认”当成已经完成。',
]

function sanitizeAgentHistory(history) {
  return Array.isArray(history)
    ? history.slice(-10).filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(item => ({ role: item.role, content: item.content.slice(0, 2000) }))
    : []
}

function buildAgentMessages({ userMessage, userName, tools = [], systemExtra = [], history = [], agentMode = false }) {
  const system = STATIC_SYSTEM.filter(line =>
    !(agentMode && line.includes('保持当前人格风格'))
  )
  if (tools.length > 0) system.push(`你有 ${tools.length} 个可用工具。优先使用工具获取准确信息，而非凭记忆编造。`)
  return [
    { role: 'system', content: system.join('\n') },
    ...systemExtra,
    ...sanitizeAgentHistory(history),
    { role: 'user', content: `<user>昵称：${userName || '用户'}\n${userMessage}\n</user>` },
  ]
}

module.exports = { buildAgentMessages, sanitizeAgentHistory }
