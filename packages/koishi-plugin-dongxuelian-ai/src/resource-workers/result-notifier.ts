/**
 * MODULE: S2 result-notifier。
 * 职责: 通知已完成任务和新失败日报，持久化日报分段送达进度。
 * 边界: 不构造 QQ session；只有调用方注入 bot sender 时才发送消息。
 */
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto') as typeof import('crypto')
const { h } = require('koishi')
const { listTerminalTasksForNotification, updateTaskNotifyStatus, updateDailyReportDeliveryProgress } = require('./task-store') as typeof import('./task-store')
const { getTaskResultDir } = require('./task-paths') as typeof import('./task-paths')
const { REPORT_FAILURE_TEXT, REPORT_TIMEOUT_TEXT } = require('../daily-precompute/report-analysis') as typeof import('../daily-precompute/report-analysis')
const {
  guardAgentRetellReply,
  hasSearchFailureMaterial,
  redactAgentMaterial,
} = require('../chat/agent-retell-guard') as typeof import('../chat/agent-retell-guard')
type ResourceTask = import('./task-types').ResourceTask
type ResourceTaskNotify = import('./task-types').ResourceTaskNotify
type DailyReportDeliveryProgress = import('./task-types').DailyReportDeliveryProgress

interface NotifyCompletedOptions {
  limit?: number
  sender?: ResultNotifierSender
}

type ResultNotifierResult = Record<string, unknown>
type ResultNotifierSender = (task: ResourceTask, result: ResultNotifierResult) => Promise<boolean> | boolean

const FAILED_NOTIFY_RETRY_COOLDOWN_MS = Math.max(
  1000,
  Math.min(30 * 60 * 1000, Number(process.env.RESOURCE_NOTIFY_FAILED_RETRY_COOLDOWN_MS || 60000)),
)

interface AgentNotifyResultLike {
  reply?: unknown
  message?: unknown
  toolResults?: Array<{ name?: string; result?: unknown }>
}

const AGENT_NOTIFY_HARD_SEARCH_FAILURE_RE = /(?:搜索状态：weak_hit|weak_hit|弱命中|正文质量：(?:short|empty|garbage|error|unknown)|未读到可用正文|未打开候选网页正文|不能作为事实依据)/i
const AGENT_NOTIFY_SEARCH_SUCCESS_RE = /(?:搜索状态：usable_hit|已打开候选网页正文|正文质量：usable|已用 web_fetch 验证正文|已读取网页：)/i
const EMPTY_AGENT_REPLY_RE = /^\(Agent 未获取到有效回复\)/i

interface ResultNotifierBotLike {
  sendMessage?: (target: string, content: unknown) => Promise<unknown> | unknown
  sendPrivateMessage?: (target: string, content: string) => Promise<unknown> | unknown
  internal?: {
    sendPrivateMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown
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
  ctx?: unknown
  chat?: unknown
  retellAgentResult?: unknown
}

// Context-like object with logger capability for notifier — uses broad
// parameter types so it is assignable from both LifecycleContext and
// ChatContextLike.
interface ResultNotifierContextLike {
  logger(name: string): { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; [key: string]: unknown }
  [key: string]: unknown
}

// Session-like object for chat function — broad enough to accept
// ChatSessionLike from chat.ts or SessionLike from chat-result-flow.ts.
interface ResultNotifierSessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  [key: string]: unknown
}

