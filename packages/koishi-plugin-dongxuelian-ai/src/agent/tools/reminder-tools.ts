/**
 * MODULE: Agent 提醒工具。
 * 职责: 基于现有 cron 模块创建、查看、取消一次性提醒。
 * 边界: 不新建调度器，不绕过 cron/push 权限。
 */
interface ReminderToolParams {
  runAt?: unknown
  dueAt?: unknown
  delayMinutes?: unknown
  delaySeconds?: unknown
  text?: unknown
  message?: unknown
  limit?: unknown
  id?: unknown
  reminderId?: unknown
  keyword?: unknown
  latest?: unknown
}

interface ReminderToolContext {
  channelKey?: string
  userId?: string
  channel?: string
  randomTriggered?: boolean
}

interface CronEntry {
  id: string
  prompt?: string
  mode?: string
  enabled?: boolean
  status?: string
  targetChannel?: string
  targetUserId?: string
  createdBy?: string
  createdAt?: number
  runAt?: number
  nextRunAt?: number
}

interface CronData {
  crons?: CronEntry[]
}

const { registerOnceTask, loadCrons, unregisterCron } = require('../cron') as typeof import('../cron')

const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000

function resolveRunAt(params: ReminderToolParams = {}, now: number = Date.now()): number {
  if (params.runAt || params.dueAt) {
    const parsed = Date.parse(String(params.runAt || params.dueAt))
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(params.runAt || params.dueAt)
    if (Number.isFinite(numeric)) return numeric
  }
  const delayMinutes = Number(params.delayMinutes || 0)
  if (Number.isFinite(delayMinutes) && delayMinutes > 0) return now + delayMinutes * 60 * 1000
  const delaySeconds = Number(params.delaySeconds || 0)
  if (Number.isFinite(delaySeconds) && delaySeconds > 0) return now + delaySeconds * 1000
  return 0
}

function resolveReminderTarget(context: ReminderToolContext = {}): string {
  const channelKey = String(context.channelKey || '').trim()
  const userId = String(context.userId || '').trim()
  if (channelKey === 'private' && userId) return `private:${userId}`
  return channelKey
}

function formatReminderTime(ts: unknown): string {
  return new Date(Number(ts) || 0).toLocaleString('zh-CN', { hour12: false })
}

function normalizeReminderPrompt(params: ReminderToolParams = {}): string {
  const text = String(params.text || params.message || '提醒时间到了。').replace(/\s+/g, ' ').trim().slice(0, 500) || '提醒时间到了。'
  return text.startsWith('提醒') ? text : `提醒：${text}`
}

async function executeCreateReminder(params: ReminderToolParams = {}, context: ReminderToolContext = {}): Promise<string> {
  if (context.randomTriggered) return '随机主动回复不能创建提醒。'
  const targetChannel = resolveReminderTarget(context)
  if (!targetChannel) return '无法确定提醒发送目标。'
  const now = Date.now()
  const runAt = resolveRunAt(params, now)
  const delay = runAt - now
  if (!Number.isFinite(runAt) || delay < MIN_DELAY_MS) return '提醒时间太近或无效。'
  if (delay > MAX_DELAY_MS) return '提醒时间太远，最多支持 30 天内的一次性提醒。'
  const prompt = normalizeReminderPrompt(params)
  const cron = await registerOnceTask({
    type: 'text',
    prompt,
    targetChannel,
    targetUserId: context.userId || '',
    createdBy: context.userId || '',
    createdFrom: context.channel || 'qq',
    runAt,
  })
  return `已创建提醒：${prompt}，触发时间 ${formatReminderTime(cron.runAt)}。`
}

function isReminderVisibleToContext(cron: CronEntry = { id: '' }, context: ReminderToolContext = {}): boolean {
  const targetChannel = resolveReminderTarget(context)
  const userId = String(context.userId || '').trim()
  if (targetChannel && String(cron.targetChannel || '') !== targetChannel) return false
  if (userId && String(cron.createdBy || cron.targetUserId || '') && ![cron.createdBy, cron.targetUserId].map(String).includes(userId)) return false
  return cron.mode === 'once' && cron.enabled !== false && !['done', 'cancelled'].includes(cron.status)
}

