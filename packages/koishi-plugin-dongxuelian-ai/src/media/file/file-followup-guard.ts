/**
 * MODULE: 文件追问取证守卫兼容入口。
 * 职责: 保留旧 deep require 路径；真实状态判断与取证桥接分别归属到 state/evidence 模块。
 * 边界: 新代码不应依赖本兼容壳作为主路径。
 */
const state = require('./file-followup-state') as typeof import('./file-followup-state')
const evidence = require('../../chat/file-followup-evidence') as typeof import('../../chat/file-followup-evidence')

interface RecentFileLike {
  skipped?: boolean
  ts?: number
  userId?: string
  messageId?: string
  fileName?: string
}

interface ToolCallLike {
  function?: {
    name?: string
  }
}

interface ToolResultLike {
  content?: unknown
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

const looksLikeFileFollowup: (userText?: string, recentFiles?: RecentFileLike[]) => boolean = state.looksLikeFileFollowup
const selectActiveFileAnchor: (recentFiles?: RecentFileLike[], context?: FileFollowupContext) => RecentFileLike | null = state.selectActiveFileAnchor
const buildFileFollowupState: (channelKey: string, userText: string, context?: FileFollowupContext) => Promise<FileFollowupState> = state.buildFileFollowupState
const toolCallsIncludeAnalyzeFile: (toolCalls?: ToolCallLike[]) => boolean = evidence.toolCallsIncludeAnalyzeFile
const toolResultsIncludeFileEvidence: (results?: ToolResultLike[]) => boolean = evidence.toolResultsIncludeFileEvidence
const selectFileEvidenceResult: (results?: ToolResultLike[]) => string = evidence.selectFileEvidenceResult
const resolveUnguardedFileFollowup: (state?: FileFollowupState, context?: FileFollowupContext) => Promise<string | ToolResultLike | null> = evidence.resolveUnguardedFileFollowup
const buildFileEvidenceReply: (fileEvidence?: string, targetFile?: RecentFileLike | null) => string = evidence.buildFileEvidenceReply

export = {
  looksLikeFileFollowup,
  toolCallsIncludeAnalyzeFile,
  toolResultsIncludeFileEvidence,
  selectFileEvidenceResult,
  selectActiveFileAnchor,
  buildFileFollowupState,
  resolveUnguardedFileFollowup,
  buildFileEvidenceReply,
}
