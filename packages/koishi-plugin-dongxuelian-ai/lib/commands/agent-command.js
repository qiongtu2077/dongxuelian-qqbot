/**
 * MODULE: Agent QQ 命令路由。
 * 边界: 只处理工具管理、显式 Agent 对话和待确认命令；不写 conversation，不直接调聊天 API。
 * 状态: 无自有 Map/Cache；工具、队列、统计和 pending 状态由 agent/* 模块管理。
 */

const {
  hasAdminPermission,
  sanitizeUserInput,
  sanitizeUserName,
  isJailbreakAttempt,
  pickJailbreakFallbackReply,
} = require('../core/utils')
const { handled, notHandled } = require('./command-result')

async function handleAgentCommand(session, ctx, state, options = {}) {
  const { plain, channelKey, currentUserId, adminCommandMatched } = state
  const mode = options.mode || 'all'

  if (mode !== 'runtime') {
    const toolModeMatch = plain.match(/^(?:东雪莲)?工具模式\s+(auto|confirm|block|config)$/)
    if (toolModeMatch) {
      if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
      const m = toolModeMatch[1]
      require('../agent/safety').setMode(m)
      const labels = { auto: '自动执行', confirm: '需确认', block: '已禁止', config: '跟随配置' }
      return handled(`工具安全模式：${labels[m]} (${m})`)
    }

    const toolRouteMatch = plain.match(/^(?:东雪莲)?工具自动路由\s*(开|关|on|off)$/)
    if (toolRouteMatch) {
      if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
      const enabled = /^(?:开|on)$/i.test(toolRouteMatch[1])
      const agentConfig = require('../agent/config')
      const config = agentConfig.getAgentConfig()
      config.autoRoute.qq.enabled = enabled
      await agentConfig.saveAgentConfig(config)
      return handled(`QQ Agent 自动路由：${enabled ? '开启' : '关闭'}`)
    }

    const toolSwitchMatch = plain.match(/^(?:东雪莲)?工具开关\s+(qq|dashboard)\s+([a-zA-Z0-9_-]+)\s+(开|关|on|off)$/)
    if (toolSwitchMatch) {
      if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
      const [, channel, toolName, rawEnabled] = toolSwitchMatch
      if (channel === 'qq' && /^(?:execute_shell|read_file|list_files|find_files|write_file|edit_file|append_file|grep_search|execute_javascript|browser_action|query_logs)$/i.test(toolName)) {
        return handled('QQ Agent 不允许开启服务器/文件/浏览器高权限工具；请在 Agent Console 使用 Dashboard Agent，并通过审批执行危险操作。')
      }
      const enabled = /^(?:开|on)$/i.test(rawEnabled)
      const registry = require('../agent/tools/registry')
      if (!registry.toolRegistry[toolName]) return handled(`未知工具：${toolName}`)
      await require('../agent/config').setToolEnabled(channel, toolName, enabled)
      return handled(`${channel} 工具 ${toolName}：${enabled ? '开启' : '关闭'}`)
    }

    const skillSwitchMatch = plain.match(/^(?:东雪莲)?工具Skill\s+(开|关|on|off)\s+(.+)$/i)
    if (skillSwitchMatch) {
      if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
      const enabled = /^(?:开|on)$/i.test(skillSwitchMatch[1])
      const skillName = skillSwitchMatch[2].trim()
      const skillHub = require('../agent/skill-hub')
      try {
        const skill = await skillHub.setSkillHubEnabled(skillName, enabled)
        return handled(`Agent Skill ${skill.name}：${enabled ? '启用' : '禁用'}`)
      } catch (error) {
        return handled(error.message || `未知 Agent Skill：${skillName}`)
      }
    }

    if (/^(?:东雪莲)?工具Skill\s*(?:列表|list)?$/i.test(plain)) {
      const skills = require('../agent/skill-hub').listSkillHubItems().slice(0, 20)
      if (skills.length === 0) return handled('暂无 Agent Skill。')
      return handled(require('../agent/skill-hub').formatSkillHubItems(skills))
    }

    if (/^(?:东雪莲)?工具状态$/.test(plain)) {
      const safety = require('../agent/safety')
      const agentConfig = require('../agent/config').getAgentConfig()
      const stats = require('../agent/stats').getStats()
      const registry = require('../agent/tools/registry')
      const qqTools = registry.getToolDefinitions('qq').map(item => item.function.name).join(', ') || '无'
      const dashboardTools = registry.getToolDefinitions('dashboard').map(item => item.function.name).join(', ') || '无'
      return handled([
        `工具安全模式：${safety.getMode()}（危险工具策略：${agentConfig.dangerousPolicy}）`,
        `QQ Agent：${agentConfig.channels.qq.enabled ? '开启' : '关闭'} / 自动路由：${agentConfig.autoRoute?.qq?.enabled ? '开启' : '关闭'} / ${qqTools}`,
        `Dashboard Agent：${agentConfig.channels.dashboard.enabled ? '开启' : '关闭'} / ${dashboardTools}`,
        `可注册工具：${registry.getToolCount()} 个`,
        `累计调用：${stats.total} 次`,
        stats.total > 0 ? `最近：${stats.recent.slice(0, 3).map(c => c.tool).join(', ')}` : '',
      ].filter(Boolean).join('\n'))
    }

    if (mode === 'management') return notHandled()
  }

  if (mode === 'management') return notHandled()

  const agentMatch = plain.match(/^莲莲\s*(?:工具|agent)\s+(.+)/i)
  if (agentMatch && !adminCommandMatched) {
    const query = agentMatch[1].trim()
    if (isJailbreakAttempt(sanitizeUserInput(query))) return handled(pickJailbreakFallbackReply())
    const engine = require('../agent/engine')
    const agentConfig = require('../agent/config').getAgentConfig()
    const agentQueue = require('../agent/queue')
    agentQueue.configureAgentQueue(agentConfig.queue || {})
    const userName = sanitizeUserName(
      session.author?.nick || session.author?.name || session.username || '群友'
    )
    const isAdmin = hasAdminPermission(session)
    try {
      const searchRunOptions = require('../agent/router').buildExplicitSearchRunOptions(query)
      const result = await agentQueue.enqueueAgentTask({
        channelKey,
        userId: currentUserId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        fn: () => engine.run({
          userMessage: query, userName, userId: currentUserId, channelKey, channel: 'qq', bot: session.bot, isAdmin, ...searchRunOptions,
          onProgress: (msg) => {
            if (msg.type === 'round' && msg.round === 0) {
              // 首轮执行中，不额外输出
            }
          },
        }),
      })
      return handled(result.reply || '(Agent 未获取有效回复)')
    } catch (err) {
      if (err && (err.code === 'AGENT_QUEUE_FULL' || err.code === 'AGENT_QUEUE_REJECTED')) return handled(err.message)
      ctx.logger('dongxuelian-ai').warn(`agent engine failed: ${err.message}`)
      return handled('Agent 暂时不可用。')
    }
  }

  const confirmToolMatch = plain.match(/^(?:确认工具|y|Y)(?:\s+(pnd[0-9a-z]+))?$/i)
  if (confirmToolMatch) {
    const pendingId = confirmToolMatch[1] || ''
    const pending = require('../agent/pending')
    const findPendingById = pending.findPendingToolById || pending.getPendingToolById || (id => (pending.listPendingTools && pending.listPendingTools().find(item => item.id === id)) || null)
    const p = pendingId ? findPendingById(pendingId) : pending.getPendingTool(channelKey, currentUserId)
    if (p) {
      if (p.channelKey !== channelKey || p.userId !== currentUserId) return handled('这个确认 ID 不属于当前会话。')
      const engine = require('../agent/engine')
      const result = await engine.resumePending({ channelKey, userId: currentUserId, channel: 'qq', expectedId: pendingId, bot: session.bot, isAdmin: hasAdminPermission(session) })
      if (!result.ok && result.message) return handled(`执行失败：${result.message || result.error || '未知错误'}`)
      return handled(result.reply || '(Agent 未获取到有效回复)')
    }
    if (pendingId) return handled('没有匹配的待确认工具。')
  }

  return notHandled()
}

module.exports = {
  handleAgentCommand,
}
