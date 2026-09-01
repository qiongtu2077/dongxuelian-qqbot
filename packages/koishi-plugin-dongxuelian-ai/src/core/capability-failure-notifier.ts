/**
 * MODULE: 能力优先级故障通知。
 * 职责: 对供应商/模型故障做 30 分钟冷却，并动态通知全部超级管理员。
 * 边界: 通知失败只记录脱敏警告，不影响模型回退或用户请求。
 */
const { getAdminUserIds } = require('./runtime-config') as typeof import('./runtime-config')
const { getProviderCatalogEntry } = require('./ai-capability-config') as typeof import('./ai-capability-config')

interface NotificationBot {
  sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown
  internal?: { sendPrivateMsg?: (id: string, message: unknown) => Promise<unknown> | unknown }
}

interface NotificationContext {
  bots?: NotificationBot[]
  bot?: NotificationBot
}

type FailureSender = (adminId: string, message: string) => Promise<unknown>

const FAILURE_NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000
const failureCooldowns = new Map<string, number>()
let failureSender: FailureSender | null = null

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

// --- 冷却与通知 ---

// 清理过期冷却项，防止长期运行进程无限增长。
function pruneFailureCooldowns(now: number): void {
  for (const [key, expiresAt] of failureCooldowns) {
    if (expiresAt <= now) failureCooldowns.delete(key)
  }
}

// 对一个失败步骤通知全部动态管理员，同一供应商/模型 30 分钟内只发送一次。
async function notifyCapabilityStepFailure(providerId: string, model: string, now = Date.now()): Promise<boolean> {
  const provider = getProviderCatalogEntry(providerId)
  const providerName = provider?.name || String(providerId || 'unknown')
  const modelName = String(model || 'unknown')
  const cooldownKey = `${providerId}\u0000${modelName}`
  pruneFailureCooldowns(now)
  if ((failureCooldowns.get(cooldownKey) || 0) > now) return false
  failureCooldowns.set(cooldownKey, now + FAILURE_NOTIFICATION_COOLDOWN_MS)
  const admins = [...getAdminUserIds(true)]
  const message = `高优先级模型出错，请管理员去控制台查看\n供应商：${providerName}\n模型：${modelName}`
  if (!failureSender || !admins.length) return false
  await Promise.all(admins.map(async adminId => {
    try {
      await failureSender?.(adminId, message)
    } catch {
      console.warn(`[ai-capability] failure_notification_failed provider=${providerId} model=${modelName}`)
    }
  }))
  return true
}

// 清空冷却状态，供测试和插件卸载时释放内存。
function resetCapabilityFailureNotifier(): void {
  failureCooldowns.clear()
  failureSender = null
}

export = {
  FAILURE_NOTIFICATION_COOLDOWN_MS,
  setCapabilityFailureSender,
  registerCapabilityFailureContext,
  notifyCapabilityStepFailure,
  resetCapabilityFailureNotifier,
}
