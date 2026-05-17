/**
 * MODULE: Agent 记忆工具。
 * 职责: 将显式长期记忆读写能力暴露给 Agent。
 * 边界: 不自动写入聊天、不越过 Agent 工具渠道/权限配置。
 * 状态: 无。
 */
const memory = require('../memory')

function getUserId(context = {}) {
  return String(context.userId || 'dashboard')
}

const rememberMemoryTool = {
  definition: {
    name: 'remember_memory',
    description: '为当前用户显式写入一条长期记忆。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      },
      required: ['text'],
    },
  },
  async execute(params = {}, context = {}) {
    const item = await memory.remember({ userId: getUserId(context), channelKey: context.channelKey, text: params.text, tags: params.tags })
    return `已记住：${item.id}`
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}

const searchMemoryTool = {
  definition: {
    name: 'search_memory',
    description: '搜索当前用户的长期记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  async execute(params = {}, context = {}) {
    const channel = context.channel || 'qq'
    if (channel === 'dashboard') {
      const dashResult = await memory.searchDashboardMemory({ userId: getUserId(context), query: params.query })
      if (dashResult) return dashResult
      return '没有找到相关记忆。'
    }
    const items = await memory.searchMemory({ userId: getUserId(context), channelKey: context.channelKey, query: params.query, limit: params.limit })
    return memory.formatMemoryItems(items)
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}

const forgetMemoryTool = {
  definition: {
    name: 'forget_memory',
    description: '删除当前用户的一条长期记忆。',
    parameters: {
      type: 'object',
      properties: { memoryId: { type: 'string' } },
      required: ['memoryId'],
    },
  },
  async execute(params = {}, context = {}) {
    const removed = await memory.forgetMemory({ userId: getUserId(context), memoryId: params.memoryId })
    return removed ? `已删除记忆：${params.memoryId}` : '没有找到这条记忆。'
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}

const listMemoryTool = {
  definition: {
    name: 'list_memory',
    description: '列出当前用户最近的长期记忆。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  async execute(params = {}, context = {}) {
    const items = await memory.listMemory({ userId: getUserId(context), limit: params.limit })
    return memory.formatMemoryItems(items)
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}

module.exports = {
  rememberMemoryTool,
  searchMemoryTool,
  forgetMemoryTool,
  listMemoryTool,
  tools: [rememberMemoryTool, searchMemoryTool, forgetMemoryTool, listMemoryTool],
}
