/**
 * MODULE: 模型请求诊断。
 * 职责: 提取已确认协议的脱敏错误、记录调用证据和最近结果。
 * 边界: 不调用模型、不发送通知；不保存消息正文、凭据或思考内容。
 * 状态: 诊断文件按日滚动，保留七天，每日最多五兆字节；最近视图最多一百二十八个节点。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { randomUUID } = require('crypto') as typeof import('crypto')
const { DATA_DIR } = require('./constants') as typeof import('./constants')
const { redactSensitiveText } = require('./redactor') as typeof import('./redactor')

interface FailureDetails {
  upstreamCode?: string; summary?: string; requestId?: string; reason?: string
  finishReason?: string; contentLength?: number; reasoningLength?: number
  usage?: Record<string, unknown>
}
interface DiagnosticEvent {
  requestId: string; capability: string; purpose: string; provider: string; model: string
  status: 'success' | 'failure'; elapsedMs: number; attempt: number; fallback: boolean
  code?: string; httpStatus?: number; reason?: string; summary?: string; upstreamCode?: string
  upstreamRequestId?: string; finishReason?: string; contentLength?: number; reasoningLength?: number
  maxTokens?: number; usageReadable?: boolean; inputTokens?: number; outputTokens?: number
  imageSource?: string; imageTarget?: string; imageDemandId?: string
}
interface ImageRequestEvent {
  source: 'explicit-image' | 'random-image' | 'history-tool'
  target: string; demandId: string
  event: 'requested' | 'owned' | 'reused' | 'pending' | 'unavailable' | 'completed' | 'failed'
  force?: boolean; cache?: 'detail' | 'summary'
}
const DIAGNOSTIC_ROOT = path.join(DATA_DIR, 'ai-call-diagnostics')
const RECENT_FILE = path.join(DIAGNOSTIC_ROOT, 'recent.json')

// --- 错误提取与分类 --- //

// 保存稳定分类和脱敏证据，Error.message 不包含上游原始响应。
class ModelRequestError extends Error {
  // 构造供备用链和通知共同读取的稳定错误。
  constructor(message: string, public code: string, public retryable: boolean, public status = 0, public details: FailureDetails = {}) {
    super(message)
    this.name = 'CapabilityUpstreamError'
  }
}

// 对上游摘要先移除确切凭据及原文，再限制长度，避免上游回显私聊进入日志。
function sanitizeDiagnosticText(value: unknown, secrets: string[] = [], limit = 240): string {
  let text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已脱敏]')
  return redactSensitiveText(text).replace(/data:[^\s"'<>]+/g, '[媒体数据]').replace(/[A-Za-z0-9+/=]{120,}/g, '[长数据已脱敏]').replace(/https?:\/\/[^\s"'<>]+/g, '[上游地址]').replace(/[\r\n\t]+/g, ' ').slice(0, limit)
}

// 错误正文只读取有界前缀；读取失败保留 HTTP 状态与响应头编号。
async function readErrorPrefix(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return (await response.text()).slice(0, 16384)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < 16384) {
      const next = await reader.read()
      if (next.done) break
      const bytes = next.value.subarray(0, 16384 - size)
      chunks.push(bytes); size += bytes.length
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}) }
}

// 按上游明确说明区分余额、认证与请求错误；未知原因不推测成欠费。
function describeModelFailure(status: number, code = '', summary = ''): string {
  if (/欠费|余额不足|insufficient[_ ]balance|balance.{0,20}(insufficient|not enough)|payment required/i.test(summary + ' ' + code)) return '欠费或余额不足'
  const reasons: Record<number, string> = { 400: '请求被拒绝', 401: '认证失败', 402: '需要付费', 403: '权限不足', 404: '模型或接口不存在', 408: '请求超时', 422: '请求参数校验失败', 429: '请求受限', 502: '上游网关错误', 503: '上游服务暂不可用', 504: '上游网关超时' }
  return reasons[status] || (status >= 500 ? '上游服务错误' : '原因未明')
}

// HTTP 编号始终附带中文含义，200 空结果也明确区分响应与答案有效性。
function formatModelHttpStatus(status: number): string {
  return status ? `HTTP ${status}（${status === 200 ? '请求成功但结果无效' : describeModelFailure(status)}）` : '未收到 HTTP 响应'
}

// 读取 OpenAI、Anthropic、Gemini 已使用的 error 对象，不保存原始正文。
async function assertModelResponseOk(response: Response, secrets: string[] = []): Promise<void> {
  if (response.ok) return
  const status = response.status
  let raw: Record<string, unknown> = {}
  try { raw = JSON.parse(await readErrorPrefix(response)) } catch { /* 响应无结构时只保留可确认元数据。 */ }
  const error = raw?.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : {}
  const upstreamCode = sanitizeDiagnosticText(error.code ?? error.type ?? error.status, secrets, 80)
  const summary = sanitizeDiagnosticText(error.message, secrets)
  const requestId = sanitizeDiagnosticText(response.headers?.get('x-request-id') || response.headers?.get('request-id'), secrets, 100)
  const modelMissing = status === 404 && upstreamCode === 'model_not_found'
  throw new ModelRequestError(`AI 上游请求失败（HTTP ${status}）`, `HTTP_${status}`,
    modelMissing || [401, 403, 429].includes(status) || status >= 500, status,
    { upstreamCode, summary, requestId, reason: describeModelFailure(status, upstreamCode, summary) })
}

