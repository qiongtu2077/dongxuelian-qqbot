/**
 * MODULE: 配置和常量定义。
 * 边界: 只定义静态配置，不含业务逻辑。
 */

// 数据目录（只信任环境变量，不fallback到相对路径）
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR
if (!DATA_DIR) {
  console.warn('[daily-report] 警告: 未设置 DONGXUELIAN_AI_DATA_DIR 环境变量')
}

// 限时配置
const TIMEOUTS = {
  aiRequest: 30000,
  cooldown: 60000,
}

module.exports = {
  DATA_DIR,
  TIMEOUTS,
}