async function executeListReminders(params: ReminderToolParams = {}, context: ReminderToolContext = {}): Promise<string> {
  const limit = Math.max(1, Math.min(parseInt(String(params.limit), 10) || 10, 20))
  const data = await loadCrons()
  const items = (data.crons || [])
    .filter(cron => isReminderVisibleToContext(cron, context))
    .sort((a, b) => (a.runAt || a.nextRunAt || 0) - (b.runAt || b.nextRunAt || 0))
    .slice(0, limit)
  if (!items.length) return '当前没有待触发的一次性提醒。'
  return items.map((cron, index) => `${index + 1}. ${cron.id} ${formatReminderTime(cron.runAt || cron.nextRunAt)} ${cron.prompt}`).join('\n')
}

async function executeCancelReminder(params: ReminderToolParams = {}, context: ReminderToolContext = {}): Promise<string> {
  const data = await loadCrons()
  const visible = (data.crons || [])
    .filter(cron => isReminderVisibleToContext(cron, context))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.runAt || b.nextRunAt || 0) - (a.runAt || a.nextRunAt || 0) || String(b.id || '').localeCompare(String(a.id || '')))
  const requestedId = String(params.id || params.reminderId || '').trim()
  const keyword = String(params.keyword || params.text || '').replace(/\s+/g, ' ').trim()
  const hasExplicitTarget = !!(requestedId || keyword || params.latest === true)
  if (!hasExplicitTarget) return '请说明要取消哪一条提醒，例如提供提醒 id、关键词，或说“取消最近一条提醒”。'
  let target = requestedId ? visible.find(cron => cron.id === requestedId) : null
  if (!target && keyword) target = visible.find(cron => String(cron.prompt || '').includes(keyword))
  if (!target && params.latest === true && visible.length) target = visible[0]
  if (!target && visible.length > 1) return '有多条待触发提醒，请说明要取消哪一条，或说“取消最近一条提醒”。'
  if (!target) return '没找到可取消的提醒。'
  const removed = await unregisterCron(target.id)
  return removed ? `已取消提醒：${target.prompt}` : '提醒取消失败，可能已经触发或不存在。'
}

const createReminderTool = {
  definition: {
    name: 'create_reminder',
    description: '创建一次性提醒。用户明确说“几分钟后提醒我/到点叫我/明天提醒”时调用；随机主动回复不能调用。',
    parameters: {
      type: 'object',
      properties: {
        delayMinutes: { type: 'number', description: '多少分钟后提醒，例如 10' },
        delaySeconds: { type: 'number', description: '多少秒后提醒' },
        dueAt: { type: 'string', description: '绝对时间，ISO 或可解析日期字符串' },
        text: { type: 'string', description: '提醒内容，例如 起床' },
      },
      required: ['text'],
    },
  },
  execute: executeCreateReminder,
  resolveRunAt,
  dangerous: true,
  defaultChannels: ['qq', 'dashboard'],
}

const listRemindersTool = {
  definition: {
    name: 'list_reminders',
    description: '查看当前会话/当前用户待触发的一次性提醒。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回多少条' } },
      required: [] as string[],
    },
  },
  execute: executeListReminders,
  dangerous: false,
  defaultChannels: ['qq', 'dashboard'],
}

const cancelReminderTool = {
  definition: {
    name: 'cancel_reminder',
    description: '取消当前会话/当前用户的一次性提醒。用户说取消提醒、删掉刚才提醒、别提醒了时调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒 id，可从 list_reminders 获取' },
        keyword: { type: 'string', description: '按提醒内容关键词取消' },
        latest: { type: 'boolean', description: '是否取消最近一条匹配提醒，默认 true' },
      },
      required: [] as string[],
    },
  },
  execute: executeCancelReminder,
  dangerous: true,
  defaultChannels: ['qq', 'dashboard'],
}

export = {
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  tools: [createReminderTool, listRemindersTool, cancelReminderTool],
  executeCreateReminder,
  executeListReminders,
  executeCancelReminder,
  resolveRunAt,
}
