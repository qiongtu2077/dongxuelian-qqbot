/**
 * MODULE: 资源中心任务诊断记录。
 * 职责: 合并未知资源任务与未完成媒体任务，并提供稳定游标分页和按需详情。
 * 边界: 不读取任务输入，不返回 payload，不推断未保存的错误原因。
 */

type DiagnosticRecord = Record<string, unknown>
type DiagnosticGroup = 'all' | 'unknown' | 'media'
type MediaFinishReason = 'queue_limit' | 'processing_failed' | 'restart_interrupted' | 'legacy_unknown'

interface DiagnosticSource {
  resourceTasks: DiagnosticRecord[]
  mediaTasks: DiagnosticRecord[]
  redactText(value: string): string
}

interface DiagnosticQuery {
  group?: unknown
  reason?: unknown
  cursor?: unknown
}

interface DiagnosticItem extends DiagnosticRecord {
  recordId: string
  recordType: 'unknown_task' | 'unfinished_media'
  taskId: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
  finishedAt: string
  relatedAt: string
  finishReason: string
  hasError: boolean
}

interface DiagnosticCursor {
  relatedAt: string
  recordId: string
}

export const RESOURCE_DIAGNOSTIC_PAGE_SIZE = 120

const KNOWN_RESOURCE_TASK_KINDS = new Set([
  'agent_task',
  'dashboard_agent',
  'agent_memory',
  'agent_memory_compaction',
  'conversation_summary',
  'sensitive_cache_analysis',
  'daily_report',
  'daily_summary',
  'emotion_render',
])
const MEDIA_FINISH_REASONS = new Set<MediaFinishReason>([
  'queue_limit',
  'processing_failed',
  'restart_interrupted',
  'legacy_unknown',
])

// --- 输入规范化与摘要 --- //

