/**
 * MODULE: 配置和常量定义。
 * 边界: 只定义静态配置，不含业务逻辑。
 */

const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { DATA_DIR } = loadManagementModule('core.constants')

// 限时配置
const TIMEOUTS = {
  aiRequest: 30000,
  cooldown: 60000,
}

// 调试用：强制指定模板（仅通过环境变量 DAILY_REPORT_TEMPLATE 触发）
const FORCE_TEMPLATE = process.env.DAILY_REPORT_TEMPLATE || ''

export = {
  DATA_DIR,
  TIMEOUTS,
  FORCE_TEMPLATE,
}
