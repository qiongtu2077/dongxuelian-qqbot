/**
 * MODULE: 资源任务 kind 共享词汇表。
 * 职责: 提供资源子系统通用任务 kind 常量和纯分类 predicate。
 * 边界: 不包含预算、准入、队列、锁或 worker 执行器注册逻辑。
 */

const RESOURCE_TASK_KIND = {
  DAILY_REPORT: 'daily_report',
  DAILY_REPORT_RENDER: 'daily_report_render',
  DAILY_SUMMARY: 'daily_summary',
  AGENT_TASK: 'agent_task',
  DASHBOARD_AGENT: 'dashboard_agent',
  AGENT_MEMORY: 'agent_memory',
  AGENT_MEMORY_COMPACTION: 'agent_memory_compaction',
  EXPRESSION_HARVEST: 'expression_harvest',
  CONVERSATION_SUMMARY: 'conversation_summary',
  SENSITIVE_CACHE_ANALYSIS: 'sensitive_cache_analysis',
  EMOTION_RENDER: 'emotion_render',
  BROWSER_ACTION: 'browser_action',
  VOICE_TTS_GENERATION: 'voice_tts_generation',
  DIAGNOSTIC_PROBE: 'diagnostic_probe',
  MCP_LOCAL_CHECK: 'mcp_local_check',
  EXTERNAL_VIDEO_DOWNLOAD: 'external_video_download',
  PET_BRIDGE_CHAT: 'pet_bridge_chat',
  MEDIA_IMAGE_ANALYSIS: 'media_image_analysis',
  MEDIA_FILE_ANALYSIS: 'media_file_analysis',
  MEDIA_VOICE_TRANSCRIPTION: 'media_voice_transcription',
  STATUS_QUERY: 'status_query',
  NORMAL_CHAT: 'normal_chat',
} as const

const MEDIA_TASK_KINDS: Set<string> = new Set([
  RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS,
  RESOURCE_TASK_KIND.MEDIA_FILE_ANALYSIS,
  RESOURCE_TASK_KIND.MEDIA_VOICE_TRANSCRIPTION,
])

const CHROMIUM_TASK_KINDS: Set<string> = new Set([
  RESOURCE_TASK_KIND.DAILY_REPORT_RENDER,
  RESOURCE_TASK_KIND.BROWSER_ACTION,
])

const DAILY_REPORT_KINDS: Set<string> = new Set([
  RESOURCE_TASK_KIND.DAILY_REPORT,
  RESOURCE_TASK_KIND.DAILY_REPORT_RENDER,
])

const BACKGROUND_LLM_TASK_KINDS: Set<string> = new Set([
  RESOURCE_TASK_KIND.EXPRESSION_HARVEST,
  RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
  RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
])

function normalizeResourceTaskKind(kind: unknown): string {
  return String(kind || '')
}

function isStatusQueryKind(kind: unknown): boolean {
  return normalizeResourceTaskKind(kind) === RESOURCE_TASK_KIND.STATUS_QUERY
}

function isNormalChatKind(kind: unknown): boolean {
  return normalizeResourceTaskKind(kind) === RESOURCE_TASK_KIND.NORMAL_CHAT
}

function isImageMediaTaskKind(kind: unknown): boolean {
  return normalizeResourceTaskKind(kind) === RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS
}

function isFileMediaTaskKind(kind: unknown): boolean {
  return normalizeResourceTaskKind(kind) === RESOURCE_TASK_KIND.MEDIA_FILE_ANALYSIS
}

function isVoiceMediaTaskKind(kind: unknown): boolean {
  return normalizeResourceTaskKind(kind) === RESOURCE_TASK_KIND.MEDIA_VOICE_TRANSCRIPTION
}

function isMediaTaskKind(kind: unknown): boolean {
  return MEDIA_TASK_KINDS.has(normalizeResourceTaskKind(kind))
}

function isChromiumTaskKind(kind: unknown): boolean {
  return CHROMIUM_TASK_KINDS.has(normalizeResourceTaskKind(kind))
}

function isDailyReportKind(kind: unknown): boolean {
  return DAILY_REPORT_KINDS.has(normalizeResourceTaskKind(kind))
}

function isBackgroundLlmTaskKind(kind: unknown): boolean {
  return BACKGROUND_LLM_TASK_KINDS.has(normalizeResourceTaskKind(kind))
}

function shouldYieldToToolActiveKind(kind: unknown): boolean {
  const normalized = normalizeResourceTaskKind(kind)
  return normalized === RESOURCE_TASK_KIND.DAILY_SUMMARY
    || isBackgroundLlmTaskKind(normalized)
    || isMediaTaskKind(normalized)
}

export = {
  RESOURCE_TASK_KIND,
  normalizeResourceTaskKind,
  isStatusQueryKind,
  isNormalChatKind,
  isImageMediaTaskKind,
  isFileMediaTaskKind,
  isVoiceMediaTaskKind,
  isMediaTaskKind,
  isChromiumTaskKind,
  isDailyReportKind,
  isBackgroundLlmTaskKind,
  shouldYieldToToolActiveKind,
}
