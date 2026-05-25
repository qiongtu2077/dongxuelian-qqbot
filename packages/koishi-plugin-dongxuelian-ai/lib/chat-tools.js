/**
 * MODULE: Chat 轻量工具调用。
 * 职责: 定义 Chat 模式可用的轻量工具、执行逻辑、轻/重分流。
 * 边界: 不调用 AI API、不发送消息、不写对话历史。
 * 状态: 无。
 */
const { getMemorySummary } = require('./conversation')
const { readGroupContext } = require('./group-scene-index')
const { filterExternalToolDefinitions, buildExternalToolPolicyHint } = require('./external-tool-policy')
const { isToolEnabled } = require('./agent/config')

const CHAT_TOOL_TIMEOUT_MS = 3000
const CHAT_TOOL_ANALYZE_TIMEOUT_MS = 25000
const CHAT_TOOLS_TOTAL_DEADLINE_MS = 5000

const LIGHTWEIGHT_TOOLS = new Set(['get_current_time', 'calculate', 'search_memory', 'read_image_history', 'analyze_historical_image', 'read_group_context', 'analyze_file', 'create_uploaded_file_variant', 'create_reminder', 'list_reminders', 'cancel_reminder', 'create_scheduled_task', 'list_scheduled_tasks', 'get_scheduled_task', 'pause_scheduled_task', 'resume_scheduled_task', 'delete_scheduled_task', 'run_scheduled_task_now'])

const HEAVY_TOOLS = new Set(['web_search', 'web_fetch', 'browser_action', 'execute_shell', 'file_write'])

const DEFAULT_CHAT_TOOL_CHANNEL = 'qq'

function resolveChatToolChannel(options = {}) {
  return String(options.channel || options.toolChannel || DEFAULT_CHAT_TOOL_CHANNEL).trim() || DEFAULT_CHAT_TOOL_CHANNEL
}

function isChatToolAllowed(channel, name) {
  if (!name) return false
  return isToolEnabled(channel || DEFAULT_CHAT_TOOL_CHANNEL, name)
}

