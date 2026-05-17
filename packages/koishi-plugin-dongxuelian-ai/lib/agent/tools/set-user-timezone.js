/**
 * MODULE: 用户时区偏好工具。
 * 安全：仅写入 Agent 数据目录下的时区偏好 JSON。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../constants')

const TZ_FILE = path.join(DATA_DIR, 'agent-user-timezones.json')
const TZ_RE = /^[A-Za-z]+(?:[ _-][A-Za-z]+)*(?:\/[A-Za-z0-9_+.-]+)+$/
const MAX_TZ_FILE_BYTES = 128 * 1024
const MAX_TZ_ENTRIES = 2000

async function readMap() {
  try {
    const stat = await fs.stat(TZ_FILE)
    if (!stat.isFile() || stat.size > MAX_TZ_FILE_BYTES) return {}
    return JSON.parse(await fs.readFile(TZ_FILE, 'utf8'))
  } catch { return {} }
}

module.exports = {
  definition: {
    name: 'set_user_timezone',
    description: '设置用户时区偏好，例如 Asia/Shanghai、America/New_York。',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '用户 ID，不填则由 Agent 说明需要提供' },
        timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai' },
      },
      required: ['timezone'],
    },
  },
  async execute(params = {}) {
    const timezone = String(params.timezone || '').trim().replace(/\s+/g, '_')
    if (!TZ_RE.test(timezone)) throw new Error('时区格式无效，请使用 IANA 时区名，例如 Asia/Shanghai')
    try { new Date().toLocaleString('zh-CN', { timeZone: timezone }) } catch { throw new Error(`未知时区：${timezone}`) }
    const userId = String(params.userId || 'dashboard').trim() || 'dashboard'
    const data = await readMap()
    data[userId] = timezone
    const entries = Object.entries(data).slice(-MAX_TZ_ENTRIES)
    const next = Object.fromEntries(entries)
    await fs.mkdir(path.dirname(TZ_FILE), { recursive: true })
    await fs.writeFile(TZ_FILE, JSON.stringify(next, null, 2), 'utf8')
    return `已设置用户 ${userId} 的时区：${timezone}`
  },
  dangerous: false,
  defaultChannels: ['dashboard'],
}
