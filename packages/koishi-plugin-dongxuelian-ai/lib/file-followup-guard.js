/**
 * MODULE: 文件追问取证守卫。
 * 职责: 判断模型是否已对文件问题完成取证；未取证时补一次 analyze_file。
 * 边界: 不调用 AI API、不发送消息、不写对话历史。
 */
const { getRecentFiles } = require('./file-store')
const analyzeFileTool = require('./agent/tools/analyze-file')
const { summarizeFileContentForChat } = require('./file-safety')

const FILE_FOLLOWUP_ACTIVE_WINDOW_MS = 30 * 60 * 1000

function normalize(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function looksLikeFileFollowup(userText = '', recentFiles = []) {
  const text = normalize(userText)
  if (!text || !Array.isArray(recentFiles) || !recentFiles.some(file => file && !file.skipped)) return false
  const hasFileWord = /文件|文档|附件/.test(text)
  const hasReference = hasFileWord || /这个|那个|刚才|刚刚|上面|前面|里面|内容/.test(text)
  const asksContent = /说了什么|写了什么|是什么|有啥|有什么|内容|里面|解析|总结|读|看|看一下|瞅瞅/.test(text)
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

function selectFileEvidenceResult(results = []) {
  if (!Array.isArray(results)) return ''
  const item = results.find(result => {
    const content = String(result?.content || '')
    return /---文件内容开始---|\[用户上传文件:|\[文件解析失败:|下载失败|无法提取内容|找到\d+个文件/.test(content)
  })
  return String(item?.content || '')
}

function selectActiveFileAnchor(recentFiles = [], context = {}) {
  const files = Array.isArray(recentFiles)
    ? recentFiles.filter(file => file && !file.skipped)
    : []
  if (!files.length) return null

  const now = Number(context.now || Date.now())
  const fresh = files.filter(file => {
    const ts = Number(file.ts || 0)
    return !Number.isFinite(ts) || ts <= 0 || now - ts <= FILE_FOLLOWUP_ACTIVE_WINDOW_MS
  })
  const candidates = fresh.length ? fresh : files
  const userId = String(context.userId || '').trim()
  const sameUser = userId ? candidates.filter(file => String(file.userId || '').trim() === userId) : []
  return sameUser[0] || candidates[0] || null
}

async function buildFileFollowupState(channelKey, userText, context = {}) {
  const recentFiles = channelKey ? await getRecentFiles(channelKey, 15) : []
  const shouldVerify = looksLikeFileFollowup(userText, recentFiles)
  return {
    recentFiles,
    shouldVerify,
    targetFile: shouldVerify ? selectActiveFileAnchor(recentFiles, context) : null,
  }
}

async function resolveUnguardedFileFollowup(state = {}, context = {}) {
  if (!state.shouldVerify) return null
  if (state.usedAnalyzeFile || state.hasFileEvidence) return null
  const messageId = state.targetFile && state.targetFile.messageId ? String(state.targetFile.messageId) : ''
  const toolContext = messageId
    ? { ...context, activeFileMessageId: messageId, activeFileName: state.targetFile.fileName || '' }
    : context
  return analyzeFileTool.execute(messageId ? { messageId } : {}, toolContext)
}

function buildFileEvidenceReply(fileEvidence = '', targetFile = null) {
  const evidence = String(fileEvidence || '').trim()
  if (!evidence) return ''
  if (/下载失败|已过期|无法提取内容|文件解析失败|找不到|没有收到|没有可用/.test(evidence)) {
    return evidence.slice(0, 1000)
  }
  const fileName = targetFile && targetFile.fileName ? targetFile.fileName : ''
  return summarizeFileContentForChat(evidence, fileName)
}

module.exports = {
  looksLikeFileFollowup,
  toolCallsIncludeAnalyzeFile,
  toolResultsIncludeFileEvidence,
  selectFileEvidenceResult,
  selectActiveFileAnchor,
  buildFileFollowupState,
  resolveUnguardedFileFollowup,
  buildFileEvidenceReply,
}
