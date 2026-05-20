/**
 * MODULE: Agent 长期记忆命令。
 * 边界: 只处理 QQ 命令匹配、权限校验和 agent/memory 调用；不写 conversation，不调聊天模型。
 * 状态: 无自有 Map/Cache；记忆存储和配置状态由 agent/memory 与 agent/config 管理。
 */

const { hasAdminPermission } = require('../utils')
const { handled, notHandled } = require('./command-result')

async function handleMemoryCommand(session, state) {
  const { plain, channelKey, currentUserId } = state

  const memoryRememberMatch = plain.match(/^(?:莲莲记住|\/memory\s+remember)\s+(.+)/i)
  if (memoryRememberMatch) {
    const agentConfig = require('../agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能写入 Agent 长期记忆。')
    try {
      const item = await require('../agent/memory').remember({
        userId: currentUserId,
        channelKey,
        text: memoryRememberMatch[1].trim(),
      })
      return handled(`已记住：${item.id}`)
    } catch (err) {
      return handled(err.message || '记忆写入失败。')
    }
  }

  const memorySearchMatch = plain.match(/^(?:莲莲回忆|\/memory\s+search)\s*(.*)$/i)
  if (memorySearchMatch) {
    const agentConfig = require('../agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能检索 Agent 长期记忆。')
    try {
      const memory = require('../agent/memory')
      const items = await memory.searchMemory({
        userId: currentUserId,
        channelKey,
        query: memorySearchMatch[1].trim(),
        limit: 8,
      })
      return handled(memory.formatMemoryItems(items))
    } catch (err) {
      return handled(err.message || '记忆检索失败。')
    }
  }

  const memoryListMatch = plain.match(/^(?:莲莲记忆列表|\/memory\s+list)(?:\s+(\d+))?$/i)
  if (memoryListMatch) {
    const agentConfig = require('../agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能查看 Agent 长期记忆。')
    try {
      const memory = require('../agent/memory')
      return handled(memory.formatMemoryItems(await memory.listMemory({ userId: currentUserId, limit: memoryListMatch[1] || 20 })))
    } catch (err) {
      return handled(err.message || '记忆列表读取失败。')
    }
  }

  const memoryForgetMatch = plain.match(/^(?:莲莲忘记|\/memory\s+forget)\s+(mem_[a-zA-Z0-9_-]+)/i)
  if (memoryForgetMatch) {
    const agentConfig = require('../agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能删除 Agent 长期记忆。')
    try {
      const removed = await require('../agent/memory').forgetMemory({ userId: currentUserId, memoryId: memoryForgetMatch[1] })
      return handled(removed ? '已删除这条记忆。' : '没有找到这条记忆。')
    } catch (err) {
      return handled(err.message || '记忆删除失败。')
    }
  }

  return notHandled()
}

module.exports = {
  handleMemoryCommand,
}
