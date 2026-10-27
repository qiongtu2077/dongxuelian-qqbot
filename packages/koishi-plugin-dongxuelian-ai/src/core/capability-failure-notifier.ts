/**
 * MODULE: 能力优先级故障通知。
 * 职责: 每个业务失败独立通知全部超级管理员，附带脱敏原因和关联编号。
 * 边界: 通知失败只记录脱敏警告，不影响模型回退或用户请求。
 */
const { getAdminUserIds } = require('./runtime-config') as typeof import('./runtime-config')
const { AI_CAPABILITIES, getProviderCatalogEntry } = require('./ai-capability-config') as typeof import('./ai-capability-config')
const { sanitizeDiagnosticText, formatModelHttpStatus } = require('./request-diagnostics') as typeof import('./request-diagnostics')
type AiCapability = (typeof AI_CAPABILITIES)[number]

interface NotificationBot {
  sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown
  internal?: { sendPrivateMsg?: (id: string, message: unknown) => Promise<unknown> | unknown }
}

interface NotificationContext {
  bots?: NotificationBot[]
  bot?: NotificationBot
}

type FailureSender = (adminId: string, message: string) => Promise<unknown>

// 保留公开常量名；实际业务失败不再冷却去重。
const FAILURE_NOTIFICATION_COOLDOWN_MS = 0
const CAPABILITY_LABELS: Record<AiCapability, string> = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' }
let failureSender: FailureSender | null = null
interface FailureNotice {
  purpose?: string; reason?: string; status?: number; code?: string; summary?: string
  upstreamCode?: string; upstreamRequestId?: string; requestId?: string
}

// --- 发送器注册 ---

// 注册可测试的私聊发送器；传 null 可在插件卸载时清理上下文引用。
function setCapabilityFailureSender(sender: FailureSender | null): void {
  failureSender = sender
}

// 从 Koishi 上下文选择可用 Bot 并注册私聊发送器。
function registerCapabilityFailureContext(ctx: NotificationContext): void {
  setCapabilityFailureSender(async (adminId, message) => {
    const bot = (Array.isArray(ctx.bots) ? ctx.bots.find(item => !!item) : null) || ctx.bot
    if (!bot) throw new Error('没有可用 Bot')
    if (typeof bot.sendPrivateMessage === 'function') return bot.sendPrivateMessage(adminId, message)
    if (bot.internal && typeof bot.internal.sendPrivateMsg === 'function') {
      return bot.internal.sendPrivateMsg(adminId, [{ type: 'text', data: { text: message } }])
    }
    throw new Error('Bot 不支持私聊发送')
  })
}

// --- 逐次通知 ---

// 对当前失败步骤立即发送；发送卡住时有界退出，让备用链继续。
async function notifyCapabilityStepFailure(providerId: string, model: string, capability: AiCapability, details: FailureNotice = {}): Promise<boolean> {
  const provider = getProviderCatalogEntry(providerId)
  const providerName = provider?.name || String(providerId || 'unknown')
  const modelName = String(model || 'unknown')
  const admins = [...getAdminUserIds(true)]
  const purposes: Record<string, string> = { chat: '聊天', vision: '识图', topic_switch: '话题判断', identity_judge: '身份判断', retaliation_score: '敌意评分', 'voice-asr': '语音识别', 'voice-tts': '语音合成' }
  const message = [
    details.purpose === 'retaliation_score' ? '敌意评分节点调用失败' : `${CAPABILITY_LABELS[capability]}模型调用失败`,
    `用途：${purposes[details.purpose || ''] || details.purpose || CAPABILITY_LABELS[capability]}`,
    `供应商：${sanitizeDiagnosticText(providerName)}`, `模型：${sanitizeDiagnosticText(modelName)}`,
    `时间：${new Date().toISOString()}`, `原因：${sanitizeDiagnosticText(details.reason || '原因未明')}`,
    `状态：${formatModelHttpStatus(details.status || 0)}${details.code ? `｜${details.code}` : ''}`,
    ...(details.upstreamCode ? [`上游错误码：${sanitizeDiagnosticText(details.upstreamCode)}`] : []),
    `上游说明：${sanitizeDiagnosticText(details.summary || '未提供')}`,
    `请求编号：${details.requestId || '未提供'}`, `上游请求编号：${sanitizeDiagnosticText(details.upstreamRequestId || '未提供')}`,
  ].join('\n')
  if (!failureSender || !admins.length) return false
  await Promise.all(admins.map(async adminId => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([failureSender?.(adminId, message), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('通知发送超时')), 1500) })])
    } catch {
      console.warn(`[ai-capability] failure_notification_failed capability=${capability}`)
    } finally { if (timer) clearTimeout(timer) }
  }))
  return true
}

// 供测试和插件卸载时释放发送器引用。
function resetCapabilityFailureNotifier(): void {
  failureSender = null
}

export = {
  FAILURE_NOTIFICATION_COOLDOWN_MS,
  setCapabilityFailureSender,
  registerCapabilityFailureContext,
  notifyCapabilityStepFailure,
  resetCapabilityFailureNotifier,
}