// 将任意时间字段归一为可稳定比较的 ISO 字符串，非法值放在最旧位置。
function normalizeTime(value: unknown): string {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

// 规范诊断记录分组筛选值。
function normalizeGroup(value: unknown): DiagnosticGroup {
  const group = String(value || 'all')
  return group === 'unknown' || group === 'media' ? group : 'all'
}

// 规范未完成媒体任务结束原因筛选值。
function normalizeReason(value: unknown): MediaFinishReason | '' {
  const reason = String(value || '') as MediaFinishReason
  return MEDIA_FINISH_REASONS.has(reason) ? reason : ''
}

// 把一个未知资源任务转换为不含输入数据的诊断摘要。
function buildUnknownTaskItem(task: DiagnosticRecord): DiagnosticItem {
  const taskId = String(task.id || '')
  const createdAt = normalizeTime(task.createdAt)
  const updatedAt = normalizeTime(task.updatedAt)
  return {
    recordId: `unknown:${taskId}`,
    recordType: 'unknown_task',
    taskId,
    kind: String(task.kind || 'unknown'),
    status: String(task.status || 'unknown'),
    createdAt,
    updatedAt,
    finishedAt: normalizeTime(task.finishedAt),
    relatedAt: updatedAt || createdAt,
    finishReason: '',
    hasError: !!String(task.error || ''),
  }
}

// 把一个未完成媒体任务转换为不含输入数据的诊断摘要。
function buildMediaTaskItem(task: DiagnosticRecord): DiagnosticItem {
  const taskId = String(task.id || '')
  const createdAt = normalizeTime(task.createdAt)
  const updatedAt = normalizeTime(task.updatedAt)
  const finishedAt = normalizeTime(task.finishedAt) || updatedAt || createdAt
  const finishReason = normalizeReason(task.finishReason) || 'legacy_unknown'
  return {
    recordId: `media:${taskId}`,
    recordType: 'unfinished_media',
    taskId,
    kind: String(task.kind || 'unknown'),
    status: String(task.status || 'unknown'),
    createdAt,
    updatedAt,
    finishedAt,
    relatedAt: finishedAt,
    finishReason,
    hasError: !!String(task.error || ''),
  }
}

// --- 排序、筛选与游标 --- //

// 去除同一内部任务标识的重复状态副本，并保留时间最新的一份。
function dedupeNewest(items: DiagnosticItem[]): DiagnosticItem[] {
  const result = new Map<string, DiagnosticItem>()
  for (const item of items) {
    const previous = result.get(item.recordId)
    if (!previous || item.relatedAt > previous.relatedAt) result.set(item.recordId, item)
  }
  return Array.from(result.values())
}

// 收集全部诊断摘要并按相关时间、内部标识稳定倒序排列。
function collectDiagnosticItems(source: DiagnosticSource): DiagnosticItem[] {
  const unknown = source.resourceTasks
    .filter(task => !KNOWN_RESOURCE_TASK_KINDS.has(String(task.kind || '')))
    .map(buildUnknownTaskItem)
  const media = source.mediaTasks.map(buildMediaTaskItem)
  return dedupeNewest([...unknown, ...media]).sort((a, b) => {
    const timeOrder = b.relatedAt.localeCompare(a.relatedAt)
    return timeOrder || b.recordId.localeCompare(a.recordId)
  })
}

// 将稳定游标编码为 URL 安全文本。
function encodeCursor(item: DiagnosticItem): string {
  const value: DiagnosticCursor = { relatedAt: item.relatedAt, recordId: item.recordId }
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

// 解码并验证前端传回的稳定游标，非法游标视为第一页。
function decodeCursor(value: unknown): DiagnosticCursor | null {
  const text = String(value || '')
  if (!text) return null
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<DiagnosticCursor>
    if (typeof parsed.relatedAt !== 'string' || typeof parsed.recordId !== 'string') return null
    return { relatedAt: parsed.relatedAt, recordId: parsed.recordId }
  } catch {
    return null
  }
}

// 判断一条倒序记录是否位于游标之后。
function isAfterCursor(item: DiagnosticItem, cursor: DiagnosticCursor | null): boolean {
  if (!cursor) return true
  if (item.relatedAt < cursor.relatedAt) return true
  return item.relatedAt === cursor.relatedAt && item.recordId < cursor.recordId
}

// 按分组和结束原因筛选诊断摘要。
function filterDiagnosticItems(items: DiagnosticItem[], group: DiagnosticGroup, reason: MediaFinishReason | ''): DiagnosticItem[] {
  return items.filter(item => {
    if (group === 'unknown' && item.recordType !== 'unknown_task') return false
    if (group === 'media' && item.recordType !== 'unfinished_media') return false
    if (reason && (item.recordType !== 'unfinished_media' || item.finishReason !== reason)) return false
    return true
  })
}

// --- 接口响应 --- //

// 构建诊断列表的固定 120 条稳定游标分页响应。
export function buildResourceDiagnosticsPage(source: DiagnosticSource, query: DiagnosticQuery = {}): DiagnosticRecord {
  const all = collectDiagnosticItems(source)
  const group = normalizeGroup(query.group)
  const reason = normalizeReason(query.reason)
  const filtered = filterDiagnosticItems(all, group, reason)
  const remaining = filtered.filter(item => isAfterCursor(item, decodeCursor(query.cursor)))
  const items = remaining.slice(0, RESOURCE_DIAGNOSTIC_PAGE_SIZE)
  const hasMore = remaining.length > items.length
  return {
    ok: true,
    items,
    total: filtered.length,
    counts: {
      all: all.length,
      unknown: all.filter(item => item.recordType === 'unknown_task').length,
      media: all.filter(item => item.recordType === 'unfinished_media').length,
    },
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : '',
    hasMore,
    pageSize: RESOURCE_DIAGNOSTIC_PAGE_SIZE,
  }
}

// 构建一条诊断记录的按需详情，只返回已保存且再次脱敏的错误和诊断字段。
export function buildResourceDiagnosticDetail(source: DiagnosticSource, recordIdValue: unknown): DiagnosticRecord | null {
  const recordId = String(recordIdValue || '')
  const item = collectDiagnosticItems(source).find(candidate => candidate.recordId === recordId)
  if (!item) return null
  const sourceTask = item.recordType === 'unfinished_media'
    ? source.mediaTasks.find(task => String(task.id || '') === item.taskId)
    : source.resourceTasks.find(task => String(task.id || '') === item.taskId)
  if (!sourceTask) return null
  return {
    ok: true,
    item,
    error: source.redactText(String(sourceTask.error || '')),
    diagnostics: {
      claimedBy: String(sourceTask.claimedBy || ''),
      step: String(sourceTask.step || ''),
      source: String(sourceTask.source || ''),
      timeoutMs: sourceTask.timeoutMs ?? null,
      finishReason: item.finishReason,
    },
  }
}
