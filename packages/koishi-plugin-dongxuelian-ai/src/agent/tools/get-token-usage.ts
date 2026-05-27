/**
 * MODULE: Agent token/调用统计查询工具。
 */
interface ToolDetailStats {
  total: number
  successRate: number
  avgDurationMs: number
  avgTokens: number
}

interface AgentStats {
  total: number
  successRate: number
  success: number
  failed: number
  totalTokens: number
  avgTokens: number
  avgDurationMs: number
  byChannel: {
    qq?: number
    dashboard?: number
  }
  byToolDetail?: Record<string, ToolDetailStats>
}

const { getStats } = require('../stats') as typeof import('../stats')

async function executeGetTokenUsage(): Promise<string> {
  const stats = getStats()
  const lines = [
    `累计调用：${stats.total}`,
    `成功率：${stats.successRate}%（成功 ${stats.success} / 失败 ${stats.failed}）`,
    `估算 token：${stats.totalTokens}，平均 ${stats.avgTokens}/次`,
    `平均耗时：${stats.avgDurationMs}ms`,
    `渠道：QQ ${stats.byChannel.qq || 0} / Dashboard ${stats.byChannel.dashboard || 0}`,
  ]
  const toolLines = Object.entries(stats.byToolDetail || {}).map(([name, item]) => `- ${name}: ${item.total} 次，成功率 ${item.successRate}%，平均 ${item.avgDurationMs}ms / ${item.avgTokens} tokens`)
  if (toolLines.length) lines.push('按工具：\n' + toolLines.join('\n'))
  return lines.join('\n')
}

export = {
  definition: {
    name: 'get_token_usage',
    description: '查询 Agent 工具调用统计和估算 token 使用。',
    parameters: { type: 'object', properties: {} },
  },
  execute: executeGetTokenUsage,
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
