/**
 * MODULE: 获取当前时间工具。
 */
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../../constants')
const TZ_FILE = path.join(DATA_DIR, 'agent-user-timezones.json')
const MAX_TZ_FILE_BYTES = 128 * 1024

function getUserTimezone(userId) {
  if (!userId) return ''
  try {
    const stat = fs.statSync(TZ_FILE)
    if (!stat.isFile() || stat.size > MAX_TZ_FILE_BYTES) return ''
    const data = JSON.parse(fs.readFileSync(TZ_FILE, 'utf8'))
    return String(data[String(userId)] || '')
  } catch { return '' }
}

module.exports = {
  definition: {
    name: 'get_current_time',
    description: '获取当前日期和时间。当用户问"现在几点"、"今天几号"、"星期几"时调用。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: '时区，默认用户偏好或 Asia/Shanghai' },
        userId: { type: 'string', description: '用户 ID，用于读取时区偏好，可选' },
      },
    },
  },
  async execute(params = {}) {
    const tz = params.timezone || getUserTimezone(params.userId) || 'Asia/Shanghai'
    const now = new Date()
    const locale = now.toLocaleString('zh-CN', { timeZone: tz })
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
    return `当前时间：${locale} 周${weekday} (${tz})\nISO: ${now.toISOString()}`
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
