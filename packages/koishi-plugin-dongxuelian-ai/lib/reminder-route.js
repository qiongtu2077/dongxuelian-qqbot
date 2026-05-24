/**
 * MODULE: 提醒请求兜底解析。
 * 职责: 在模型明明该调用 create_reminder 却拒绝时，从明确短句中提取一次性提醒参数。
 * 边界: 不调度任务、不发消息；真正创建由 create-reminder 工具完成。
 */

const RELATIVE_UNITS_MS = {
  秒: 1000,
  分钟: 60 * 1000,
  分: 60 * 1000,
  小时: 60 * 60 * 1000,
  钟头: 60 * 60 * 1000,
  天: 24 * 60 * 60 * 1000,
}

const CHINESE_NUMBERS = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

function parseChineseInteger(text = '') {
  const value = String(text || '').trim()
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value === '十') return 10
  const tenIndex = value.indexOf('十')
  if (tenIndex >= 0) {
    const left = value.slice(0, tenIndex)
    const right = value.slice(tenIndex + 1)
    const tens = left ? (CHINESE_NUMBERS[left] || 0) : 1
    const ones = right ? (CHINESE_NUMBERS[right] || 0) : 0
    return tens * 10 + ones
  }
  return CHINESE_NUMBERS[value] || 0
}

function stripReminderNoise(text = '') {
  return String(text || '')
    .replace(/^说错了[，,、\s]*/, '')
    .replace(/^(?:麻烦|帮我|记得|到时候|等会儿|等下)[，,、\s]*/, '')
    .replace(/[。.!！~～\s]+$/g, '')
    .trim()
}

function parseReminderRequest(text = '', now = Date.now()) {
  const value = stripReminderNoise(text)
  if (!value || !/(提醒|叫我|喊我|闹钟)/.test(value)) return null
  const relative = value.match(/([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,4})\s*(秒|分钟|分|小时|钟头|天)后/)
  if (!relative) return null
  const amount = parseChineseInteger(relative[1])
  const unitMs = RELATIVE_UNITS_MS[relative[2]]
  if (!amount || !unitMs) return null
  const delayMs = amount * unitMs
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null
  let reminderText = value
    .replace(relative[0], '')
    .replace(/^(?:提醒|叫|喊|闹钟)(?:我)?[，,、\s]*/, '')
    .replace(/^(?:我)?(?:提醒|叫|喊)[，,、\s]*/, '')
    .replace(/^(?:提醒我|叫我|喊我|设个闹钟|定个闹钟)[，,、\s]*/, '')
    .trim()
  if (!reminderText) reminderText = '时间到了'
  return {
    runAt: now + delayMs,
    delayMinutes: delayMs / (60 * 1000),
    text: reminderText.slice(0, 200),
  }
}

function isReminderCapabilityRefusal(reply = '') {
  const text = String(reply || '')
  if (!text) return false
  if (!/(提醒|闹钟|定时|到点|叫你|叫我)/.test(text)) return false
  return /(?:做不到|不能|没法|无法|不会|不是.{0,8}(?:闹钟|助手)|不支持|干不来)/.test(text)
}

module.exports = {
  parseReminderRequest,
  isReminderCapabilityRefusal,
}
