/**
 * MODULE: Agent Skill Hub。
 * 职责: 提供本地 Skill 市场式检索、启用和禁用能力。
 * 边界: 不下载远程内容、不执行 Skill、不修改 Skill 文件。
 * 状态: 无。
 */
const { listAgentSkills } = require('./skills') as typeof import('./skills')
const agentConfig = require('./config') as typeof import('./config')

interface SkillHubBaseItem {
  name: string
  kind: string
  description?: string
}

type SkillHubItem = SkillHubBaseItem & { enabled: boolean }

function normalizeSkillName(name: unknown): string {
  return String(name || '').trim()
}

function listSkillHubItems(query: unknown = ''): SkillHubItem[] {
  const keyword = normalizeSkillName(query).toLowerCase()
  const enabled = new Set(agentConfig.getEnabledSkills())
  return listAgentSkills()
    .filter(skill => {
      if (!keyword) return true
      return [skill.name, skill.kind, skill.description].some(value => String(value || '').toLowerCase().includes(keyword))
    })
    .map(skill => ({ ...skill, enabled: enabled.has(skill.name) }))
}

function findSkillHubItem(name: unknown): SkillHubBaseItem | null {
  const target = normalizeSkillName(name)
  if (!target) return null
  return listAgentSkills().find(skill => skill.name === target) || null
}

async function setSkillHubEnabled(name: unknown, enabled: unknown): Promise<SkillHubItem> {
  const skill = findSkillHubItem(name)
  if (!skill) throw new Error(`未知 Agent Skill：${normalizeSkillName(name)}`)
  const config = agentConfig.getAgentConfig()
  const current = new Set(config.enabledSkills || [])
  if (enabled) current.add(skill.name)
  else current.delete(skill.name)
  config.enabledSkills = Array.from(current).slice(0, 32)
  await agentConfig.saveAgentConfig(config)
  return { ...skill, enabled: !!enabled }
}

function formatSkillHubItems(items: SkillHubItem[] = []): string {
  if (!items.length) return '未找到 Agent Skill。'
  return items.map(skill => `${skill.enabled ? '✅' : '□'} ${skill.name}（${skill.kind}）：${skill.description || '无描述'}`).join('\n')
}

export = { listSkillHubItems, findSkillHubItem, setSkillHubEnabled, formatSkillHubItems }
