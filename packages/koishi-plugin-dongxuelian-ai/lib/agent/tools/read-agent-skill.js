/**
 * MODULE: Agent Skill 读取工具。
 * 职责: 读取已登记 Skill 的入口文档或同目录参考文件。
 * 边界: 不读取任意本地文件、不执行 Skill、不修改配置。
 * 状态: 无。
 */
const { readAgentSkill, findRelevantAgentSkills } = require('../skills')
const { getEnabledSkills } = require('../config')

function isSkillEnabled(name, context = {}) {
  if (context.channel === 'dashboard' && context.autoRelevantSkill !== false) return true
  const target = String(name || '').trim().toLowerCase()
  if (!target) return false
  if (getEnabledSkills().some(item => String(item || '').trim().toLowerCase() === target)) return true
  const relevant = findRelevantAgentSkills(context.userMessage || '', { limit: 8 })
  return relevant.some(skill => String(skill.name || '').trim().toLowerCase() === target)
}

module.exports = {
  definition: {
    name: 'read_agent_skill',
    description: '读取已启用 Skill 的完整说明或参考文件。只允许读取 ai-skills/docs 与 lore 中登记过的 Skill 文档。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称，例如 QA_source_index、pptx、pdf、docx、browser_cdp' },
        file: { type: 'string', description: '可选，同一 Skill 目录内的相对参考文件路径；默认读取入口 SKILL.md' },
        maxChars: { type: 'number', description: '最多返回字符数，默认 12000，最大 24000' },
      },
      required: ['name'],
    },
  },
  async execute(params = {}, context = {}) {
    if (!isSkillEnabled(params.name, context)) throw new Error(`Agent Skill 未启用：${String(params.name || '').trim()}`)
    const result = readAgentSkill(params.name, { file: params.file, maxChars: params.maxChars })
    const lines = [
      `Skill：${result.name}（${result.kind}）`,
      `说明：${result.description || '无描述'}`,
      `文件：${result.file}`,
    ]
    if (result.references.length) lines.push(`可读取参考文件：${result.references.join(', ')}`)
    lines.push(`正文${result.truncated ? `（已截断，${result.chars} 字）` : `（${result.chars} 字）`}：`)
    lines.push(result.content)
    if (result.truncated) lines.push(`\n如需后续内容，请用更具体的参考文件或提高 maxChars（最多 24000）。`)
    return lines.join('\n')
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