// 根据稳定错误类型生成不暴露原始异常的中文说明。
function getModelFailureReason(error: ModelRequestError): string {
  if (error.details.reason) return error.details.reason
  const reasons: Record<string, string> = { OUTPUT_TRUNCATED: '输出预算耗尽，未得到有效答案', EMPTY_RESPONSE: '未返回可见答案', INVALID_RESPONSE: '上游返回格式异常', NETWORK_ERROR: '网络请求失败', TIMEOUT: '请求超时' }
  return reasons[error.code] || describeModelFailure(error.status)
}

// 提取失败媒体响应中已知的 Token 计量；缺失或不可读时保留未知状态。
function getFailedModelUsage(error: unknown) {
  const usage = error instanceof ModelRequestError ? error.details.usage : undefined
  const keys = ['prompt_tokens', 'input_tokens', 'inputTokens', 'completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens', 'total_tokens', 'totalTokens']
  const number = (key: string): number => typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && Number(usage[key]) >= 0 ? Number(usage[key]) : 0
  const readable = !!usage && keys.some(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]))
  const inputTokens = number('prompt_tokens') || number('input_tokens') || number('inputTokens')
  const outputTokens = number('completion_tokens') || number('output_tokens') || number('completionTokens') || number('outputTokens')
  return { usage, readable, inputTokens, outputTokens, total: number('total_tokens') || number('totalTokens') || inputTokens + outputTokens }
}

// --- 调用证据与最近状态 --- //

// 只允许受控来源和哈希图片身份进入诊断，不记录原问题、群消息或图片地址。
function readImageRequestDiagnostic(value: unknown): { source: ImageRequestEvent['source']; target: string; demandId: string } | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (!['explicit-image', 'random-image', 'history-tool'].includes(String(data.source))) return null
  if (typeof data.target !== 'string' || !/^[a-f0-9]{64}$/.test(data.target)) return null
  if (typeof data.demandId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.demandId)) return null
  return { source: data.source as ImageRequestEvent['source'], target: data.target, demandId: data.demandId }
}

// 有界记录识图业务需求和缓存复用，实际上游尝试仍由模型诊断单独计数。
function recordImageRequestEvent(event: ImageRequestEvent): void {
  const identity = readImageRequestDiagnostic(event)
  if (!identity) return
  try {
    fs.mkdirSync(DIAGNOSTIC_ROOT, { recursive: true })
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const file = path.join(DIAGNOSTIC_ROOT, 'image-demand-' + day + '.jsonl')
    const payload = { ...identity, event: event.event, ...(event.force !== undefined ? { force: !!event.force } : {}),
      ...(event.cache ? { cache: event.cache } : {}), createdAt: now.toISOString() }
    if (!fs.existsSync(file) || fs.statSync(file).size < 5 * 1024 * 1024) fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8')
    for (const name of fs.readdirSync(DIAGNOSTIC_ROOT)) {
      if (/^image-demand-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && now.getTime() - Date.parse(name.slice(13, 23)) > 7 * 86400000) fs.unlinkSync(path.join(DIAGNOSTIC_ROOT, name))
    }
  } catch { console.warn('[ai-diagnostic] 图片需求诊断写入失败') }
}

// 为整次调用建立关联编号，各备用节点和恢复尝试共享该编号。
function createDiagnosticRequestId(): string { return randomUUID() }

