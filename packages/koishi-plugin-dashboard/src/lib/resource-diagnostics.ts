/**
 * MODULE: 资源中心任务诊断记录。
 * 职责: 合并未知资源任务与未完成媒体任务，并提供稳定游标分页和按需详情。
 * 边界: 不读取任务输入，不返回 payload，不推断未保存的错误原因。
 */

type DiagnosticRecord = Record<string, unknown>
type DiagnosticGroup = 'all' | 'unknown' | 'media'
type MediaFinishReason = 'queue_limit' | 'processing_failed' | 'restart_interrupted' | 'legacy_unknown'

interface DiagnosticTask {
  id?: unknown
  kind?: unknown
  status?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  finishedAt?: unknown
  finishReason?: unknown
  hasError?: boolean
  error?: unknown
  claimedBy?: unknown
  step?: unknown
  source?: unknown
  timeoutMs?: unknown
}

interface DiagnosticSource {
  resourceTasks: readonly DiagnosticTask[]
  mediaTasks: readonly DiagnosticTask[]
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
function buildUnknownTaskItem(task: DiagnosticTask): DiagnosticItem {
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
    hasError: !!(task.hasError ?? String(task.error || '')),
  }
}

// 把一个未完成媒体任务转换为不含输入数据的诊断摘要。
function buildMediaTaskItem(task: DiagnosticTask): DiagnosticItem {
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
    hasError: !!(task.hasError ?? String(task.error || '')),
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

// 为排序与游标使用同一倒序规则，补足语言比较认为等价的编号。
function compareDiagnosticItems(a: DiagnosticCursor, b: DiagnosticCursor): number {
  return b.relatedAt.localeCompare(a.relatedAt) || b.recordId.localeCompare(a.recordId)
    || (b.recordId > a.recordId ? 1 : b.recordId < a.recordId ? -1 : 0)
}

interface DiagnosticIndex {
  all: DiagnosticItem[]
  unknown: DiagnosticItem[]
  media: DiagnosticItem[]
  reasons: Map<string, DiagnosticItem[]>
}

let cachedIndex: { resourceTasks: DiagnosticSource['resourceTasks']; mediaTasks: DiagnosticSource['mediaTasks']; index: DiagnosticIndex } | undefined

// 两个来源的摘要发生变化时，才重建去重结果及筛选顺序。
function indexDiagnosticItems(source: DiagnosticSource): DiagnosticIndex {
  if (cachedIndex?.resourceTasks === source.resourceTasks && cachedIndex.mediaTasks === source.mediaTasks) return cachedIndex.index
  const items = source.resourceTasks
    .filter(task => !KNOWN_RESOURCE_TASK_KINDS.has(String(task.kind || '')))
    .map(buildUnknownTaskItem)
  for (const task of source.mediaTasks) items.push(buildMediaTaskItem(task))
  const index: DiagnosticIndex = { all: dedupeNewest(items).sort(compareDiagnosticItems), unknown: [], media: [], reasons: new Map() }
  for (const item of index.all) {
    if (item.recordType === 'unknown_task') {
      index.unknown.push(item)
      continue
    }
    index.media.push(item)
    const matching = index.reasons.get(item.finishReason)
    if (matching) matching.push(item)
    else index.reasons.set(item.finishReason, [item])
  }
  cachedIndex = { resourceTasks: source.resourceTasks, mediaTasks: source.mediaTasks, index }
  return index
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

// 从有序结果二分定位游标后的第一条记录，游标所在记录即使删除也可继续翻页。
function findPageStart(items: readonly DiagnosticItem[], cursor: DiagnosticCursor | null): number {
  if (!cursor) return 0
  let start = 0
  let end = items.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (compareDiagnosticItems(items[middle], cursor) <= 0) start = middle + 1
    else end = middle
  }
  return start
}

// --- 接口响应 --- //

// 构建诊断列表的固定 120 条稳定游标分页响应。
export function buildResourceDiagnosticsPage(source: DiagnosticSource, query: DiagnosticQuery = {}): DiagnosticRecord {
  const index = indexDiagnosticItems(source)
  const group = normalizeGroup(query.group)
  const reason = normalizeReason(query.reason)
  const filtered = reason ? (group === 'unknown' ? [] : index.reasons.get(reason) ?? []) : index[group]
  const start = findPageStart(filtered, decodeCursor(query.cursor))
  const items = filtered.slice(start, start + RESOURCE_DIAGNOSTIC_PAGE_SIZE)
  const hasMore = start + items.length < filtered.length
  return {
    ok: true,
    items,
    total: filtered.length,
    counts: {
      all: index.all.length,
      unknown: index.unknown.length,
      media: index.media.length,
    },
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : '',
    hasMore,
    pageSize: RESOURCE_DIAGNOSTIC_PAGE_SIZE,
  }
}

// 仅识别接口生成的两类记录标识，允许媒体历史文件使用较长编号。
export function parseResourceDiagnosticId(value: unknown): { source: 'unknown' | 'media'; taskId: string } | null {
  const text = String(value || '')
  const match = /^(unknown|media):([^/\\\x00-\x1f\x7f]+)$/.exec(text)
  if (!match || match[0] !== text || match[2] === '.' || match[2] === '..') return null
  return { source: match[1] === 'unknown' ? 'unknown' : 'media', taskId: match[2] }
}

// 构建一条诊断记录的按需详情，只返回已保存且再次脱敏的错误和诊断字段。
export function buildResourceDiagnosticDetail(source: DiagnosticSource & { redactText(value: string): string }, recordIdValue: unknown): DiagnosticRecord | null {
  const id = parseResourceDiagnosticId(recordIdValue)
  if (!id) return null
  const tasks = id.source === 'media' ? source.mediaTasks : source.resourceTasks
  let sourceTask: DiagnosticTask | undefined
  let item: DiagnosticItem | undefined
  for (const task of tasks) {
    if (task.id !== id.taskId) continue
    // 旧详情从已排序来源取首条报错，摘要则选最新的可见诊断副本。
    sourceTask ??= task
    if (id.source === 'unknown' && KNOWN_RESOURCE_TASK_KINDS.has(String(task.kind || ''))) continue
    const candidate = id.source === 'media' ? buildMediaTaskItem(task) : buildUnknownTaskItem(task)
    if (!item || candidate.relatedAt > item.relatedAt) item = candidate
  }
  if (!item || !sourceTask) return null
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
