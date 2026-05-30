/**
 * MODULE: Agent 通用定时任务工具。
 * 职责: 基于现有 cron 模块创建、查看、暂停、恢复、删除、试跑 text/agent 定时任务。
 * 边界: 不新建调度器；不绕过 cron/push/queue 权限。
 */
const { truncateText } = require('../../core/utils') as typeof import('../../core/utils')
const { getAgentConfig } = require('../config') as typeof import('../config')

interface ScheduledTaskParams {
  id?: unknown
  taskId?: unknown
  mode?: unknown
  recurring?: unknown
  schedule?: unknown
  type?: unknown
  taskType?: unknown
  runAt?: unknown
  dueAt?: unknown
  delayMinutes?: unknown
  delaySeconds?: unknown
  prompt?: unknown
  text?: unknown
  message?: unknown
  title?: unknown
  description?: unknown
  timezone?: unknown
  scheduleText?: unknown
  timeText?: unknown
  silentOnNoResult?: unknown
  contextPolicy?: unknown
  runPolicy?: unknown
  taskKind?: unknown
  status?: unknown
  limit?: unknown
}

interface ScheduledTaskContext {
  channelKey?: string
  userId?: string
  channel?: string
  isDirect?: boolean
  randomTriggered?: boolean
}

interface ScheduledCronEntry {
  id: string
  title?: string
  taskKind?: string
  type?: string
  mode?: string
  runAt?: number
  nextRunAt?: number
  status?: string
  enabled?: boolean
  prompt?: string
  targetChannel?: string
  targetUserId?: string
  createdBy?: string
  history?: Array<{ at?: number; ok?: boolean; result?: unknown }>
  stats?: { runCount?: number; failCount?: number }
}

interface CronData {
  crons?: ScheduledCronEntry[]
}

interface ScheduledRunResult {
  ok: boolean
  result?: unknown
}

interface ScheduledContextPolicyInput {
  allowReadGroupContext?: unknown
  allowExternalTools?: unknown
  anchorMessageIds?: unknown
  fileAnchor?: unknown
  allowedTools?: unknown
}

const {
  registerCron,
  registerOnceTask,
  loadCrons,
  getCron,
  pauseCron,
  resumeCron,
  unregisterCron,
  runCronNow,
  createCronId,
} = require('../cron') as typeof import('../cron')

const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 370 * 24 * 60 * 60 * 1000

function resolveTarget(context: ScheduledTaskContext = {}): string {
  const channelKey = String(context.channelKey || '').trim()
  const userId = String(context.userId || '').trim()
  if (channelKey === 'private' && userId) return `private:${userId}`
  return channelKey
}

function formatTime(ts: unknown): string {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '未计算'
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false })
}

function compactText(text: unknown = '', max: number = 500): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const limit = Math.max(0, Number(max) || 0)
  return value.length <= limit ? value : truncateText(value, Math.max(0, limit - 3)) + '...'
}