// Chat function signature — accepts the session, userText, ctx, and
// optional run options. Parameter types are relaxed to Record<string, unknown>
// so that the concrete chat() function is assignable without identical imports.
// Callers should use type assertion when passing the actual chat function.
type ResultNotifierChatFn = (
  session: Record<string, unknown>,
  userText: string,
  ctx: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>

// RetellAgentResult function signature — accepts agent result and options.
// Callers should use type assertion when passing the actual retellAgentResult function.
type ResultNotifierRetellAgentResultFn = (
  agentResult: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<string>

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
function shouldNotifyTask(task: ResourceTask): boolean {
  const notify = task?.notify || {}
  if (!notify || notify.status === 'sent' || notify.status === 'skipped') return false
  if (notify.status === 'failed' && isFailedNotifyCoolingDown(notify)) return false
  return task.status === 'done' || (task.status === 'failed' && task.kind === 'daily_report' && notify.failureNotificationVersion === 2)
}

// 复用发送失败冷却，避免未知送达状态在每次轮询中立刻重试。
function isFailedNotifyCoolingDown(notify: ResourceTaskNotify, now = Date.now()): boolean {
  const updatedAtMs = Date.parse(String(notify?.updatedAt || ''))
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false
  return now - updatedAtMs < FAILED_NOTIFY_RETRY_COOLDOWN_MS
}

// 仅按任务存储实际写回的状态计入通知结果。
function didNotifyStatusPersist(next: ResourceTask | null | undefined, expectedStatus: string): boolean {
  return String(next && next.notify && next.notify.status || '') === expectedStatus
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
  const text = readReportText(result)
  const reason = String(result.reason || '')
  const mode = String(result.mode || '')
  let prefix = ''
  if (mode === 'text' && /render_failed/i.test(reason)) prefix = '图片生成失败，已发送文字版日报。\n\n'
  else if (mode === 'text') prefix = '当前资源不足或图片不可用，已发送文字版日报。\n\n'
  else if (mode === 'summary') prefix = '当前可用内容较少，已发送摘要版日报。\n\n'
  if (!text.trim()) throw new Error('日报完整文字结果为空，无法发送')
  return `${prefix}${text}`
}

// 优先在段落或换行边界分段；超长单段完整切分且不拆开代理对。
function splitDailyReportText(text: string, maxChars = 3900): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > 3900) throw new Error('日报文字分段长度无效')
  const segments: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const paragraphEnd = text.lastIndexOf('\n\n', end - 2)
      const lineEnd = text.lastIndexOf('\n', end - 1)
      if (paragraphEnd >= start) end = paragraphEnd + 2
      else if (lineEnd >= start) end = lineEnd + 1
      else if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
    }
    segments.push(text.slice(start, end))
    start = end
  }
  return segments
}

// 发送回执仅采用已核实的 OneBot 数字消息号或 Koishi 非空消息号数组。
function hasConfirmedSendReceipt(receipt: unknown, internal: boolean): boolean {
  if (internal) return typeof receipt === 'number' && Number.isSafeInteger(receipt) && receipt !== 0
  return Array.isArray(receipt) && receipt.length > 0 && receipt.every(id => typeof id === 'string' && id.trim().length > 0)
}

// 判断 Agent 结果里是否存在通知层必须拦截的搜索失败材料。
function hasHardSearchFailureSignal(result: AgentNotifyResultLike): boolean {
  const parts: string[] = []
  if (result.reply) parts.push(String(result.reply))
  if (result.message) parts.push(String(result.message))
  for (const item of Array.isArray(result.toolResults) ? result.toolResults : []) {
    if (item?.name) parts.push(String(item.name))
    if (item?.result) parts.push(String(item.result))
  }
  const material = parts.join('\n')
  return AGENT_NOTIFY_HARD_SEARCH_FAILURE_RE.test(material) && !AGENT_NOTIFY_SEARCH_SUCCESS_RE.test(material)
}

// 判断任务是否来自普通聊天自动触发的 heavy tool。
function isChatHeavyToolTask(task: ResourceTask | null | undefined): boolean {
  const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {}
  return String(payload.entry || '') === 'chat-heavy-tool'
}

// 判断 result 是否有值得发给群的正文。
function hasAgentSendableText(result: ResultNotifierResult): boolean {
  const text = String(result.reply || result.message || '').trim()
  return !!text && !EMPTY_AGENT_REPLY_RE.test(text)
}

function resolveNotifierTarget(target: string): { type: 'private' | 'group'; id: string } {
  const text = String(target || '').trim()
  if (!text) return { type: 'group', id: '' }
  if (/^private:/.test(text)) return { type: 'private', id: text.slice('private:'.length).trim() }
  return { type: 'group', id: text }
}