function getChatToolDefinitions(options = {}) {
  const tools = [
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
        description: '联网搜索实时或近期信息。用户问“最新/最近/当前/现在/热门/比较火/趋势/排行/推荐/版本更新/新角色/新闻/视频”等时间敏感内容，或你不确定答案是否会过期时，应先调用。',
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
        name: 'web_fetch',
        description: '读取用户提供的公开 http/https 链接正文。适合用户让你看链接、总结网页、核对网页内容或判断链接里写了什么；用户问视频/帖子/网页的评论区或外部反应时，也应先尝试工具判断能否拿到依据。没有具体 URL 时不要调用，改用 web_search。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要读取的公开 http/https URL' },
            maxChars: { type: 'number', description: '最多返回多少正文字符，可省略' },
          },
          required: ['url'],
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
        name: 'read_group_context',
        description: '只读检索当前群最近公开聊天片段。当前热窗口不够解释“刚才/之前/那个/这张图/那个文件/真的吗/评价一下”等短句或追问时再调用；结果是旧背景，只能帮助理解当前指代，不能主动翻旧话题。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要寻找的旧话题、对象或短句指代' },
            sceneId: { type: 'string', description: '可选，目录中的 scene id' },
            timeHint: { type: 'string', description: '可选，大致时间，例如刚才/十分钟前/01:50' },
            anchorType: { type: 'string', enum: ['any', 'message', 'bot_reply', 'image', 'file', 'voice'], description: '可选，想找的锚点类型' },
            maxAgeMinutes: { type: 'number', description: '最多回看多少分钟，随机回复默认应较小' },
            reason: { type: 'string', description: '为什么当前消息需要旧群聊上下文' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'analyze_file',
        description: '读取并分析当前会话里用户发送过的文件。只有用户明确问文件内容、文件里说了什么、读一下文件、总结刚才文件，或用“那个文件/里面”指向近期文件时才调用。不要主动翻旧文件。',
        parameters: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: '可选，文件消息 ID；不确定时留空让工具选择最近文件' },
            keyword: { type: 'string', description: '可选，文件名或用户提到的关键词' },
          },
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
    {
      type: 'function',
      function: {
        name: 'create_reminder',
        description: '创建一次性提醒。用户明确要求“几分钟后提醒我/明天提醒/到点叫我”时调用；不要在闲聊或随机主动回复中调用。',
        parameters: {
          type: 'object',
          properties: {
            delayMinutes: { type: 'number', description: '多少分钟后提醒，例如 10' },
            dueAt: { type: 'string', description: '绝对时间，ISO 或可解析日期字符串' },
            text: { type: 'string', description: '提醒内容，例如 起床' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_reminders',
        description: '查看当前会话/当前用户待触发的一次性提醒。用户问“我设了哪些提醒/还有什么提醒”时调用。',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: '最多返回多少条，默认 10' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_reminder',
        description: '取消当前会话/当前用户的一次性提醒。用户说“取消提醒/删掉刚才提醒/别提醒了”时调用。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '提醒 id，可从 list_reminders 获取' },
            keyword: { type: 'string', description: '按提醒内容关键词取消' },
            latest: { type: 'boolean', description: '是否取消最近一条匹配提醒，默认 true' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_uploaded_file_variant',
        description: '基于当前会话最近上传的文件创建安全副本、改文件名，并可发回当前 QQ 群/私聊。用户明确要求“把刚才文件重命名/改名/另存为/发给我”时调用；不要用于任意本地文件。',
        parameters: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: '可选，文件消息 ID；不确定时留空使用最近文件' },
            keyword: { type: 'string', description: '可选，按文件名关键词选择近期文件' },
            name: { type: 'string', description: '新文件名，例如 1.txt；不带后缀会沿用原后缀' },
            sendBack: { type: 'boolean', description: '是否发回当前会话，默认 true' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_scheduled_task',
        description: '创建一次性或周期定时任务。用户要求每天/每周/每隔一段时间执行、定时说话、定时总结、定时分析、到点运行 agent 时调用。短的一次性提醒也可以用 create_reminder。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['once', 'cron'], description: 'once 一次性，cron 周期任务' },
            type: { type: 'string', enum: ['text', 'agent'], description: 'text 直接发文本；agent 到点运行 agent prompt' },
            schedule: { type: 'string', description: '五字段 cron，例如每天 8 点为 0 8 * * *；最小间隔 10 分钟' },
            runAt: { type: 'string', description: '一次性触发时间，ISO 或可解析日期字符串' },
            delayMinutes: { type: 'number', description: '多少分钟后触发一次性任务' },
            title: { type: 'string', description: '任务标题' },
            prompt: { type: 'string', description: '到点发送或交给 agent 执行的内容' },
            scheduleText: { type: 'string', description: '用户可读时间描述，例如 每天 08:00' },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_scheduled_tasks',
        description: '查看当前会话/当前用户可见的定时任务。用户问“有哪些定时任务/每天任务/周期任务”时调用。',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'active/paused/done/failed/all，默认 active' },
            limit: { type: 'number', description: '最多返回多少条' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_scheduled_task',
        description: '查看当前用户/当前会话里的某个定时任务详情和最近执行历史。需要任务 id；不确定时先 list_scheduled_tasks。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '定时任务 id' } }, required: ['id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pause_scheduled_task',
        description: '暂停当前用户/当前会话里的定时任务。需要任务 id；不确定时先 list_scheduled_tasks。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '定时任务 id' } }, required: ['id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resume_scheduled_task',
        description: '恢复当前用户/当前会话里的定时任务。需要任务 id；不确定时先 list_scheduled_tasks。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '定时任务 id' } }, required: ['id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_scheduled_task',
        description: '删除当前用户/当前会话里的定时任务。需要任务 id；不确定时先 list_scheduled_tasks。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '定时任务 id' } }, required: ['id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_scheduled_task_now',
        description: '立即试跑当前用户/当前会话里的定时任务一次。需要任务 id；不确定时先 list_scheduled_tasks。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '定时任务 id' } }, required: ['id'] },
      },
    },
  ]
  const channel = resolveChatToolChannel(options)
  const enabledTools = tools.filter(tool => isChatToolAllowed(channel, tool.function?.name || ''))
  const filtered = options.randomTriggered
    ? enabledTools.filter(tool => !['create_reminder', 'list_reminders', 'cancel_reminder', 'create_scheduled_task', 'list_scheduled_tasks', 'get_scheduled_task', 'pause_scheduled_task', 'resume_scheduled_task', 'delete_scheduled_task', 'run_scheduled_task_now', 'create_uploaded_file_variant'].includes(tool.function?.name))
    : enabledTools
  return filterExternalToolDefinitions(filtered, options.userText || options.currentText || '')
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
  const channel = resolveChatToolChannel(context)
  if (!isChatToolAllowed(channel, name)) return `工具 ${name || 'unknown'} 当前渠道未启用。`
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
    case 'read_group_context': {
      const ck = context.channelKey || ''
      if (!ck) return '无法获取当前群聊频道。'
      const maxAgeMinutes = context.randomTriggered
        ? Math.min(Math.max(parseInt(args.maxAgeMinutes, 10) || 30, 1), 30)
        : Math.min(Math.max(parseInt(args.maxAgeMinutes, 10) || 60, 1), 24 * 60)
      const maxScenes = context.randomTriggered ? 1 : 2
      return readGroupContext(ck, {
        ...args,
        maxAgeMinutes,
        maxScenes,
      })
    }
    case 'read_image_history': {
      const { getRecentImages } = require('./image-store')
      const ck = context.channelKey || ''
      if (!ck) return '无法获取频道信息'
      const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 10)
      const images = await getRecentImages(ck, limit)
      if (!images.length) return '最近没有图片记录。'
      return images.map((img, i) => {
        const time = new Date(img.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        const status = img.analyzed ? `已分析: ${(img.analysis || '').slice(0, 80)}` : '未分析'
        return `${i + 1}. [${time}] msgId=${img.messageId} ${status}`
      }).join('\n')
    }
    case 'analyze_file': {
      const analyzeFile = require('./agent/tools/analyze-file')
      return analyzeFile.execute(args, context)
    }
    case 'analyze_historical_image': {
      const { getImageEntry, getCachedAnalysis } = require('./image-store')
      const { analyzeImageNow, enqueueAnalysis } = require('./image-analyzer')
      const ck = context.channelKey || ''
      const msgId = String(args.messageId || '').trim()
      if (!ck || !msgId) return '需要提供 messageId（从 read_image_history 获取）。'
      const cached = await getCachedAnalysis(ck, msgId)
      if (cached) return `图片内容：${cached}`
      const entry = await getImageEntry(ck, msgId)
      if (!entry) return '找不到该图片记录。'
      const analysis = await analyzeImageNow(ck, msgId)
      if (analysis) return `图片内容：${analysis}`
      enqueueAnalysis(ck, msgId)
      return '该图片正在后台分析中，稍后可通过 read_image_history 查看结果。'
    }
    case 'create_reminder': {
      const reminder = require('./agent/tools/create-reminder')
      return reminder.execute(args, context)
    }
    case 'list_reminders': {
      const { listRemindersTool } = require('./agent/tools/reminder-tools')
      return listRemindersTool.execute(args, context)
    }
    case 'cancel_reminder': {
      const { cancelReminderTool } = require('./agent/tools/reminder-tools')
      return cancelReminderTool.execute(args, context)
    }
    case 'create_scheduled_task': {
      const { createScheduledTaskTool } = require('./agent/tools/scheduled-task-tools')
      return createScheduledTaskTool.execute(args, context)
    }
    case 'list_scheduled_tasks': {
      const { listScheduledTasksTool } = require('./agent/tools/scheduled-task-tools')
      return listScheduledTasksTool.execute(args, context)
    }
    case 'get_scheduled_task': {
      const { getScheduledTaskTool } = require('./agent/tools/scheduled-task-tools')
      return getScheduledTaskTool.execute(args, context)
    }
    case 'pause_scheduled_task': {
      const { pauseScheduledTaskTool } = require('./agent/tools/scheduled-task-tools')
      return pauseScheduledTaskTool.execute(args, context)
    }
    case 'resume_scheduled_task': {
      const { resumeScheduledTaskTool } = require('./agent/tools/scheduled-task-tools')
      return resumeScheduledTaskTool.execute(args, context)
    }
    case 'delete_scheduled_task': {
      const { deleteScheduledTaskTool } = require('./agent/tools/scheduled-task-tools')
      return deleteScheduledTaskTool.execute(args, context)
    }
    case 'run_scheduled_task_now': {
      const { runScheduledTaskNowTool } = require('./agent/tools/scheduled-task-tools')
      return runScheduledTaskNowTool.execute(args, context)
    }
    case 'create_uploaded_file_variant': {
      const variant = require('./agent/tools/create-uploaded-file-variant')
      return variant.execute(args, context)
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
  const maxToolCalls = Number.isFinite(Number(context.maxToolCalls))
    ? Math.max(0, Number(context.maxToolCalls))
    : context.randomTriggered ? 1 : Infinity
  let handledToolCalls = 0

  for (const tc of toolCalls) {
    const name = tc?.function?.name || ''
    if (handledToolCalls >= maxToolCalls) {
      results.push({ tool_call_id: tc.id, role: 'tool', content: `工具 ${name || 'unknown'} 未执行：当前场景工具预算已用完。` })
      continue
    }
    handledToolCalls++
    if (!isChatToolAllowed(resolveChatToolChannel(context), name)) {
      results.push({ tool_call_id: tc.id, role: 'tool', content: `工具 ${name} 当前渠道未启用。` })
      continue
    }
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

function getChatToolSystemHint(channelKey, options = {}) {
  const channel = resolveChatToolChannel(options)
  const can = name => isChatToolAllowed(channel, name)
  const hintParts = ['你有辅助工具可用。只在确实需要时自主调用，不要告诉用户你使用了工具，把结果自然融入回复。大多数闲聊不需要工具，直接回复即可。']
  if (can('web_search') || can('web_fetch')) {
    if (can('web_search')) hintParts.push('遇到会随时间变化的问题，例如最新、最近、当前、现在、热门、比较火、趋势、排行、推荐、版本更新、新角色、新闻、视频等，不要凭记忆编答案，应先调用 web_search。')
    if (can('web_fetch')) hintParts.push('用户给出具体公开 URL 并要求查看、总结、核对网页内容时，应调用 web_fetch 读取正文。')
    if (can('web_search') && can('web_fetch')) hintParts.push('web_search 负责找候选来源并尽量打开正文，web_fetch 负责读取指定 URL；如果没有“正文质量：usable”的可靠正文，要直接说明没有拿到可靠结果，并给出可继续搜索或换链接的方向。')
  }
  if (can('read_group_context')) hintParts.push('read_group_context 只能查当前群公开旧片段，适合当前短句或追问接不上时理解“刚才/之前/那个/这张图/那个文件”等指代；工具结果是旧背景，不代表当前话题，不能主动翻旧账。')
  if (can('read_image_history')) hintParts.push('read_image_history 返回的图片分析结果只能作为聊天背景知识，绝对不能主动提起图片内容，只有用户明确问到图片时才可以引用。')
  if (can('create_reminder')) hintParts.push('用户明确要求“几分钟后提醒我/明天提醒/到点叫我”时必须调用 create_reminder。')
  if (can('create_scheduled_task')) hintParts.push('用户要求周期性执行、每天/每周/每隔一段时间说话、总结、分析、运行 agent 时，调用 create_scheduled_task。')
  if (can('list_scheduled_tasks') || can('pause_scheduled_task') || can('resume_scheduled_task') || can('delete_scheduled_task') || can('run_scheduled_task_now')) hintParts.push('用户要求查看/暂停/恢复/取消/删除/试跑定时任务时调用对应 scheduled task 工具。')
  if (can('create_reminder') || can('create_scheduled_task')) hintParts.push('只有工具结果表示创建成功后，才能说提醒或定时任务已设置。')
  if (can('create_uploaded_file_variant')) hintParts.push('用户明确要求把近期上传文件改名、另存副本、发回时可以调用 create_uploaded_file_variant。')
  hintParts.push('随机主动回复绝对不要创建提醒、定时任务或文件副本。')
  let hint = hintParts.join('')
  const policyHint = buildExternalToolPolicyHint(options.userText || options.currentText || '')
  if (policyHint) hint += `\n${policyHint}`
  if (channelKey) {
    try {
      const { getRecentFilesCached } = require('./file-store')
      const files = getRecentFilesCached(channelKey, 10).filter(f => !f.skipped)
      if (files.length > 0) {
        const analyzed = files.filter(file => file.analyzed).length
        const fileHints = []
        if (can('analyze_file')) fileHints.push('如果用户明确问"读文件"、"文件里面说了什么"、"刚才那个文件"等，可用 analyze_file')
        if (can('create_uploaded_file_variant')) fileHints.push('如果用户明确要求"把刚才文件改名/重命名/另存为/发给我"，可用 create_uploaded_file_variant')
        if (fileHints.length) hint += `\n[文件上下文] 当前会话最近有${files.length}个文件记录（${analyzed}个已分析）。${fileHints.join('；')}；闲聊或没有指向文件时不要调用。`
      }
    } catch {}
  }
  if (channelKey) {
    try {
      const { getRecentImagesCached } = require('./image-store')
      const recent = getRecentImagesCached(channelKey, 10)
      if (recent.length > 0) {
        const analyzed = recent.filter(img => img.analyzed).length
        if (can('read_image_history')) hint += `\n[图片上下文] 本群最近有${recent.length}张图片记录（${analyzed}张已分析）。如果用户提到"刚才的图"、"那张图"等，可用 read_image_history 查看。`
      }
    } catch {}
  }
  return hint
}

module.exports = {
  getChatToolDefinitions,
  resolveChatToolChannel,
  isChatToolAllowed,
  isLightweightTool,
  isHeavyTool,
  executeChatTool,
  handleChatToolCalls,
  getChatToolSystemHint,
  CHAT_TOOLS_TOTAL_DEADLINE_MS,
}
