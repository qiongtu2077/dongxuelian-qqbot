/**
 * MODULE: 文件追问状态判断。
 * 职责: 判断用户是否在追问近期文件，并选择可自动补读的弱锚点文件。
 * 边界: 不执行 analyze_file、不格式化证据回复、不发送消息、不写对话历史。
 */
const { getRecentFiles } = require('./file-store') as typeof import('./file-store')

const FILE_FOLLOWUP_ACTIVE_WINDOW_MS = 30 * 60 * 1000

interface RecentFileLike {
  skipped?: boolean
  ts?: number
  userId?: string
  messageId?: string
  fileName?: string
}

interface FileFollowupContext {
  now?: number
  userId?: string
  [key: string]: unknown
}

interface FileFollowupState {
  recentFiles?: RecentFileLike[]
  shouldVerify?: boolean
  usedAnalyzeFile?: boolean
  hasFileEvidence?: boolean
  targetFile?: RecentFileLike | null
}

function normalize(text: string = ''): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function looksLikeFileFollowupTextHint(userText: string = ''): boolean {
  const text = normalize(userText)
  if (!text) return false
  const hasFileWord = /文件|文档|附件/.test(text)
  const hasReference = hasFileWord || /这个|那个|刚才|刚刚|上面|前面|里面|内容/.test(text)
  const asksContent = /说了什么|写了什么|讲了什么|是什么|有啥|有什么|内容|里面|解析|总结|读|看|看一下|瞅瞅/.test(text)
  return hasReference && asksContent
}

function looksLikeFileFollowup(userText: string = '', recentFiles: RecentFileLike[] = []): boolean {
  if (!looksLikeFileFollowupTextHint(userText)) return false
  return Array.isArray(recentFiles) && recentFiles.some(file => file && !file.skipped)
}

function selectActiveFileAnchor(recentFiles: RecentFileLike[] = [], context: FileFollowupContext = {}): RecentFileLike | null {
  const files = Array.isArray(recentFiles)
    ? recentFiles.filter(file => file && !file.skipped)
    : []
  if (!files.length) return null

  const now = Number(context.now || Date.now())
  // L14: 模糊弱锚点自动补读只允许从 fresh（活跃窗口内）文件里选；过了窗口就返回 null 交给澄清，
  // 不自行猜一个过期旧文件来读。强锚点（reply / 明确 messageId / 文件名唯一命中 / read_group_context）走别的路径，不受此限制。
  const fresh = files.filter(file => {
    const ts = Number(file.ts || 0)
    return !Number.isFinite(ts) || ts <= 0 || now - ts <= FILE_FOLLOWUP_ACTIVE_WINDOW_MS
  })
  if (!fresh.length) return null
  const userId = String(context.userId || '').trim()
  // 群聊（有 userId）只自动补读当前用户自己的 fresh 文件；他人 fresh 文件不在模糊追问下自动读。
  // 私聊（无 userId）回退到 fresh[0]。
  const sameUser = userId ? fresh.filter(file => String(file.userId || '').trim() === userId) : []
  return sameUser[0] || (!userId ? fresh[0] : null)
}

async function buildFileFollowupState(channelKey: string, userText: string, context: FileFollowupContext = {}): Promise<FileFollowupState> {
  if (!looksLikeFileFollowupTextHint(userText)) {
    return {
      recentFiles: [],
      shouldVerify: false,
      targetFile: null,
    }
  }
  const recentFiles = channelKey ? await getRecentFiles(channelKey, 15) as RecentFileLike[] : []
  const shouldVerify = looksLikeFileFollowup(userText, recentFiles)
  return {
    recentFiles,
    shouldVerify,
    targetFile: shouldVerify ? selectActiveFileAnchor(recentFiles, context) : null,
  }
}

export = {
  looksLikeFileFollowup,
  selectActiveFileAnchor,
  buildFileFollowupState,
}