// 通过 Koishi bot 或 OneBot internal API 发送文字。
async function sendNotifierText(bot: ResultNotifierBotLike | null | undefined, target: string, text: string): Promise<boolean> {
  if (!bot) throw new Error('bot unavailable for result notifier')
  const resolved = resolveNotifierTarget(target)
  if (resolved.type === 'private') {
    if (!resolved.id) throw new Error('private notify target is empty')
    if (typeof bot.sendPrivateMessage === 'function') {
      return hasConfirmedSendReceipt(await bot.sendPrivateMessage(resolved.id, text), false)
    }
    if (bot.internal && typeof bot.internal.sendPrivateMsg === 'function') {
      return hasConfirmedSendReceipt(await bot.internal.sendPrivateMsg(resolved.id, [{ type: 'text', data: { text } }]), true)
    }
    throw new Error('bot private text send API unavailable for result notifier')
  }
  if (!resolved.id) throw new Error('group notify target is empty')
  if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    return hasConfirmedSendReceipt(await bot.internal.sendGroupMsg(resolved.id, [{ type: 'text', data: { text } }]), true)
  }
  if (typeof bot.sendMessage === 'function') {
    return hasConfirmedSendReceipt(await bot.sendMessage(resolved.id, text), false)
  }
  throw new Error('bot text send API unavailable for result notifier')
}

// 通过 OneBot internal API 或 Koishi h.image fallback 发送日报图片。
async function sendNotifierImage(bot: ResultNotifierBotLike | null | undefined, target: string, imagePath: string): Promise<boolean> {
  if (!bot) throw new Error('bot unavailable for result notifier')
  const base64 = fs.readFileSync(imagePath).toString('base64')
  if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    return hasConfirmedSendReceipt(await bot.internal.sendGroupMsg(target, [{ type: 'image', data: { file: `base64://${base64}` } }]), true)
  }
  if (typeof bot.sendMessage === 'function') {
    return hasConfirmedSendReceipt(await bot.sendMessage(target, h.normalize(h.image(`data:image/png;base64,${base64}`))), false)
  }
  throw new Error('bot image send API unavailable for result notifier')
}

// 构造注入给 notifyCompletedTasks 的日报发送器。
function createDailyReportSender(options: DailyReportSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  return async (task: ResourceTask, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') !== 'daily_report') return false
    const notify = task?.notify || {}
    const target = String(notify.channelKey || task?.channelKey || '')
    if (!target) throw new Error('daily report notify target is empty')

    const failure = task.status === 'failed'
    if (failure && (notify.failureNotificationVersion !== 2 || result.failureNotificationVersion !== 2
      || !['generation_failed', 'total_timeout'].includes(String(result.failureKind)))) return false
    if (!failure && task.status !== 'done') return false
    const saved = notify.dailyReportDelivery
    const mode: DailyReportDeliveryProgress['mode'] = failure ? 'failure' : saved?.mode || (hasReportImage(result) ? 'image' : 'text')
    const material = mode === 'failure' ? (result.failureKind === 'total_timeout' ? REPORT_TIMEOUT_TEXT : REPORT_FAILURE_TEXT)
      : mode === 'image' ? fs.readFileSync(String(result.imagePath || '')) : buildDailyReportTextMessage(result)
    const contentHash = createHash('sha256').update(material).digest('hex')
    const segments = mode === 'image' ? [''] : splitDailyReportText(String(material))
    let progress: DailyReportDeliveryProgress = saved || { version: 2, mode, contentHash, totalSegments: segments.length,
      confirmedSegments: 0, pendingSegment: null, state: 'ready' }
    // 内容改变时不能猜测旧编号对应哪段；确认过的正文不允许重新从头发送。
    if (progress.version !== 2 || progress.mode !== mode || progress.contentHash !== contentHash || progress.totalSegments !== segments.length
      || !Number.isInteger(progress.confirmedSegments) || progress.confirmedSegments < 0 || progress.confirmedSegments > segments.length) throw new Error('日报通知内容或分段进度已变化，请到控制台检查')
    if (progress.confirmedSegments === segments.length) return true
    for (let index = progress.confirmedSegments; index < segments.length; index++) {
      progress = { ...progress, pendingSegment: index, state: 'sending' }
      updateDailyReportDeliveryProgress(task, progress)
      try {
        const content = mode === 'text' && segments.length > 1 ? `日报文字版（第 ${index + 1}/${segments.length} 段）\n\n${segments[index]}` : segments[index]
        const confirmed = mode === 'image' ? await sendNotifierImage(bot, target, String(result.imagePath)) : await sendNotifierText(bot, target, content)
        if (!confirmed) throw new Error('发送接口没有返回有效消息回执')
        progress = { ...progress, confirmedSegments: index + 1, pendingSegment: null, state: 'confirmed' }
        updateDailyReportDeliveryProgress(task, progress)
      } catch (error) {
        // 调用已开始却没有可落盘回执：明确未知，下一次仅重试未确认段。
        updateDailyReportDeliveryProgress(task, { ...progress, pendingSegment: index, confirmedSegments: index, state: 'unknown' })
        throw new Error(`日报发送结果未知（第 ${index + 1}/${segments.length} 段），已确认段不会重发：${getNotifierErrorMessage(error)}`)
      }
    }
    if (logger) logger.info(`daily report notified: task=${task.id}, mode=${mode}, segments=${segments.length}`)
    return true
  }
}

