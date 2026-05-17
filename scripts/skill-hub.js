#!/usr/bin/env node
/**
 * MODULE: Agent Skill Hub CLI。
 * 职责: 暴露本地 Agent Skill 市场的 list/search/enable/disable 命令。
 * 边界: 不下载远程内容、不执行 Skill。
 * 状态: 无。
 */
const hub = require('../packages/koishi-plugin-dongxuelian-ai/lib/agent/skill-hub')

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  if (!command || command === 'list') {
    process.stdout.write(hub.formatSkillHubItems(hub.listSkillHubItems(rest.join(' '))) + '\n')
    return
  }
  if (command === 'search') {
    process.stdout.write(hub.formatSkillHubItems(hub.listSkillHubItems(rest.join(' '))) + '\n')
    return
  }
  if (command === 'enable' || command === 'disable') {
    const name = rest.join(' ').trim()
    if (!name) throw new Error(`用法：node scripts/skill-hub.js ${command} <skill-name>`)
    const skill = await hub.setSkillHubEnabled(name, command === 'enable')
    process.stdout.write(`${skill.name}：${skill.enabled ? '启用' : '禁用'}\n`)
    return
  }
  throw new Error('用法：node scripts/skill-hub.js list|search <keyword>|enable <skill-name>|disable <skill-name>')
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}

module.exports = { main }
