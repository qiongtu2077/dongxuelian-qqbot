/**
 * MODULE: S2 result-notifier。
 * 职责: 扫描 done 任务并标记通知状态，为 Koishi 发送器提供稳定接口。
 * 边界: 不构造 QQ session；只有调用方注入 bot sender 时才发送消息。
 */
const fs = require('fs')
const path = require('path')
const { h } = require('koishi')
const { listResourceTasks, updateTaskNotifyStatus, writeWorkerEvent } = require('./task-store') as typeof import('./task-store')
const { getTaskResultDir } = require('./task-paths') as typeof import('./task-paths')

interface NotifyCompletedOptions {
  limit?: number
  sender?: ResultNotifierSender
}

interface ResultNotifyInfo extends Record<string, unknown> {
  target?: string
  channelKey?: string
  status?: string
  error?: string
}

interface ResultNotifierTaskLike extends Record<string, unknown> {
  id?: string
  kind?: string
  status?: string
  channelKey?: string
  notify?: ResultNotifyInfo
}

type ResultNotifierResult = Record<string, unknown>
type ResultNotifierSender = (task: ResultNotifierTaskLike, result: ResultNotifierResult) => Promise<boolean> | boolean

interface ResultNotifierBotLike {
  sendMessage?: (target: string, content: unknown) => Promise<unknown> | unknown
  internal?: {
    sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown
  }
}

interface ResultNotifierLoggerLike {
  info(message: string): void
  warn(message: string): void
}

interface DailyReportSenderOptions {
  bot?: ResultNotifierBotLike | null
  logger?: ResultNotifierLoggerLike | null
}

interface ResourceResultSenderOptions {
  bot?: ResultNotifierBotLike | null
  logger?: ResultNotifierLoggerLike | null
}

