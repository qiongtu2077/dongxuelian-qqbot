/**
 * MODULE: Chat 轻量工具调用。
 * 职责: 定义 Chat 模式可用的轻量工具、执行逻辑、轻/重分流。
 * 边界: 不调用 AI API、不发送消息、不写对话历史。
 * 状态: 无。
 */
const { getMemorySummary } = require('./conversation')

const CHAT_TOOL_TIMEOUT_MS = 3000
const CHAT_TOOL_ANALYZE_TIMEOUT_MS = 25000
const CHAT_TOOLS_TOTAL_DEADLINE_MS = 5000

const LIGHTWEIGHT_TOOLS = new Set(['get_current_time', 'calculate', 'search_memory', 'read_image_history', 'analyze_historical_image'])

const HEAVY_TOOLS = new Set(['web_search', 'browser_action', 'execute_shell', 'file_write'])

function getChatToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: '获取当前日期和时间',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '计算数学表达式，支持加减乘除、幂运算、括号',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '数学表达式，如 123*456 或 (2+3)*5' } },
          required: ['expression'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description: '搜索对当前用户的记忆',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息（耗时较长，适合需要实时数据的问题）',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_image_history',
        description: '查看群聊最近出现的图片记录（URL + 时间戳 + 是否已分析）。已分析的图片会附带内容描述。',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: '返回最近几张，默认 5' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'analyze_historical_image',
        description: '分析群聊历史中某张未分析的图片。需要用户明确问到图片内容时才调用，不要主动调用。',
        parameters: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: '图片消息 ID（从 read_image_history 获取）' },
            question: { type: 'string', description: '用户关于这张图的问题' },
          },
          required: [],
        },
      },
    },
  ]
}
function isLightweightTool(name) {
  return LIGHTWEIGHT_TOOLS.has(name)
}

function isHeavyTool(name) {
  return HEAVY_TOOLS.has(name) || !LIGHTWEIGHT_TOOLS.has(name)
}

function executeGetCurrentTime() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 星期${weekdays[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function executeCalculate(args = {}) {
  const expr = String(args.expression || '').trim()
  if (!expr) return '请提供数学表达式'
  if (expr.length > 200) return '表达式过长'
  if (/[^0-9+\-*/().%^, \t]/.test(expr)) return '表达式包含不支持的字符'
  try {
    const sanitized = expr.replace(/\^/g, '**')
    const result = Function('"use strict"; return (' + sanitized + ')')()
    if (!Number.isFinite(result)) return '计算结果无效（可能除以零或溢出）'
    return String(result)
  } catch (e) {
    return '计算失败：' + (e.message || '表达式格式错误')
  }
}

async function executeSearchMemory(context = {}) {
  const { userId, channelKey } = context
  if (!userId || !channelKey) return '无法获取用户信息'
  const summary = await getMemorySummary(userId, channelKey)
  return summary || '没有找到相关记忆'
}

async function executeChatTool(toolCall, context = {}) {
  const name = toolCall?.function?.name || ''
  let args = {}
  try {
    args = JSON.parse(toolCall?.function?.arguments || '{}')
  } catch {}

  switch (name) {
    case 'get_current_time':
      return executeGetCurrentTime()
    case 'calculate':
      return executeCalculate(args)
    case 'search_memory':
      return executeSearchMemory(context)
    case 'read_image_history': {
      const { getRecentImages } = require('./image-store')
      const ck = context.channelKey || ''
      if (!ck) return '无法获取频道信息'
      const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 10)
      const images = getRecentImages(ck, limit)
      if (!images.length) return '最近没有图片记录。'
      return images.map((img, i) => {
        const time = new Date(img.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        const status = img.analyzed ? `已分析: ${(img.analysis || '').slice(0, 80)}` : '未分析'
        return `${i + 1}. [${time}] msgId=${img.messageId} ${status}`
      }).join('\n')
    }
    case 'analyze_historical_image': {
      const { getImageEntry, getCachedAnalysis } = require('./image-store')
      const { enqueueAnalysis } = require('./image-analyzer')
      const ck = context.channelKey || ''
      const msgId = String(args.messageId || '').trim()
      if (!ck || !msgId) return '需要提供 messageId（从 read_image_history 获取）。'
      const cached = getCachedAnalysis(ck, msgId)
      if (cached) return `图片内容：${cached}`
      const entry = getImageEntry(ck, msgId)
      if (!entry) return '找不到该图片记录。'
      enqueueAnalysis(ck, msgId)
      return '该图片正在后台分析中，稍后可通过 read_image_history 查看结果。'
    }
    default:
      return null
  }
}

async function handleChatToolCalls(toolCalls, context = {}) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return { results: [], heavyTools: [] }

  const results = []
  const heavyTools = []
  const deadline = Date.now() + CHAT_TOOLS_TOTAL_DEADLINE_MS

  for (const tc of toolCalls) {
    const name = tc?.function?.name || ''
    if (isHeavyTool(name)) {
      heavyTools.push(tc)
      continue
    }
    if (Date.now() >= deadline) break
    const timeout = name === 'analyze_historical_image' ? CHAT_TOOL_ANALYZE_TIMEOUT_MS : CHAT_TOOL_TIMEOUT_MS
    try {
      const resultPromise = executeChatTool(tc, context)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('tool timeout')), timeout)
      )
      const result = await Promise.race([resultPromise, timeoutPromise])
      results.push({ tool_call_id: tc.id, role: 'tool', content: String(result || '') })
    } catch {
      results.push({ tool_call_id: tc.id, role: 'tool', content: '工具执行失败' })
    }
  }

  return { results, heavyTools }
}

function getChatToolSystemHint(channelKey) {
  let hint = '你有辅助工具可用。只在确实需要时自主调用，不要告诉用户你使用了工具，把结果自然融入回复。大多数聊天不需要工具，直接回复即可。read_image_history 返回的图片分析结果只能作为聊天背景知识，绝对不能主动提起图片内容，只有用户明确问到图片时才可以引用。'
  if (channelKey) {
    try {
      const { getRecentImages } = require('./image-store')
      const recent = getRecentImages(channelKey, 10)
      if (recent.length > 0) {
        const analyzed = recent.filter(img => img.analyzed).length
        hint += `\n[图片上下文] 本群最近有${recent.length}张图片记录（${analyzed}张已分析）。如果用户提到"刚才的图"、"那张图"等，可用 read_image_history 查看。`
      }
    } catch {}
  }
  return hint
}

module.exports = {
  getChatToolDefinitions,
  isLightweightTool,
  isHeavyTool,
  executeChatTool,
  handleChatToolCalls,
  getChatToolSystemHint,
  CHAT_TOOLS_TOTAL_DEADLINE_MS,
}
