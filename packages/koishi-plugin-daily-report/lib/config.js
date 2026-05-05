/**
 * MODULE: 配置和常量定义。
 * 边界: 只定义静态配置，不含业务逻辑。
 */

const { DATA_DIR } = require('../../koishi-plugin-dongxuelian-ai/lib/constants')

// 限时配置
const TIMEOUTS = {
  aiRequest: 30000,
  cooldown: 60000,
}

// 调试用：强制指定模板（仅通过环境变量 DAILY_REPORT_TEMPLATE 触发）
const FORCE_TEMPLATE = process.env.DAILY_REPORT_TEMPLATE || ''

module.exports = {
  DATA_DIR,
  TIMEOUTS,
  FORCE_TEMPLATE,
}