function resolveRunAt(params: ScheduledTaskParams = {}, now: number = Date.now()): number {
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

function normalizeTaskType(params: ScheduledTaskParams = {}): 'agent' | 'text' {
  return params.type === 'agent' || params.taskType === 'agent' ? 'agent' : 'text'
}

function normalizeMode(params: ScheduledTaskParams = {}): 'cron' | 'once' {
  return params.mode === 'cron' || params.recurring === true || params.schedule ? 'cron' : 'once'
}

function normalizePrompt(params: ScheduledTaskParams = {}): string {
  return compactText(params.prompt || params.text || params.message || params.title || '提醒时间到了。', 4000)
}

function normalizeTaskKind(params: ScheduledTaskParams = {}, type: 'agent' | 'text' = 'text', mode: 'cron' | 'once' = 'once'): string {
  if (['reminder', 'scheduled_text', 'scheduled_agent', 'file_agent'].includes(String(params.taskKind))) return String(params.taskKind)
  if (mode === 'once' && type === 'text') return 'reminder'
  return type === 'text' ? 'scheduled_text' : 'scheduled_agent'
}

function normalizeContextPolicy(params: ScheduledTaskParams = {}): Record<string, unknown> {
  const input = params.contextPolicy && typeof params.contextPolicy === 'object' && !Array.isArray(params.contextPolicy)
    ? params.contextPolicy as ScheduledContextPolicyInput
    : {}
  return {
    allowReadGroupContext: input.allowReadGroupContext !== false,
    allowExternalTools: !!input.allowExternalTools,
    anchorMessageIds: Array.isArray(input.anchorMessageIds) ? input.anchorMessageIds : [],
    fileAnchor: input.fileAnchor && typeof input.fileAnchor === 'object' && !Array.isArray(input.fileAnchor) ? input.fileAnchor : null,
    allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools : [],
  }
}

function isTaskVisibleToContext(cron: ScheduledCronEntry = { id: '' }, context: ScheduledTaskContext = {}): boolean {
  const target = resolveTarget(context)
  const userId = String(context.userId || '').trim()
  if (target && String(cron.targetChannel || '') !== target) return false
  if (userId && String(cron.createdBy || cron.targetUserId || '') && ![cron.createdBy, cron.targetUserId].map(String).includes(userId)) return false
  return true
}

function formatTaskLine(cron: ScheduledCronEntry = { id: '' }): string {
  const next = cron.mode === 'once' ? cron.runAt : cron.nextRunAt
  const status = cron.status || (cron.enabled === false ? 'paused' : 'active')
  return `${cron.id} [${status}] ${cron.title || cron.taskKind || cron.type} ${cron.mode}/${cron.type} 下次：${formatTime(next)}`
}

async function executeCreateScheduledTask(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  if (context.randomTriggered) return '随机主动回复不能创建定时任务。'
  const targetChannel = resolveTarget(context)
  if (!targetChannel) return '无法确定定时任务发送目标。'

  const mode = normalizeMode(params)
  const type = normalizeTaskType(params)
  const prompt = normalizePrompt(params)
  const title = compactText(params.title || prompt, 120)
  const now = Date.now()
  const base = {
    id: compactText(params.id || createCronId(mode === 'once' ? 'once' : 'task'), 80).replace(/[^a-zA-Z0-9_-]/g, '_'),
    mode,
    type,
    taskKind: normalizeTaskKind(params, type, mode),
    title,
    description: compactText(params.description || prompt, 500),
    prompt,
    targetChannel,
    targetUserId: context.userId || '',
    createdBy: context.userId || '',
    createdFrom: context.channel || 'qq',
    timezone: params.timezone || 'Asia/Shanghai',
    scheduleText: compactText(params.scheduleText || params.timeText || '', 200),
    visibility: context.isDirect ? 'private' : 'channel',
    delivery: {
      targetChannel,
      targetUserId: context.userId || '',
      userRequested: true,
      quoteSource: false,
      silentOnNoResult: !!params.silentOnNoResult,
    },
    contextPolicy: normalizeContextPolicy(params),
    runPolicy: params.runPolicy && typeof params.runPolicy === 'object' && !Array.isArray(params.runPolicy) ? params.runPolicy : {},
  }

  if (mode === 'once') {
    const runAt = resolveRunAt(params, now)
    const delay = runAt - now
    if (!Number.isFinite(runAt) || delay < MIN_DELAY_MS) return '定时任务时间太近或无效。'
    if (delay > MAX_DELAY_MS) return '定时任务时间太远，最多支持 370 天内。'
    const cron = await registerOnceTask({ ...base, runAt })
    // L45: 一次性任务总开关关闭时如实说明不会触发，不给假成功回执（任务仍已保存）
    if (getAgentConfig().cron?.onceEnabled === false) {
      return `已保存定时任务：${cron.title || cron.id}，但一次性任务总开关当前未开启，不会自动触发。`
    }
    return `已创建定时任务：${cron.title || cron.id}，触发时间 ${formatTime(cron.runAt)}。`
  }

  const schedule = String(params.schedule || '').trim()
  if (!schedule) return '周期定时任务需要提供 cron schedule。'
  const cron = await registerCron({ ...base, schedule, status: 'active', enabled: true })
  // L45: 周期任务总开关关闭时如实说明不会调度，不给假成功回执（任务仍已保存）
  if (getAgentConfig().cron?.enabled === false) {
    return `已保存周期任务：${cron.title || cron.id}，但周期任务总开关当前未开启，不会自动触发。`
  }
  return `已创建周期任务：${cron.title || cron.id}，下次触发 ${formatTime(cron.nextRunAt)}。`
}

async function executeListScheduledTasks(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const limit = Math.max(1, Math.min(parseInt(String(params.limit), 10) || 10, 30))
  const status = String(params.status || 'active').trim()
  const data = await loadCrons()
  const items = (data.crons || [])
    .filter(cron => isTaskVisibleToContext(cron, context))
    .filter(cron => {
      if (status === 'all') return true
      if (status === 'active') return cron.enabled !== false && !['done', 'cancelled', 'paused'].includes(cron.status)
      return cron.status === status
    })
    .sort((a, b) => (a.nextRunAt || a.runAt || 0) - (b.nextRunAt || b.runAt || 0))
    .slice(0, limit)
  if (!items.length) return '当前没有匹配的定时任务。'
  return items.map((cron, index) => `${index + 1}. ${formatTaskLine(cron)}`).join('\n')
}

async function executeGetScheduledTask(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const id = String(params.id || params.taskId || '').trim()
  if (!id) return '需要提供定时任务 id。'
  const cron = await getCron(id)
  if (!cron || !isTaskVisibleToContext(cron, context)) return '没找到可查看的定时任务。'
  const history = Array.isArray(cron.history) && cron.history.length
    ? cron.history.slice(-5).map(item => `- ${formatTime(item.at)} ${item.ok ? '成功' : '失败'} ${compactText(item.result, 120)}`).join('\n')
    : '暂无执行历史。'
  return [
    formatTaskLine(cron),
    `内容：${compactText(cron.prompt, 500)}`,
    `运行次数：${cron.stats?.runCount || 0}，失败次数：${cron.stats?.failCount || 0}`,
    `历史：\n${history}`,
  ].join('\n')
}

async function executePauseScheduledTask(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const id = String(params.id || params.taskId || '').trim()
  if (!id) return '需要提供定时任务 id。'
  const cron = await getCron(id)
  if (!cron || !isTaskVisibleToContext(cron, context)) return '没找到可暂停的定时任务。'
  const paused = await pauseCron(id)
  return paused ? `已暂停定时任务：${paused.title || paused.id}` : '暂停失败。'
}

async function executeResumeScheduledTask(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const id = String(params.id || params.taskId || '').trim()
  if (!id) return '需要提供定时任务 id。'
  const cron = await getCron(id)
  if (!cron || !isTaskVisibleToContext(cron, context)) return '没找到可恢复的定时任务。'
  const resumed = await resumeCron(id)
  return resumed ? `已恢复定时任务：${resumed.title || resumed.id}，下次触发 ${formatTime(resumed.mode === 'once' ? resumed.runAt : resumed.nextRunAt)}。` : '恢复失败。'
}

async function executeDeleteScheduledTask(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const id = String(params.id || params.taskId || '').trim()
  if (!id) return '需要提供定时任务 id。'
  const cron = await getCron(id)
  if (!cron || !isTaskVisibleToContext(cron, context)) return '没找到可删除的定时任务。'
  const removed = await unregisterCron(id)
  return removed ? `已删除定时任务：${cron.title || cron.id}` : '删除失败，任务可能已经不存在。'
}

async function executeRunScheduledTaskNow(params: ScheduledTaskParams = {}, context: ScheduledTaskContext = {}): Promise<string> {
  const id = String(params.id || params.taskId || '').trim()
  if (!id) return '需要提供定时任务 id。'
  const cron = await getCron(id)
  if (!cron || !isTaskVisibleToContext(cron, context)) return '没找到可运行的定时任务。'
  const result = await runCronNow(id)
  return result.ok ? `已运行定时任务：${cron.title || cron.id}` : `定时任务运行失败：${compactText(result.result, 300)}`
}

const createScheduledTaskTool = {
  definition: {
    name: 'create_scheduled_task',
    description: '创建一次性或周期定时任务。用户要求每天/每周/每隔一段时间执行、定时发送文本、定时运行 agent、定时总结/分析时调用。一次性短提醒也可以调用 create_reminder。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['once', 'cron'], description: 'once 为一次性，cron 为周期任务' },
        type: { type: 'string', enum: ['text', 'agent'], description: 'text 直接发送文本，agent 到点运行 agent prompt' },
        schedule: { type: 'string', description: '五字段 cron，例如每天 8 点为 0 8 * * *' },
        runAt: { type: 'string', description: '一次性触发时间，ISO 或可解析时间' },
        delayMinutes: { type: 'number', description: '多少分钟后触发一次性任务' },
        title: { type: 'string', description: '任务标题' },
        prompt: { type: 'string', description: '到点发送或交给 agent 执行的内容' },
        scheduleText: { type: 'string', description: '用户可读的时间描述' },
      },
      required: ['prompt'],
    },
  },
  execute: executeCreateScheduledTask,
  dangerous: true,
  defaultChannels: ['qq', 'dashboard'],
}