// 读取任务 result.json，缺失时返回空对象。
function readTaskResult(taskId: string): ResultNotifierResult {
  const file = path.join(getTaskResultDir(taskId), 'result.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

// 判断任务是否需要 result-notifier 处理。
function shouldNotifyTask(task: ResultNotifierTaskLike): boolean {
  const notify = task?.notify || {}
  if (!notify || notify.status === 'sent' || notify.status === 'skipped') return false
  return task.status === 'done'
}

// 把未知错误压成日志可读文本。
function getNotifierErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

// 读取日报文本结果，失败时返回空字符串。
function readReportText(result: ResultNotifierResult): string {
  const textPath = String(result.textPath || '')
  if (!textPath) return String(result.text || '')
  try {
    return fs.readFileSync(textPath, 'utf8')
  } catch {
    return String(result.text || '')
  }
}

// 判断 result.json 是否指向可发送的图片文件。
function hasReportImage(result: ResultNotifierResult): boolean {
  const imagePath = String(result.imagePath || '')
  if (!imagePath) return false
  try {
    const stat = fs.statSync(imagePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

// 构造日报文字发送内容，并根据实际降级原因补一句低成本提示。
function buildDailyReportTextMessage(result: ResultNotifierResult): string {
  const text = readReportText(result).trim()
  const reason = String(result.reason || '')
  const mode = String(result.mode || '')
  let prefix = ''
  if (mode === 'text' && /render_failed/i.test(reason)) prefix = '图片生成失败，已发送文字版日报。\n\n'
  else if (mode === 'text') prefix = '当前资源不足或图片不可用，已发送文字版日报。\n\n'
  else if (mode === 'summary') prefix = '当前可用内容较少，已发送摘要版日报。\n\n'
  return `${prefix}${text || '日报已生成，但文字结果为空。'}`.slice(0, 4000)
}

// 通过 Koishi bot 或 OneBot internal API 发送文字。
async function sendNotifierText(bot: ResultNotifierBotLike | null | undefined, target: string, text: string): Promise<void> {
  if (!bot) throw new Error('bot unavailable for result notifier')
  if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    await bot.internal.sendGroupMsg(target, [{ type: 'text', data: { text } }])
    return
  }
  if (typeof bot.sendMessage === 'function') {
    await bot.sendMessage(target, text)
    return
  }
  throw new Error('bot text send API unavailable for result notifier')
}

// 通过 OneBot internal API 或 Koishi h.image fallback 发送日报图片。
async function sendNotifierImage(bot: ResultNotifierBotLike | null | undefined, target: string, imagePath: string): Promise<void> {
  if (!bot) throw new Error('bot unavailable for result notifier')
  const base64 = fs.readFileSync(imagePath).toString('base64')
  if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    await bot.internal.sendGroupMsg(target, [{ type: 'image', data: { file: `base64://${base64}` } }])
    return
  }
  if (typeof bot.sendMessage === 'function') {
    await bot.sendMessage(target, h.normalize(h.image(`data:image/png;base64,${base64}`)))
    return
  }
  throw new Error('bot image send API unavailable for result notifier')
}

// 构造注入给 notifyCompletedTasks 的日报发送器。
function createDailyReportSender(options: DailyReportSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  return async (task: ResultNotifierTaskLike, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') !== 'daily_report') return false
    const notify = task?.notify || {}
    const target = String(notify.channelKey || task?.channelKey || '')
    if (!target) throw new Error('daily report notify target is empty')

    if (hasReportImage(result)) {
      try {
        await sendNotifierImage(bot, target, String(result.imagePath || ''))
        if (logger) logger.info(`daily report image notified: task=${task.id}, target=${target}`)
        return true
      } catch (error) {
        if (logger) logger.warn(`daily report image notify failed, falling back to text: task=${task.id}, error=${getNotifierErrorMessage(error)}`)
      }
    }

    await sendNotifierText(bot, target, buildDailyReportTextMessage(result))
    if (logger) logger.info(`daily report text notified: task=${task.id}, target=${target}`)
    return true
  }
}

// Build the text sent for standalone QQ Agent worker results.
function buildAgentTaskTextMessage(result: ResultNotifierResult): string {
  const reply = String(result.reply || result.message || '').trim()
  const pendingId = String(result.pendingId || '')
  const suffix = pendingId ? `\n\n需要确认的工具 ID: ${pendingId}` : ''
  return `${reply || 'Agent worker completed but returned an empty reply.'}${suffix}`.slice(0, 4000)
}

// Construct a sender for standalone QQ Agent worker results.
function createAgentTaskSender(options: ResourceResultSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  return async (task: ResultNotifierTaskLike, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') !== 'agent_task') return false
    const notify = task?.notify || {}
    const target = String(notify.channelKey || task?.channelKey || '')
    if (!target) throw new Error('agent task notify target is empty')
    await sendNotifierText(bot, target, buildAgentTaskTextMessage(result))
    if (logger) logger.info(`agent task text notified: task=${task.id}, target=${target}`)
    return true
  }
}

// Construct a sender for background emotion render results.
function createEmotionRenderSender(options: ResourceResultSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  return async (task: ResultNotifierTaskLike, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') !== 'emotion_render') return false
    const notify = task?.notify || {}
    const target = String(notify.channelKey || task?.channelKey || '')
    if (!target) throw new Error('emotion render notify target is empty')
    const imagePath = String(result.imagePath || '')
    if (imagePath && hasReportImage({ imagePath })) {
      await sendNotifierImage(bot, target, imagePath)
      if (logger) logger.info(`emotion image notified: task=${task.id}, target=${target}`)
      return true
    }
    const text = String(result.text || '今日情绪图片已生成，但图片文件不可用。').slice(0, 4000)
    await sendNotifierText(bot, target, text)
    if (logger) logger.info(`emotion text fallback notified: task=${task.id}, target=${target}`)
    return true
  }
}

// Compose all resource result senders used by Koishi lifecycle.
function createResourceResultSender(options: ResourceResultSenderOptions = {}): ResultNotifierSender {
  const dailySender = createDailyReportSender(options)
  const agentSender = createAgentTaskSender(options)
  const emotionSender = createEmotionRenderSender(options)
  return async (task: ResultNotifierTaskLike, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') === 'daily_report') return dailySender(task, result)
    if (String(task?.kind || '') === 'agent_task') return agentSender(task, result)
    if (String(task?.kind || '') === 'emotion_render') return emotionSender(task, result)
    return false
  }
}

// 扫描 done 任务并更新 notify 状态；QQ 发送由调用方 sender 注入。
async function notifyCompletedTasks(options: NotifyCompletedOptions = {}): Promise<Record<string, unknown>> {
  const tasks = listResourceTasks({ statuses: ['done'], limit: Math.max(1, Math.min(500, Number(options.limit || 100))) })
    .filter(shouldNotifyTask)
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const task of tasks) {
    const notify = task.notify || {}
    const target = String(notify.target || 'none')
    const result = readTaskResult(String(task.id || ''))
    if (target === 'none' || target === 'dashboard' || /^media_/i.test(String(task.kind || ''))) {
      updateTaskNotifyStatus(task, 'skipped')
      skipped++
      continue
    }
    if (!options.sender) {
      writeWorkerEvent('task_notify_waiting_sender', { taskId: task.id, kind: task.kind, target })
      continue
    }
    try {
      const ok = await Promise.resolve(options.sender(task, result))
      updateTaskNotifyStatus(task, ok ? 'sent' : 'failed', ok ? '' : 'sender returned false')
      if (ok) sent++
      else failed++
    } catch (error) {
      updateTaskNotifyStatus(task, 'failed', error instanceof Error ? error.message : String(error || 'notify failed'))
      failed++
    }
  }
  return { scanned: tasks.length, sent, skipped, failed }
}

export = {
  readTaskResult,
  createDailyReportSender,
  createAgentTaskSender,
  createEmotionRenderSender,
  createResourceResultSender,
  notifyCompletedTasks,
}
