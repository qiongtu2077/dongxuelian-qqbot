/**
 * MODULE: 文件追问取证守卫。
 * 职责: 判断模型是否已对文件问题完成取证；未取证时补一次 analyze_file。
 * 边界: 不调用 AI API、不发送消息、不写对话历史。
 */
const { getRecentFiles } = require('./file-store')
const analyzeFileTool = require('./agent/tools/analyze-file')

function normalize(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function looksLikeFileFollowup(userText = '', recentFiles = []) {
  const text = normalize(userText)
  if (!text || !Array.isArray(recentFiles) || !recentFiles.some(file => file && !file.skipped)) return false
  const hasFileWord = /文件|文档|附件/.test(text)
  const hasReference = hasFileWord || /这个|那个|刚才|刚刚|上面|前面|里面|内容/.test(text)
  const asksContent = /说了什么|写了什么|是什么|有啥|有什么|内容|里面|解析|总结|读|看/.test(text)
  return hasReference && asksContent
}

function toolCallsIncludeAnalyzeFile(toolCalls = []) {
  return Array.isArray(toolCalls) && toolCalls.some(tc => tc?.function?.name === 'analyze_file')
}

function toolResultsIncludeFileEvidence(results = []) {
  return Array.isArray(results) && results.some(item => {
    const content = String(item?.content || '')
    return /---文件内容开始---|\[用户上传文件:|\[文件解析失败:|下载失败|无法提取内容|找到\d+个文件/.test(content)
  })
}

async function buildFileFollowupState(channelKey, userText) {
  const recentFiles = channelKey ? await getRecentFiles(channelKey, 15) : []
  return {
    recentFiles,
    shouldVerify: looksLikeFileFollowup(userText, recentFiles),
  }
}

async function resolveUnguardedFileFollowup(state = {}, context = {}) {
  if (!state.shouldVerify) return null
  if (state.usedAnalyzeFile || state.hasFileEvidence) return null
  return analyzeFileTool.execute({}, context)
}

module.exports = {
  looksLikeFileFollowup,
  toolCallsIncludeAnalyzeFile,
  toolResultsIncludeFileEvidence,
  buildFileFollowupState,
  resolveUnguardedFileFollowup,
}