interface SimpleScheduledToolOptions {
  dangerous?: boolean
}

interface SimpleScheduledTool {
  definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  execute: (params?: ScheduledTaskParams, context?: ScheduledTaskContext) => Promise<string>
  dangerous: boolean
  defaultChannels: string[]
}

function makeSimpleTool(
  name: string,
  description: string,
  execute: (params?: ScheduledTaskParams, context?: ScheduledTaskContext) => Promise<string>,
  options: SimpleScheduledToolOptions = {},
): SimpleScheduledTool {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '定时任务 id' },
          status: { type: 'string', description: '过滤状态，可选 active/paused/done/failed/all' },
          limit: { type: 'number', description: '列表数量' },
        },
        required: name === 'list_scheduled_tasks' ? [] as string[] : ['id'],
      },
    },
    execute,
    dangerous: !!options.dangerous,
    defaultChannels: ['qq', 'dashboard'],
  }
}

const listScheduledTasksTool = makeSimpleTool('list_scheduled_tasks', '查看当前会话/当前用户可见的定时任务。', executeListScheduledTasks)
const getScheduledTaskTool = makeSimpleTool('get_scheduled_task', '查看某个定时任务详情和最近历史。', executeGetScheduledTask)
const pauseScheduledTaskTool = makeSimpleTool('pause_scheduled_task', '暂停某个定时任务，不删除。', executePauseScheduledTask, { dangerous: true })
const resumeScheduledTaskTool = makeSimpleTool('resume_scheduled_task', '恢复某个已暂停的定时任务。', executeResumeScheduledTask, { dangerous: true })
const deleteScheduledTaskTool = makeSimpleTool('delete_scheduled_task', '删除某个定时任务。', executeDeleteScheduledTask, { dangerous: true })
const runScheduledTaskNowTool = makeSimpleTool('run_scheduled_task_now', '立即试跑某个定时任务一次。', executeRunScheduledTaskNow, { dangerous: true })

export = {
  createScheduledTaskTool,
  listScheduledTasksTool,
  getScheduledTaskTool,
  pauseScheduledTaskTool,
  resumeScheduledTaskTool,
  deleteScheduledTaskTool,
  runScheduledTaskNowTool,
  tools: [
    createScheduledTaskTool,
    listScheduledTasksTool,
    getScheduledTaskTool,
    pauseScheduledTaskTool,
    resumeScheduledTaskTool,
    deleteScheduledTaskTool,
    runScheduledTaskNowTool,
  ],
  executeCreateScheduledTask,
  executeListScheduledTasks,
  executeGetScheduledTask,
  executePauseScheduledTask,
  executeResumeScheduledTask,
  executeDeleteScheduledTask,
  executeRunScheduledTaskNow,
  resolveRunAt,
  resolveTarget,
}