// 将媒体调用的已分类异常转换为通知字段，未知本地异常不输出原文。
function buildModelFailureNotice(error: unknown, timedOut: boolean, requestId: string, purpose: string) {
  const failure = error instanceof ModelRequestError ? error : new ModelRequestError('模型调用失败', timedOut ? 'TIMEOUT' : error instanceof TypeError ? 'NETWORK_ERROR' : 'UNKNOWN_FAILURE', true)
  return { requestId, purpose, reason: getModelFailureReason(failure), status: failure.status, code: failure.code,
    summary: failure.details.summary, upstreamCode: failure.details.upstreamCode, upstreamRequestId: failure.details.requestId }
}

// 有界持久化脱敏证据；日志写入失败只报告本地错误，不改变上游结果。
function recordModelDiagnostic(event: DiagnosticEvent): void {
  try {
    fs.mkdirSync(DIAGNOSTIC_ROOT, { recursive: true })
    const now = new Date(), today = now.toISOString().slice(0, 10)
    const file = path.join(DIAGNOSTIC_ROOT, today + '.jsonl')
    let recent: Record<string, Record<string, unknown>> = {}
    try { recent = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')) } catch { /* 新进程或损坏视图从当前事件恢复。 */ }
    // 多个备用节点可能在同一毫秒完成，用持久序号保留实际记录顺序。
    const sequence = Math.max(0, ...Object.values(recent).map(item => typeof item.sequence === 'number' ? item.sequence : 0)) + 1
    const payload = { ...event, createdAt: now.toISOString(), sequence }
    if (!fs.existsSync(file) || fs.statSync(file).size < 5 * 1024 * 1024) fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8')
    const key = event.capability + ':' + event.provider + ':' + event.model
    const previous = recent[key] || {}
    recent[key] = { ...previous, ...payload,
      ...(event.status === 'success' ? { lastSuccessAt: payload.createdAt } : { lastFailureAt: payload.createdAt, lastFailureReason: event.reason }) }
    const entries = Object.entries(recent).sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)) || Number(b[1].sequence || 0) - Number(a[1].sequence || 0)).slice(0, 128)
    const temporary = RECENT_FILE + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)), 'utf8')
    fs.renameSync(temporary, RECENT_FILE)
    for (const name of fs.readdirSync(DIAGNOSTIC_ROOT)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && now.getTime() - Date.parse(name.slice(0, 10)) > 7 * 86400000) fs.unlinkSync(path.join(DIAGNOSTIC_ROOT, name))
    }
    // 结构化证据走 stderr，避免污染调用模块的 JSON 标准输出；控制台日志仍可检索。
    console.warn('[ai-diagnostic] ' + JSON.stringify(payload))
  } catch { console.warn('[ai-diagnostic] 本地诊断记录写入失败') }
}

// 展示最近文字业务调用，明确时间、失败原因和备用接手；不把缓存当实时探测。
function formatRecentModelDiagnostic(): string {
  try {
    const recent = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')) as Record<string, DiagnosticEvent & { createdAt: string; sequence?: number; lastSuccessAt?: string; lastFailureAt?: string; lastFailureReason?: string }>
    const records = Object.values(recent).filter(item => item.capability === 'text')
    const latest = records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.sequence || 0) - (a.sequence || 0))[0]
    if (!latest) return '最近文字调用：暂无记录'
    const success = records.map(item => item.lastSuccessAt || '').sort().pop()
    const failure = records.filter(item => item.lastFailureAt).sort((a, b) => b.lastFailureAt!.localeCompare(a.lastFailureAt!))[0]
    return [`最近文字调用：${latest.status === 'success' ? (latest.fallback ? '备用接手成功' : '成功') : latest.reason || '失败'}｜${latest.createdAt}`,
      ...(latest.purpose === 'retaliation_score' ? ['用途：敌意评分'] : []),
      `最近成功：${success || '暂无记录'}`, `最近失败：${failure ? `${failure.lastFailureReason || '原因未明'}｜${failure.lastFailureAt}` : '暂无记录'}`].join('\n')
  } catch { return '最近文字调用：暂无记录' }
}

export = { ModelRequestError, sanitizeDiagnosticText, assertModelResponseOk, getModelFailureReason, getFailedModelUsage, formatModelHttpStatus, createDiagnosticRequestId, buildModelFailureNotice, recordModelDiagnostic, formatRecentModelDiagnostic, readImageRequestDiagnostic, recordImageRequestEvent }
