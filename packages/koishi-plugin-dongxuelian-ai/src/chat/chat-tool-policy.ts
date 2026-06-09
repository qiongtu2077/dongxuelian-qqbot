/**
 * MODULE: Chat 工具纯策略。
 * 职责: 维护 chat 工具分类和无副作用写状态意图判断。
 * 边界: 不执行工具，不写 pending，不读取配置。
 */
const { parseReminderActionRequest, parseScheduledTaskRequest } = require('../routing/reminder-route') as typeof import('../routing/reminder-route')

type ChatToolArgs = Record<string, unknown>

interface ChatToolPolicyContext {
  allowParsedReminderAction?: boolean
  userText?: string
  currentText?: string
}

const LIGHTWEIGHT_TOOLS: Set<string> = new Set(['get_current_time', 'calculate', 'search_memory', 'read_image_history', 'analyze_historical_image', 'read_group_context', 'analyze_file', 'create_uploaded_file_variant', 'create_reminder', 'list_reminders', 'cancel_reminder', 'create_scheduled_task', 'list_scheduled_tasks', 'get_scheduled_task', 'pause_scheduled_task', 'resume_scheduled_task', 'delete_scheduled_task', 'run_scheduled_task_now'])

const HEAVY_TOOLS: Set<string> = new Set(['web_search', 'web_fetch', 'browser_action', 'execute_shell', 'file_write'])

const CHAT_WRITE_ACTION_TOOLS: Set<string> = new Set([
  'create_reminder',
  'cancel_reminder',
  'create_scheduled_task',
  'pause_scheduled_task',
  'resume_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task_now',
])

const CHAT_DANGEROUS_ACTION_TOOLS: Set<string> = new Set([
  ...CHAT_WRITE_ACTION_TOOLS,
  'create_uploaded_file_variant',
])

const RANDOM_REPLY_BLOCKED_TOOLS: Set<string> = new Set([
  'web_search',
  'web_fetch',
  'create_reminder',
  'list_reminders',
  'cancel_reminder',
  'create_scheduled_task',
  'list_scheduled_tasks',
  'get_scheduled_task',
  'pause_scheduled_task',
  'resume_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task_now',
  'create_uploaded_file_variant',
])

function getArgNumber(args: ChatToolArgs, key: string): number {
  const value = args[key]
  return typeof value === 'number' ? value : Number(value)
}

function getArgBoolean(args: ChatToolArgs, key: string): boolean {
  return args[key] === true
}

function isLightweightTool(name: string): boolean {
  return LIGHTWEIGHT_TOOLS.has(name)
}

function isHeavyTool(name: string): boolean {
  return HEAVY_TOOLS.has(name) || !LIGHTWEIGHT_TOOLS.has(name)
}

function isChatWriteActionTool(name: string): boolean {
  return CHAT_WRITE_ACTION_TOOLS.has(name)
}

function isDangerousChatActionTool(name: string): boolean {
  return CHAT_DANGEROUS_ACTION_TOOLS.has(name)
}

function isRandomReplyBlockedTool(name: string): boolean {
  return RANDOM_REPLY_BLOCKED_TOOLS.has(name)
}

function isExplicitChatWriteActionAllowed(name: string = '', args: ChatToolArgs = {}, context: ChatToolPolicyContext = {}): boolean {
  if (!isChatWriteActionTool(name)) return true
  if (context.allowParsedReminderAction) return true
  const userText = String(context.userText || context.currentText || '').trim()
  if (!userText) return false
  const parsed = parseScheduledTaskRequest(userText) || parseReminderActionRequest(userText)
  if (!parsed || parsed.name !== name) return false
  const parsedArgs = parsed.args as Record<string, unknown>
  if (name === 'create_reminder') {
    const parsedRunAt = Number(parsedArgs.runAt || 0)
    const toolRunAt = Number(getArgNumber(args, 'runAt') || getArgNumber(args, 'dueAt') || 0)
    const sameRunAt = parsedRunAt && toolRunAt ? Math.abs(parsedRunAt - toolRunAt) <= 60 * 1000 : true
    return sameRunAt && String(args.text || args.message || '').trim().length > 0
  }
  if (name === 'create_scheduled_task') return !!String(args.prompt || args.text || args.message || '').trim()
  if (name === 'cancel_reminder') return !!(args.id || args.reminderId || args.keyword || args.text || getArgBoolean(args, 'latest') || parsedArgs.latest === true || parsedArgs.keyword)
  return !!(args.id || args.taskId || parsedArgs.id || parsedArgs.taskId)
}

export = {
  LIGHTWEIGHT_TOOLS,
  HEAVY_TOOLS,
  CHAT_WRITE_ACTION_TOOLS,
  CHAT_DANGEROUS_ACTION_TOOLS,
  RANDOM_REPLY_BLOCKED_TOOLS,
  isLightweightTool,
  isHeavyTool,
  isChatWriteActionTool,
  isDangerousChatActionTool,
  isRandomReplyBlockedTool,
  isExplicitChatWriteActionAllowed,
}
