/* ==========================================================================
 * MODULE: file-quick-read
 * 职责: 处理“读文件/看文件/分析文件”等显式快捷读取意图，返回可发送摘要文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只读取文件元数据并触发文件分析。
 * 状态: 无模块级状态。
 * ========================================================================== */
const { getRecentFiles } = require('./file-store')
const { analyzeFileNow } = require('./file-analyzer')
const { summarizeFileContentForChat } = require('./file-safety')

const FILE_QUICK_READ_RE = /^(读文件|看文件|分析文件|打开文件|文件内容)$/

function isFileQuickReadIntent(text = '') {
  return FILE_QUICK_READ_RE.test(String(text || '').trim())
}

async function resolveFileQuickReadReply(channelKey) {
  const recentFiles = await getRecentFiles(channelKey, 10)
  const target = recentFiles.find(file => !file.skipped && !file.analyzed)
    || recentFiles.find(file => !file.skipped && file.analyzed)
  if (!target) return '没有找到最近可分析的文件。'
  if (target.analyzed && target.analysis) {
    return summarizeFileContentForChat(target.analysis, target.fileName)
  }
  const result = await analyzeFileNow(channelKey, target.messageId)
  if (result) return summarizeFileContentForChat(result, target.fileName)
  return '文件下载失败了，可能已经过期。如果还需要，请重新发一次文件。'
}

module.exports = {
  isFileQuickReadIntent,
  resolveFileQuickReadReply,
}
