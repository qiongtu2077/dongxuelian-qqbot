/**
 * Agent 工具: create_reminder — 基于现有 cron 注册一次性提醒。
 */
const { registerOnceTask } = require('../cron')

const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000

function resolveRunAt(params = {}, now = Date.now()) {
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

function resolveReminderTarget(context = {}) {
  const channelKey = String(context.channelKey || '').trim()
  const userId = String(context.userId || '').trim()
  if (channelKey === 'private' && userId) return `private:${userId}`
  return channelKey
}

async function executeCreateReminder(params = {}, context = {}) {
  if (context.randomTriggered) return '随机主动回复不能创建提醒。'
  const targetChannel = resolveReminderTarget(context)
  if (!targetChannel) return '无法确定提醒发送目标。'
  const now = Date.now()
  const runAt = resolveRunAt(params, now)
  const delay = runAt - now
  if (!Number.isFinite(runAt) || delay < MIN_DELAY_MS) return '提醒时间太近或无效。'
  if (delay > MAX_DELAY_MS) return '提醒时间太远，最多支持 30 天内的一次性提醒。'
  const text = String(params.text || params.message || '提醒时间到了。').replace(/\s+/g, ' ').trim().slice(0, 500) || '提醒时间到了。'
  const prompt = text.startsWith('提醒') ? text : `提醒：${text}`
  const cron = await registerOnceTask({
    type: 'text',
    prompt,
    targetChannel,
    targetUserId: context.userId || '',
    createdBy: context.userId || '',
    createdFrom: context.channel || 'qq',
    runAt,
  })
  return `已创建提醒：${prompt}，触发时间 ${new Date(cron.runAt).toLocaleString('zh-CN', { hour12: false })}。`
}

module.exports = {
  definition: {
    name: 'create_reminder',
    description: '创建一次性提醒。用户明确说“几分钟后提醒我/到点叫我/明天提醒”时调用；随机主动回复不能调用。',
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
  execute: executeCreateReminder,
  resolveRunAt,
  dangerous: false,
  defaultChannels: ['qq', 'dashboard'],
}
