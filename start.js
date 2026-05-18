// 启动入口：补丁已合并到 dongxuelian-ai/index.js，无需单独 patch
// @satorijs/core@3.7.0 缺失的 Session 方法由插件在加载时自动补齐

const path = require('path')

if (!process.env.KOISHI_DIR) process.env.KOISHI_DIR = process.cwd()
if (!process.env.DONGXUELIAN_AI_DATA_DIR) {
  process.env.DONGXUELIAN_AI_DATA_DIR = path.join(process.env.KOISHI_DIR, 'data')
}

require('koishi/lib/cli/start')
