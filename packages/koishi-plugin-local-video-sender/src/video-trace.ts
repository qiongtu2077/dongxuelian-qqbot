/**
 * MODULE: 视频解析生命周期日志。
 * 职责: 生成链路编号、哈希视频键、限制事件字段并保证每条链路只有一个终态。
 * 边界: 不保存消息正文、Cookie、鉴权信息或完整 URL 查询。
 */
const crypto = require('crypto') as typeof import('crypto')

export const VIDEO_TRACE_EVENTS = [
  'input_detected',
  'input_normalized',
  'input_rejected',
  'cookie_health_checked',
  'shortlink_hop',
  'shortlink_failed',
  'admission_decided',
  'queue_write_started',
  'queue_persisted',
  'queue_persist_failed',
  'gate_acquired',
  'gate_released',
  'gate_storage_failed',
  'gate_admin_alert_sent',
  'gate_admin_alert_suppressed',
  'gate_admin_alert_summary',
  'probe_started',
  'probe_finished',
  'download_started',
  'download_finished',
  'preview_send_finished',
  'video_send_finished',
  'terminal_status',
] as const

export type VideoTraceEvent = typeof VIDEO_TRACE_EVENTS[number]
export type VideoTerminalStatus = 'done' | 'failed' | 'cancelled'

export interface VideoTraceContext {
  traceId: string
  taskId: string
  inputType: string
  videoKeyHash: string
  startedAt: number
}

export interface VideoTraceFields {
  stage?: string
  durationMs?: number
  errorId?: string
  reason?: string
  status?: VideoTerminalStatus
  shortCodeHash?: string
  hop?: number
  statusCode?: number
  finalHost?: string
  finalPath?: string
  decision?: string
  waiting?: number
  capacity?: number
  ok?: boolean
  code?: string
}

interface VideoTraceLogger {
  warn(...args: unknown[]): void
}

const terminalTraceIds = new Set<string>()
const allowedEvents = new Set<string>(VIDEO_TRACE_EVENTS)

// --- 编号与哈希 --- //

// 生成不包含会话或消息正文的随机视频链路编号。
export function createVideoTraceId(): string {
  return `video-trace-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`
}

// 对短链键或规范化视频键生成不可逆的短摘要。
export function hashVideoTraceValue(value: unknown): string {
  const text = String(value || '').trim()
  return text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : ''
}

// 创建一条尚未关联持久任务的生命周期上下文。
export function createVideoTrace(input: { traceId?: string, taskId?: string, inputType?: string, videoKey?: unknown, startedAt?: number } = {}): VideoTraceContext {
  return {
    traceId: sanitizeTraceId(input.traceId || createVideoTraceId()),
    taskId: sanitizeTraceId(input.taskId || ''),
    inputType: sanitizeTraceText(input.inputType || 'unknown', 40),
    videoKeyHash: hashVideoTraceValue(input.videoKey),
    startedAt: Number.isFinite(input.startedAt) ? Number(input.startedAt) : Date.now(),
  }
}

// 将真实任务编号附加到同一上下文，使后续终态继续携带 taskId。
export function withVideoTraceTask(trace: VideoTraceContext, taskId: unknown): VideoTraceContext {
  trace.taskId = sanitizeTraceId(taskId)
  return trace
}

// 返回补入规范化视频键摘要的新上下文，不保留原始键。
export function withVideoTraceKey(trace: VideoTraceContext, videoKey: unknown): VideoTraceContext {
  return { ...trace, videoKeyHash: hashVideoTraceValue(videoKey) }
}

// --- 脱敏与事件写入 --- //

// 把链路或任务编号限制为无空白的安全字符。
function sanitizeTraceId(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
}

// 清除 URL、Cookie 路径和常见鉴权键值后限制日志字段长度。
function sanitizeTraceText(value: unknown, maxLength: number = 160): string {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(cookie|authorization|token|sessdata)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[^\s]*bilibili-cookies[^\s]*/gi, '[cookies-file]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

// 将字段值编码成单行 JSON，避免空格或控制符破坏结构化日志。
function encodeTraceField(value: unknown): string {
  return JSON.stringify(value)
}

// 写入一个白名单事件；重复终态或非法终态会被拒绝。
export function writeVideoTrace(logger: VideoTraceLogger, trace: VideoTraceContext, event: VideoTraceEvent, fields: VideoTraceFields = {}): boolean {
  if (!allowedEvents.has(event) || !trace.traceId) return false
  if (event === 'terminal_status') {
    if (!fields.status || !['done', 'failed', 'cancelled'].includes(fields.status)) return false
    if (terminalTraceIds.has(trace.traceId)) return false
    terminalTraceIds.add(trace.traceId)
  }

  const values: Record<string, unknown> = {
    event,
    traceId: trace.traceId,
    taskId: trace.taskId || '',
    inputType: trace.inputType,
    videoKeyHash: trace.videoKeyHash,
    stage: sanitizeTraceText(fields.stage || event, 80),
    durationMs: Number.isFinite(fields.durationMs) ? Math.max(0, Math.round(Number(fields.durationMs))) : Math.max(0, Date.now() - trace.startedAt),
  }
  if (fields.errorId) values.errorId = sanitizeTraceText(fields.errorId, 32)
  if (fields.reason) values.reason = sanitizeTraceText(fields.reason)
  if (fields.status) values.status = fields.status
  if (fields.shortCodeHash) values.shortCodeHash = sanitizeTraceText(fields.shortCodeHash, 64)
  if (Number.isFinite(fields.hop)) values.hop = Math.max(0, Math.round(Number(fields.hop)))
  if (Number.isFinite(fields.statusCode)) values.statusCode = Math.round(Number(fields.statusCode))
  if (fields.finalHost) values.finalHost = sanitizeTraceText(fields.finalHost, 120)
  if (fields.finalPath) values.finalPath = sanitizeTraceText(String(fields.finalPath).split('?')[0], 200)
  if (fields.decision) values.decision = sanitizeTraceText(fields.decision, 40)
  if (Number.isFinite(fields.waiting)) values.waiting = Math.max(0, Math.round(Number(fields.waiting)))
  if (Number.isFinite(fields.capacity)) values.capacity = Math.max(0, Math.round(Number(fields.capacity)))
  if (typeof fields.ok === 'boolean') values.ok = fields.ok
  if (fields.code) values.code = sanitizeTraceText(fields.code, 80)

  logger.warn(`video_trace ${Object.entries(values).map(([key, value]) => `${key}=${encodeTraceField(value)}`).join(' ')}`)
  return true
}

// 清除测试或插件关闭时持有的唯一终态集合。
export function clearVideoTraceState(): void {
  terminalTraceIds.clear()
}

// 返回当前已记录终态数量，供测试和状态核对。
export function getVideoTerminalTraceCount(): number {
  return terminalTraceIds.size
}