// Build the text sent for standalone QQ Agent worker results.
function buildAgentTaskTextMessage(result: ResultNotifierResult, task: ResourceTask | null = null): string {
  const reply = String(result.reply || result.message || '').trim()
  const pendingId = String(result.pendingId || '')
  const suffix = pendingId ? `\n\n需要确认的工具 ID: ${pendingId}` : ''
  const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {}
  const entry = String(payload.entry || '')
  const fallback = entry === 'chat-heavy-tool'
    ? '后台工具没有返回可靠结果。'
    : 'Agent 后台任务已完成，但没有返回可发送内容。'
  const agentResult: AgentNotifyResultLike = {
    reply,
    message: result.message,
    toolResults: Array.isArray(result.toolResults) ? result.toolResults.slice(0, 20) as AgentNotifyResultLike['toolResults'] : [],
  }
  if (!hasAgentSendableText(result)) return ''
  if (hasHardSearchFailureSignal(agentResult) || hasSearchFailureMaterial(agentResult)) return `这次搜索没有拿到可靠结果，不能据此下结论。${suffix}`.slice(0, 4000)
  const safeReply = guardAgentRetellReply(redactAgentMaterial(reply), agentResult, {
    searchFailureFallback: '这次搜索没有拿到可靠结果，不能据此下结论。',
  })
  return `${safeReply || fallback}${suffix}`.slice(0, 4000)
}

// Extract session info from task.payload.agentWorker for retellAgentResult.
function extractSessionFromPayload(task: ResourceTask): {
  session: ResultNotifierSessionLike
  channelKey: string
  userId: string
  userName: string
  userText: string
} {
  const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {}
  const agentWorker = payload.agentWorker && typeof payload.agentWorker === 'object' ? payload.agentWorker as Record<string, unknown> : {}
  const engineInput = agentWorker.engineInput && typeof agentWorker.engineInput === 'object' ? agentWorker.engineInput as Record<string, unknown> : {}
  const channelKey = String(engineInput.channelKey || task?.channelKey || payload.channelKey || '')
  const userId = String(engineInput.userId || task?.userId || payload.userId || '')
  const userName = String(engineInput.userName || payload.userName || '')
  const userText = String(engineInput.userMessage || payload.userMessage || '')
  const isDirect = /^private:/i.test(channelKey)
  const session: ResultNotifierSessionLike = {
    guildId: isDirect ? undefined : channelKey,
    channelId: channelKey,
    isDirect,
    userId,
    username: userName,
  }
  return { session, channelKey, userId, userName, userText }
}

