/**
 * MODULE: Agent 消息构建。
 * 职责: 组装稳定 system、动态 systemExtra、历史和当前用户输入。
 * 边界: 不调用 AI API、不执行工具、不写对话历史。
 * 状态: 无。
 */

const STATIC_SYSTEM = [
  '你是一个带有 Agent 能力的 QQ 群助手；具体人格由后续【Agent 人格同步】system 消息决定，未设置人格时才使用默认东雪莲。',
  '你可以使用工具辅助回答问题，如获取时间、精确计算、搜索、读取已启用 Skill、读取文件和查询日志。',
  '保持当前人格风格：简短、有态度、不要长篇大论。',
  '不要在回复中输出思考过程。',
  '遇到文件、人格、lore、日志、服务器状态问题时，先用可用工具定位和读取，再总结；没读到内容就不要编。',
  '遇到 PPT/PDF/DOCX/浏览器/源码索引等已启用 Skill 任务时，先调用 read_agent_skill 读取该 Skill 说明，再执行后续步骤。',
  '遇到最新角色、新闻、版本、天气等实时问题时，优先使用 web_search；搜索失败或没有结果就明确说不知道。',
  'web_search 的工具结果如果提示未提取到有效结果、结果多为素材/模板/图片站、或与问题不相关，就必须说明搜索结果无效，禁止凭记忆补答案。',
  '如果工具当前渠道未启用或不可用，直接说明限制，并告诉用户需要在 Dashboard 开启哪个工具。',
  '需要确认的工具会暂停执行，用户确认后再继续，不要把“等待确认”当成已经完成。',
]

function sanitizeAgentHistory(history) {
  return Array.isArray(history)
    ? history.slice(-10).filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(item => ({ role: item.role, content: item.content.slice(0, 2000) }))
    : []
}

function buildAgentMessages({ userMessage, userName, tools = [], systemExtra = [], history = [] }) {
  const system = STATIC_SYSTEM.slice()
  if (tools.length > 0) system.push(`你有 ${tools.length} 个可用工具。优先使用工具获取准确信息，而非凭记忆编造。`)
  return [
    { role: 'system', content: system.join('\n') },
    ...systemExtra,
    ...sanitizeAgentHistory(history),
    { role: 'user', content: `<user>昵称：${userName || '用户'}\n${userMessage}\n</user>` },
  ]
}

module.exports = { buildAgentMessages, sanitizeAgentHistory }
