/**
 * MODULE: 命令处理结果封装。
 * 边界: 不读取配置、不访问 session、不调 AI API、不修改 conversation。
 * 状态: 无运行时状态。
 */

function handled(response) {
  return { matched: true, response }
}

function notHandled() {
  return { matched: false }
}

module.exports = {
  handled,
  notHandled,
}
