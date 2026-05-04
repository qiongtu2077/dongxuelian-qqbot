/**
 * MODULE: 配置和常量定义。
 * 边界: 只定义静态配置，不含业务逻辑。
 */

// 数据目录（优先环境变量，fallback到主插件data目录）
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR
  || require('path').join(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'data')
if (!process.env.DONGXUELIAN_AI_DATA_DIR) {
  console.warn('[daily-report] 未设置 DONGXUELIAN_AI_DATA_DIR，使用 fallback:', DATA_DIR)
}

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