// Construct a sender for standalone QQ Agent worker results.
function createAgentTaskSender(options: ResourceResultSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  // Type assertions for external dependencies - these are safe because the
  // caller (plugin-lifecycle.ts) passes the actual functions from chat.ts
  // and chat-result-flow.ts, which have compatible signatures.
  const ctx = options.ctx as ResultNotifierContextLike | null
  const chatFn = options.chat as ResultNotifierChatFn | null
  const retellAgentResultFn = options.retellAgentResult as ResultNotifierRetellAgentResultFn | null
  return async (task: ResourceTask, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') !== 'agent_task') return false
    const notify = task?.notify || {}
    const target = String(notify.channelKey || task?.channelKey || '')
    if (!target) throw new Error('agent task notify target is empty')
    if (isChatHeavyToolTask(task) && !hasAgentSendableText(result)) {
      if (logger) logger.info(`chat-heavy-tool notify skipped empty result: task=${task.id}, target=${target}`)
      return true
    }

    // Try retellAgentResult for persona retelling when dependencies are available
    if (ctx && chatFn && retellAgentResultFn) {
      const { session, channelKey, userId, userName, userText } = extractSessionFromPayload(task)
      if (channelKey && userId && userText) {
        const agentResult: Record<string, unknown> = {
          reply: result.reply,
          toolResults: Array.isArray(result.toolResults) ? result.toolResults.slice(0, 20) : [],
          toolCalls: result.toolCalls,
          pendingId: result.pendingId,
        }
        try {
          const retoldText = await retellAgentResultFn(agentResult, {
            ctx,
            session,
            channelKey,
            currentUserId: userId,
            userName: userName || '用户',
            userText,
            chat: chatFn,
          })
          const finalText = String(retoldText || '').trim()
          if (finalText) {
            const pendingId = String(result.pendingId || '')
            const suffix = pendingId ? `\n\n需要确认的工具 ID: ${pendingId}` : ''
            const textToSend = `${finalText}${suffix}`.slice(0, 4000)
            await sendNotifierText(bot, target, textToSend)
            if (logger) logger.info(`agent task retold text notified: task=${task.id}, target=${target}`)
            return true
          }
        } catch (error) {
          if (logger) logger.warn(`agent task retell failed, falling back to guard: task=${task.id}, error=${getNotifierErrorMessage(error)}`)
        }
      }
    }

    // Fallback: original guardAgentRetellReply + redactAgentMaterial path
    const text = buildAgentTaskTextMessage(result, task)
    if (!text.trim()) {
      if (logger) logger.info(`agent task notify skipped empty text: task=${task.id}, target=${target}`)
      return true
    }
    await sendNotifierText(bot, target, text)
    if (logger) logger.info(`agent task text notified: task=${task.id}, target=${target}`)
    return true
  }
}

// Construct a sender for background emotion render results.
function createEmotionRenderSender(options: ResourceResultSenderOptions = {}): ResultNotifierSender {
  const bot = options.bot || null
  const logger = options.logger || null
  return async (task: ResourceTask, result: ResultNotifierResult): Promise<boolean> => {
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
  return async (task: ResourceTask, result: ResultNotifierResult): Promise<boolean> => {
    if (String(task?.kind || '') === 'daily_report') return dailySender(task, result)
    if (String(task?.kind || '') === 'agent_task') return agentSender(task, result)
    if (String(task?.kind || '') === 'emotion_render') return emotionSender(task, result)
    return false
  }
}

// 扫描已完成任务及带新通知标记的失败日报；发送由主进程注入。
async function notifyCompletedTasks(options: NotifyCompletedOptions = {}): Promise<Record<string, unknown>> {
  const tasks = listTerminalTasksForNotification(shouldNotifyTask, Math.max(1, Math.min(500, Number(options.limit || 100))))
  let sent = 0
  let skipped = 0
  let failed = 0
  for (const task of tasks) {
    const notify = task.notify || {}
    const target = String(notify.target || 'none')
    const result = readTaskResult(String(task.id || ''))
    if (target === 'none' || target === 'dashboard' || /^media_/i.test(String(task.kind || ''))) {
      const next = updateTaskNotifyStatus(task, 'skipped')
      if (didNotifyStatusPersist(next, 'skipped')) skipped++
      continue
    }
    if (!options.sender) {
      continue
    }
    try {
      const ok = await Promise.resolve(options.sender(task, result))
      const next = updateTaskNotifyStatus(task, ok ? 'sent' : 'failed', ok ? '' : 'sender returned false')
      if (ok) {
        if (didNotifyStatusPersist(next, 'sent')) sent++
      } else if (didNotifyStatusPersist(next, 'failed')) {
        failed++
      }
    } catch (error) {
      const next = updateTaskNotifyStatus(task, 'failed', error instanceof Error ? error.message : String(error || 'notify failed'))
      if (didNotifyStatusPersist(next, 'failed')) failed++
    }
  }
  return { scanned: tasks.length, sent, skipped, failed }
}

export = {
  readTaskResult,
  hasHardSearchFailureSignal,
  isChatHeavyToolTask,
  hasAgentSendableText,
  buildAgentTaskTextMessage,
  extractSessionFromPayload,
  createDailyReportSender,
  splitDailyReportText,
  createAgentTaskSender,
  createEmotionRenderSender,
  createResourceResultSender,
  notifyCompletedTasks,
}
