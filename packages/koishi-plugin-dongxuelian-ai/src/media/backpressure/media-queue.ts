/**
 * MODULE: S6 媒体背压队列。
 * 职责: 管理图片/文件/语音媒体任务的入队、去重、队列上限和状态汇总。
 * 边界: 不下载、不解析、不调用视觉或文件分析模型。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const crypto = require('crypto') as typeof import('crypto')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const {
  appendJsonlEvent,
  ensureDir,
  listJsonFiles,
  nowIso,
  readJsonFile,
  removePath,
  sanitizeId,
  writeJsonAtomic,
} = require('../../resource-common/files') as typeof import('../../resource-common/files')
const { redactSensitiveText } = require('../../core/redactor') as typeof import('../../core/redactor')

interface MediaTaskInput {
  kind: 'media_image_analysis' | 'media_file_analysis' | 'media_voice_transcription' | string
  channelKey: string
  messageId: string
  url?: string
  fileId?: string | null
  priority?: number
  ttlMs?: number
  payload?: Record<string, unknown>
}

interface MediaTask {
  id: string
  kind: string
  channelKey: string
  messageId: string
  urlHash: string
  url: string
  fileId: string | null
  createdAt: string
  expiresAt: string
  priority: number
  status: string
  payload: Record<string, unknown>
  claimedBy?: string
  claimedAt?: string
  updatedAt?: string
  finishedAt?: string
  deferredReason?: string
  deferredUntil?: string
  notBefore?: string
  error?: string
  finishReason?: 'queue_limit' | 'processing_failed' | 'restart_interrupted' | 'legacy_unknown'
  result?: Record<string, unknown>
}

interface MediaQueueKindStatus {
  kind: 'image' | 'file' | 'voice'
  queueTotal: number
  readyCount: number
  deferredCount: number
  runningCount: number
  queueLimit: number
  doneCount: number
  cacheReusableCount: number
}

interface MediaDiagnosticTask {
  id: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
  finishedAt: string
  finishReason: 'queue_limit' | 'processing_failed' | 'restart_interrupted' | 'legacy_unknown'
  error: string
  claimedBy: string
}

type EnqueueMediaTaskResult =
  | MediaTask
  | { reused: true; cache: unknown; urlHash: string }
  | { reused: false; existing: MediaTask; urlHash: string }

interface PendingMediaProbeCacheEntry {
  queueStamp: string
  nextScanAtMs: number
}

interface MediaRetentionControl {
  enabled?: unknown
  backupPath?: unknown
}

interface MediaRetentionResult {
  enabled: boolean
  archivedDone: number
  archivedDropped: number
  deletedArchiveDirs: number
  backupPath: string
}

const MEDIA_ROOT = path.join(DATA_DIR, 'media-backpressure')
const MEDIA_QUEUE_ROOT = path.join(MEDIA_ROOT, 'queue')
const MEDIA_RUNNING_ROOT = path.join(MEDIA_ROOT, 'running')
const MEDIA_DONE_ROOT = path.join(MEDIA_ROOT, 'done')
const MEDIA_DROPPED_ROOT = path.join(MEDIA_ROOT, 'dropped')
const MEDIA_ARCHIVE_ROOT = path.join(MEDIA_ROOT, 'archive')
const MEDIA_RETENTION_CONTROL_FILE = path.join(MEDIA_ROOT, 'retention-control.json')
const MEDIA_CACHE_INDEX_FILE = path.join(MEDIA_ROOT, 'cache-index.json')
const MAX_IMAGE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_IMAGE_MAX || 120)
const MAX_FILE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_FILE_MAX || 60)
const MAX_VOICE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_VOICE_MAX || 80)
const DEFAULT_MEDIA_TTL_MS = Number(process.env.MEDIA_BACKPRESSURE_TTL_MS || 2 * 60 * 60 * 1000)
const MEDIA_EXPIRED_CLEANUP_INTERVAL_MS = Math.max(10000, Math.min(10 * 60 * 1000, Number(process.env.MEDIA_EXPIRED_CLEANUP_INTERVAL_MS || 60000)))
let lastExpiredMediaCleanupAt = 0
const MEDIA_RETENTION_INTERVAL_MS = Math.max(10 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Number(process.env.MEDIA_RETENTION_INTERVAL_MS || 60 * 60 * 1000)))
const MEDIA_FINISHED_RETENTION_MS = Math.max(1, Number(process.env.MEDIA_FINISHED_RETENTION_DAYS || 14)) * 24 * 60 * 60 * 1000
const MEDIA_ARCHIVE_RETENTION_MS = Math.max(1, Number(process.env.MEDIA_ARCHIVE_RETENTION_DAYS || 30)) * 24 * 60 * 60 * 1000
const MEDIA_DONE_MAX_ENTRIES = Math.max(100, Math.min(20000, Number(process.env.MEDIA_DONE_MAX_ENTRIES || 2000)))
const MEDIA_DROPPED_MAX_ENTRIES = Math.max(100, Math.min(20000, Number(process.env.MEDIA_DROPPED_MAX_ENTRIES || 2000)))
const MEDIA_RETENTION_BATCH_SIZE = Math.max(10, Math.min(1000, Number(process.env.MEDIA_RETENTION_BATCH_SIZE || 200)))
let lastFinishedMediaCleanupAt = 0
const DEFAULT_MEDIA_REQUEUE_DELAY_MS = Math.max(5000, Math.min(5 * 60 * 1000, Number(process.env.MEDIA_BACKPRESSURE_REQUEUE_DELAY_MS || 15000)))
const MEDIA_CACHE_INDEX_MAX_ENTRIES = Math.max(1, Math.min(20000, Number(process.env.MEDIA_BACKPRESSURE_CACHE_INDEX_MAX_ENTRIES || 500)))
const pendingMediaProbeCache = new Map<string, PendingMediaProbeCacheEntry>()

// 返回当天 S6 事件日志路径。
function mediaEventFile(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(MEDIA_ROOT, `events-${stamp}.jsonl`)
}

// 初始化 S6 目录。
function ensureMediaDirs(): void {
  for (const dir of [
    MEDIA_ROOT,
    MEDIA_QUEUE_ROOT,
    path.join(MEDIA_QUEUE_ROOT, 'image'),
    path.join(MEDIA_QUEUE_ROOT, 'file'),
    path.join(MEDIA_QUEUE_ROOT, 'voice'),
    MEDIA_RUNNING_ROOT,
    MEDIA_DONE_ROOT,
    MEDIA_DROPPED_ROOT,
    MEDIA_ARCHIVE_ROOT,
  ]) ensureDir(dir)
}

// 写入 S6 事件。
function writeMediaEvent(event: string, data: Record<string, unknown> = {}): void {
  appendJsonlEvent(mediaEventFile(), { event, ...data })
}

// 在媒体任务 JSON 边界验证队列 DTO，避免宽泛对象进入队列状态机。
function parseMediaTask(value: unknown): MediaTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const task = value as Partial<MediaTask>
  if (
    typeof task.id !== 'string' || !task.id
    || typeof task.kind !== 'string' || !task.kind
    || typeof task.channelKey !== 'string'
    || typeof task.messageId !== 'string'
    || typeof task.urlHash !== 'string'
    || typeof task.url !== 'string'
    || (typeof task.fileId !== 'string' && task.fileId !== null)
    || typeof task.createdAt !== 'string'
    || typeof task.expiresAt !== 'string'
    || typeof task.priority !== 'number' || !Number.isFinite(task.priority)
    || typeof task.status !== 'string'
    || !task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)
  ) return null
  return task as MediaTask
}

// 根据 URL/file/message 生成去重 hash。
function createMediaHash(input: MediaTaskInput): string {
  const hash = crypto.createHash('sha256')
  hash.update(String(input.kind || ''))
  hash.update('\n')
  hash.update(String(input.url || input.fileId || input.messageId || ''))
  return hash.digest('hex')
}

// 返回媒体类型目录。
function mediaKindDir(kind: string): string {
  if (/voice/i.test(kind)) return path.join(MEDIA_QUEUE_ROOT, 'voice')
  if (/file/i.test(kind)) return path.join(MEDIA_QUEUE_ROOT, 'file')
  return path.join(MEDIA_QUEUE_ROOT, 'image')
}

// 将内部媒体任务 kind 归一为资源中心使用的三类队列键。
function mediaKindKey(kind: string): 'image' | 'file' | 'voice' {
  if (/voice/i.test(kind)) return 'voice'
  if (/file/i.test(kind)) return 'file'
  return 'image'
}

// 返回媒体队列键对应的既有容量上限。
function mediaQueueLimit(kind: 'image' | 'file' | 'voice'): number {
  if (kind === 'voice') return MAX_VOICE_QUEUE
  if (kind === 'file') return MAX_FILE_QUEUE
  return MAX_IMAGE_QUEUE
}

// 返回指定 kind 需要观测的队列目录，用于轻量判断队列是否发生过变化。
function getMediaQueueWatchDirs(kind = ''): string[] {
  if (kind) return [mediaKindDir(kind)]
  return [
    path.join(MEDIA_QUEUE_ROOT, 'image'),
    path.join(MEDIA_QUEUE_ROOT, 'file'),
    path.join(MEDIA_QUEUE_ROOT, 'voice'),
  ]
}

// 返回指定 kind 对应的 pending 队列目录；空 kind 退回整个 queue root。
function getMediaQueueScanRoot(kind = ''): string {
  return kind ? mediaKindDir(kind) : MEDIA_QUEUE_ROOT
}

// 生成轻量队列目录戳；目录未变化时不必重复全盘扫 deferred pending。
function getMediaQueueStamp(kind = ''): string {
  return getMediaQueueWatchDirs(kind)
    .map(dir => {
      try {
        const stat = fs.statSync(dir)
        return `${dir}:${Number(stat.mtimeMs || 0)}`
      } catch {
        return `${dir}:missing`
      }
    })
    .join('|')
}

// pending probe cache key；空 kind 代表全量媒体队列。
function getPendingMediaProbeCacheKey(kind = ''): string {
  return kind ? String(kind) : '*'
}

// 读取 deferred 冷却期的轻量短路缓存；目录没变且还没到期时可直接返回空。
function shouldShortCircuitPendingMediaScan(kind = '', now = Date.now()): boolean {
  const key = getPendingMediaProbeCacheKey(kind)
  const cached = pendingMediaProbeCache.get(key)
  if (!cached) return false
  if (!(cached.nextScanAtMs > now)) {
    pendingMediaProbeCache.delete(key)
    return false
  }
  if (cached.queueStamp !== getMediaQueueStamp(kind)) {
    pendingMediaProbeCache.delete(key)
    return false
  }
  return true
}

// 写入 deferred 冷却期的短路缓存，避免 worker 在冷却窗口内重复空扫目录。
function rememberPendingMediaProbe(kind = '', nextScanAtMs = 0): void {
  const key = getPendingMediaProbeCacheKey(kind)
  if (!(nextScanAtMs > Date.now())) {
    pendingMediaProbeCache.delete(key)
    return
  }
  pendingMediaProbeCache.set(key, {
    queueStamp: getMediaQueueStamp(kind),
    nextScanAtMs,
  })
}

// 本进程发生队列写操作后，清掉轻量缓存；跨进程变更仍由目录戳兜底失效。
function invalidatePendingMediaProbeCache(): void {
  pendingMediaProbeCache.clear()
}

// 读取 cache-index。
function readCacheIndex(): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(MEDIA_CACHE_INDEX_FILE, {}) || {}
}

// 写 cache-index。
function writeCacheIndex(index: Record<string, unknown>): void {
  writeJsonAtomic(MEDIA_CACHE_INDEX_FILE, index)
}

// 只保留最近使用的媒体缓存索引，避免前门整文件读取无限增长。
function trimCacheIndex(index: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(index || {})
  if (entries.length <= MEDIA_CACHE_INDEX_MAX_ENTRIES) return index
  entries.sort((a, b) => {
    const aUpdated = String((a[1] as Record<string, unknown>)?.updatedAt || '')
    const bUpdated = String((b[1] as Record<string, unknown>)?.updatedAt || '')
    return bUpdated.localeCompare(aUpdated)
  })
  return Object.fromEntries(entries.slice(0, MEDIA_CACHE_INDEX_MAX_ENTRIES))
}

// 清理过期 pending 媒体任务。
function cleanupExpiredMediaTasks(kind = ''): number {
  ensureMediaDirs()
  const now = Date.now()
  let removed = 0
  for (const file of listJsonFiles(getMediaQueueScanRoot(kind), { recursive: true, maxFiles: 20000 })) {
    const task = parseMediaTask(readJsonFile<unknown>(file, null))
    if (!task) continue
    const expiresAt = Date.parse(String(task.expiresAt || ''))
    if (Number.isFinite(expiresAt) && expiresAt < now) {
      removePath(file)
      removed++
      invalidatePendingMediaProbeCache()
      writeMediaEvent('media_task_expired', { taskId: task.id, kind: task.kind })
    }
  }
  return removed
}

// 低频清理过期媒体任务，供 supervisor 在 worker claim 之前独立维护队列。
function cleanupExpiredMediaTasksThrottled(kind = '', now = Date.now()): number {
  if (now - lastExpiredMediaCleanupAt < MEDIA_EXPIRED_CLEANUP_INTERVAL_MS) return 0
  lastExpiredMediaCleanupAt = now
  return cleanupExpiredMediaTasks(kind)
}

// 读取媒体保留控制文件；只有外部备份路径存在时才允许归档或删除历史。
function readMediaRetentionControl(): { enabled: boolean; backupPath: string } {
  const control = readJsonFile<MediaRetentionControl>(MEDIA_RETENTION_CONTROL_FILE, null)
  const rawBackupPath = String(control?.backupPath || '').trim()
  const backupPath = rawBackupPath ? path.resolve(rawBackupPath) : ''
  return {
    enabled: control?.enabled === true
      && path.isAbsolute(rawBackupPath)
      && backupPath !== path.parse(backupPath).root
      && fs.existsSync(backupPath),
    backupPath,
  }
}

// 返回媒体历史任务的稳定时间戳，供按年龄和数量挑选最旧记录。
function getFinishedMediaTaskTimestamp(task: MediaTask): number {
  const value = Date.parse(String(task.finishedAt || task.updatedAt || task.createdAt || ''))
  return Number.isFinite(value) ? value : 0
}

// 将一个 done/dropped 目录中超龄或超量的最旧记录分批移入观察归档区。
function archiveFinishedMediaTasks(root: string, status: 'done' | 'dropped', maxEntries: number, now: number): number {
  const tasks = listJsonFiles(root, { maxFiles: 20000 })
    .map(file => ({ file, task: parseMediaTask(readJsonFile<unknown>(file, null)) }))
    .filter((item): item is { file: string; task: MediaTask } => !!item.task)
    .sort((a, b) => getFinishedMediaTaskTimestamp(a.task) - getFinishedMediaTaskTimestamp(b.task))
  const overflowCount = Math.max(0, tasks.length - maxEntries)
  const cutoff = now - MEDIA_FINISHED_RETENTION_MS
  const candidates = tasks.filter((item, index) => index < overflowCount || getFinishedMediaTaskTimestamp(item.task) < cutoff)
    .slice(0, MEDIA_RETENTION_BATCH_SIZE)
  let archived = 0
  for (const item of candidates) {
    const day = new Date(now).toISOString().slice(0, 10)
    const targetDir = path.join(MEDIA_ARCHIVE_ROOT, day, status)
    ensureDir(targetDir)
    try {
      fs.renameSync(item.file, path.join(targetDir, path.basename(item.file)))
      archived += 1
    } catch {
      /* A later maintenance pass retries files that could not be moved atomically. */
    }
  }
  return archived
}

// 删除已超过二阶段保留期的日期归档目录；外部备份门禁由调用方统一保证。
function cleanupOldMediaArchiveDirs(now: number): number {
  let removed = 0
  let entries: import('fs').Dirent[] = []
  try { entries = fs.readdirSync(MEDIA_ARCHIVE_ROOT, { withFileTypes: true }) } catch { return 0 }
  const cutoff = now - MEDIA_ARCHIVE_RETENTION_MS
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    const dayEnd = Date.parse(`${entry.name}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
    if (!Number.isFinite(dayEnd) || dayEnd > cutoff) continue
    if (removePath(path.join(MEDIA_ARCHIVE_ROOT, entry.name))) removed += 1
  }
  return removed
}

// 执行一次受备份门禁保护的媒体历史保留维护。
function cleanupFinishedMediaTasks(now = Date.now()): MediaRetentionResult {
  ensureMediaDirs()
  const control = readMediaRetentionControl()
  if (!control.enabled) return { enabled: false, archivedDone: 0, archivedDropped: 0, deletedArchiveDirs: 0, backupPath: control.backupPath }
  const archivedDone = archiveFinishedMediaTasks(MEDIA_DONE_ROOT, 'done', MEDIA_DONE_MAX_ENTRIES, now)
  const archivedDropped = archiveFinishedMediaTasks(MEDIA_DROPPED_ROOT, 'dropped', MEDIA_DROPPED_MAX_ENTRIES, now)
  const deletedArchiveDirs = cleanupOldMediaArchiveDirs(now)
  if (archivedDone || archivedDropped || deletedArchiveDirs) {
    writeMediaEvent('media_retention_completed', { archivedDone, archivedDropped, deletedArchiveDirs, backupPath: control.backupPath })
  }
  return { enabled: true, archivedDone, archivedDropped, deletedArchiveDirs, backupPath: control.backupPath }
}

// 低频执行媒体历史保留，避免 supervisor 每轮扫描大量 finished 文件。
function cleanupFinishedMediaTasksThrottled(now = Date.now()): MediaRetentionResult {
  if (now - lastFinishedMediaCleanupAt < MEDIA_RETENTION_INTERVAL_MS) {
    const control = readMediaRetentionControl()
    return { enabled: control.enabled, archivedDone: 0, archivedDropped: 0, deletedArchiveDirs: 0, backupPath: control.backupPath }
  }
  lastFinishedMediaCleanupAt = now
  return cleanupFinishedMediaTasks(now)
}

// 判断同 hash 任务是否已经存在于 active 队列。
// 已完成结果复用统一走 cache-index；前门不再为 done 历史全盘扫描背锅。
function findExistingMediaTask(hash: string, kind = ''): MediaTask | null {
  const files = [
    ...listJsonFiles(getMediaQueueScanRoot(kind), { recursive: true, maxFiles: 20000 }),
    ...listJsonFiles(MEDIA_RUNNING_ROOT, { maxFiles: 20000 }),
  ]
  for (const file of files) {
    const task = parseMediaTask(readJsonFile<unknown>(file, null))
    if (task && task.urlHash === hash) return task
  }
  return null
}

// 读取媒体任务文件，非法任务返回 null。
function readMediaTaskFile(file: string): MediaTask | null {
  return parseMediaTask(readJsonFile<unknown>(file, null))
}

// 判断 pending 媒体任务是否仍处于冷却窗口。
function isMediaTaskDeferred(task: MediaTask | null | undefined, now = Date.now()): boolean {
  const deferredUntil = Date.parse(String(task?.deferredUntil || task?.notBefore || ''))
  return Number.isFinite(deferredUntil) && deferredUntil > now
}

// 列出 pending 媒体任务，按优先级和创建时间排序。
function listPendingMediaTasks(kind = '', limit = 500): MediaTask[] {
  ensureMediaDirs()
  if (shouldShortCircuitPendingMediaScan(kind)) return []
  cleanupExpiredMediaTasks(kind)
  const now = Date.now()
  let earliestNextScanAtMs = 0
  const tasks = listJsonFiles(getMediaQueueScanRoot(kind), { recursive: true, maxFiles: Math.max(1, Math.min(20000, Number(limit || 500))) })
    .map(readMediaTaskFile)
    .filter((task): task is MediaTask => task !== null && (!kind || task.kind === kind))
    .filter(task => {
      const deferredUntil = Date.parse(String(task.deferredUntil || task.notBefore || ''))
      if (!Number.isFinite(deferredUntil) || deferredUntil <= now) return true
      const expiresAt = Date.parse(String(task.expiresAt || ''))
      const candidateNextScanAtMs = Number.isFinite(expiresAt)
        ? Math.min(deferredUntil, expiresAt)
        : deferredUntil
      if (!(earliestNextScanAtMs > 0) || candidateNextScanAtMs < earliestNextScanAtMs) {
        earliestNextScanAtMs = candidateNextScanAtMs
      }
      return false
    })
  tasks.sort((a, b) => Number(a.priority || 80) - Number(b.priority || 80) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  const readyTasks = tasks.slice(0, limit)
  if (readyTasks.length > 0) {
    rememberPendingMediaProbe(kind, 0)
  } else {
    rememberPendingMediaProbe(kind, earliestNextScanAtMs)
  }
  return readyTasks
}

// 返回 running/done/dropped 媒体任务文件路径。
function getFlatMediaTaskFile(root: string, taskId: string): string {
  return path.join(root, `${sanitizeId(taskId)}.json`)
}

// 原子领取一个媒体任务，rename 成功才算被当前 worker 抢到。
function claimNextMediaTask(workerName = 'media-worker', kind = ''): MediaTask | null {
  ensureMediaDirs()
  const tasks = listPendingMediaTasks(kind, 1000)
  for (const task of tasks) {
    const src = path.join(mediaKindDir(task.kind), `${sanitizeId(task.id)}.json`)
    const dst = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
    try {
      fs.renameSync(src, dst)
    } catch {
      continue
    }
    invalidatePendingMediaProbeCache()
    const next: MediaTask = {
      ...task,
      status: 'running',
      claimedBy: workerName,
      claimedAt: nowIso(),
      updatedAt: nowIso(),
      deferredUntil: '',
      notBefore: '',
    }
    writeJsonAtomic(dst, next)
    writeMediaEvent('media_task_claimed', { taskId: next.id, kind: next.kind, workerName })
    return next
  }
  return null
}

// 将已领取但暂不能执行的媒体任务放回 pending。
function requeueMediaTask(task: MediaTask, reason = 'resource_defer', delayMs = DEFAULT_MEDIA_REQUEUE_DELAY_MS): MediaTask {
  ensureMediaDirs()
  const src = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
  const dst = path.join(mediaKindDir(task.kind), `${sanitizeId(task.id)}.json`)
  const deferMs = Math.max(1000, Number.isFinite(Number(delayMs)) ? Number(delayMs) : DEFAULT_MEDIA_REQUEUE_DELAY_MS)
  const deferredUntil = new Date(Date.now() + deferMs).toISOString()
  const next: MediaTask = {
    ...task,
    status: 'pending',
    updatedAt: nowIso(),
    deferredReason: reason,
    deferredUntil,
    notBefore: deferredUntil,
    claimedBy: '',
    claimedAt: '',
  }
  try {
    fs.renameSync(src, dst)
  } catch {
    removePath(src)
  }
  writeJsonAtomic(dst, next)
  invalidatePendingMediaProbeCache()
  writeMediaEvent('media_task_requeued', { taskId: next.id, kind: next.kind, reason, deferredUntil })
  return next
}

// 将媒体任务标记为完成，并按 urlHash 写入轻量 cache-index。
function completeMediaTask(task: MediaTask, result: Record<string, unknown> = {}): MediaTask {
  ensureMediaDirs()
  const src = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
  const dst = getFlatMediaTaskFile(MEDIA_DONE_ROOT, task.id)
  const next: MediaTask = { ...task, status: 'done', finishedAt: nowIso(), updatedAt: nowIso(), result }
  try {
    fs.renameSync(src, dst)
  } catch {
    removePath(src)
  }
  writeJsonAtomic(dst, next)
  invalidatePendingMediaProbeCache()
  if (task.urlHash) {
    const index = readCacheIndex()
    index[task.urlHash] = { taskId: task.id, kind: task.kind, channelKey: task.channelKey, messageId: task.messageId, updatedAt: next.updatedAt, result }
    writeCacheIndex(trimCacheIndex(index))
  }
  writeMediaEvent('media_task_done', { taskId: next.id, kind: next.kind, hasResult: Object.keys(result || {}).length > 0 })
  return next
}

// 将媒体任务标记为失败，文件进入 dropped 区便于 Dashboard 追踪。
function failMediaTask(task: MediaTask, error: unknown, reason = 'failed'): MediaTask {
  ensureMediaDirs()
  const src = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
  const dst = getFlatMediaTaskFile(MEDIA_DROPPED_ROOT, task.id)
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error || reason))
  const next: MediaTask = {
    ...task,
    status: 'failed',
    finishedAt: nowIso(),
    updatedAt: nowIso(),
    finishReason: 'processing_failed',
    error: message,
  }
  try {
    fs.renameSync(src, dst)
  } catch {
    removePath(src)
  }
  writeJsonAtomic(dst, next)
  invalidatePendingMediaProbeCache()
  writeMediaEvent('media_task_failed', { taskId: next.id, kind: next.kind, reason, error: message })
  return next
}

interface DiscardInterruptedMediaTasksResult {
  discarded: number
  invalidFilesRemoved: number
  failed: number
}

// Bot 启动时把 S6 running 任务移入 dropped，pending 队列保持不变。
function discardInterruptedMediaTasks(reason = 'restart_discarded'): DiscardInterruptedMediaTasksResult {
  ensureMediaDirs()
  const result: DiscardInterruptedMediaTasksResult = { discarded: 0, invalidFilesRemoved: 0, failed: 0 }
  for (const file of listJsonFiles(MEDIA_RUNNING_ROOT, { maxFiles: 20000 })) {
    const task = readMediaTaskFile(file)
    if (!task) {
      if (removePath(file)) result.invalidFilesRemoved++
      continue
    }
    const targetFile = getFlatMediaTaskFile(MEDIA_DROPPED_ROOT, task.id)
    if (fs.existsSync(targetFile)) {
      if (removePath(file)) {
        result.discarded++
        writeMediaEvent('media_task_discarded_on_startup', { taskId: task.id, kind: task.kind, reason, duplicateTerminalCopy: true })
      } else {
        result.failed++
      }
      continue
    }
    try {
      fs.renameSync(file, targetFile)
      const next: MediaTask = {
        ...task,
        status: 'cancelled',
        finishedAt: nowIso(),
        updatedAt: nowIso(),
        finishReason: 'restart_interrupted',
        error: redactSensitiveText(reason),
      }
      writeJsonAtomic(targetFile, next)
      result.discarded++
      writeMediaEvent('media_task_discarded_on_startup', { taskId: task.id, kind: task.kind, reason })
    } catch {
      result.failed++
    }
  }
  invalidatePendingMediaProbeCache()
  return result
}

// 队列超限时丢弃低优先级旧任务。
function enforceMediaQueueLimit(kind: string): number {
  const dir = mediaKindDir(kind)
  const max = /voice/i.test(kind) ? MAX_VOICE_QUEUE : /file/i.test(kind) ? MAX_FILE_QUEUE : MAX_IMAGE_QUEUE
  const files = listJsonFiles(dir, { maxFiles: Math.max(1, max + 1) })
  if (files.length <= max) return 0
  const tasks = listJsonFiles(dir, { maxFiles: 20000 })
    .map(file => ({ file, task: parseMediaTask(readJsonFile<unknown>(file, null)) }))
    .filter((item): item is { file: string; task: MediaTask } => Boolean(item.task))
  if (tasks.length <= max) return 0
  tasks.sort((a, b) => Number(b.task.priority || 80) - Number(a.task.priority || 80) || String(a.task.createdAt || '').localeCompare(String(b.task.createdAt || '')))
  const drop = tasks.slice(0, tasks.length - max)
  for (const item of drop) {
    const dst = path.join(MEDIA_DROPPED_ROOT, path.basename(item.file))
    try { fs.renameSync(item.file, dst) } catch { removePath(item.file) }
    const finishedAt = nowIso()
    writeJsonAtomic(dst, {
      ...item.task,
      status: 'cancelled',
      updatedAt: finishedAt,
      finishedAt,
      finishReason: 'queue_limit',
    })
    writeMediaEvent('media_task_dropped', { taskId: item.task.id, kind: item.task.kind, reason: 'queue_limit' })
  }
  return drop.length
}

// 创建媒体任务；已有缓存或 pending/running 时不会重复入队。
function enqueueMediaTask(input: MediaTaskInput): EnqueueMediaTaskResult {
  ensureMediaDirs()
  cleanupExpiredMediaTasks(input.kind)
  const hash = createMediaHash(input)
  const cacheIndex = readCacheIndex()
  if (cacheIndex[hash]) {
    writeMediaEvent('media_cache_reused', { kind: input.kind, channelKey: input.channelKey, messageId: input.messageId, urlHash: hash })
    return { reused: true, cache: cacheIndex[hash], urlHash: hash }
  }
  const existing = findExistingMediaTask(hash, input.kind)
  if (existing) {
    writeMediaEvent('media_task_deduped', { taskId: existing.id, kind: existing.kind, urlHash: hash })
    return { reused: false, existing, urlHash: hash }
  }
  const now = Date.now()
  const task: MediaTask = {
    id: `${sanitizeId(input.kind)}-${now}-${sanitizeId(input.messageId)}-${hash.slice(0, 8)}`,
    kind: input.kind,
    channelKey: String(input.channelKey || ''),
    messageId: String(input.messageId || ''),
    urlHash: hash,
    url: String(input.url || ''),
    fileId: input.fileId || null,
    createdAt: nowIso(),
    expiresAt: new Date(now + Math.max(60000, Number(input.ttlMs || DEFAULT_MEDIA_TTL_MS))).toISOString(),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 80,
    status: 'pending',
    payload: input.payload || {},
  }
  writeJsonAtomic(path.join(mediaKindDir(input.kind), `${task.id}.json`), task)
  invalidatePendingMediaProbeCache()
  const dropped = enforceMediaQueueLimit(input.kind)
  writeMediaEvent('media_task_created', { taskId: task.id, kind: task.kind, channelKey: task.channelKey, messageId: task.messageId, dropped })
  return task
}

// --- 资源中心媒体诊断与状态汇总 --- //

// 读取仍保留的媒体任务，并忽略损坏或历史残缺文件。
function listStoredMediaTasks(root: string): MediaTask[] {
  return listJsonFiles(root, { maxFiles: 20000 })
    .map(readMediaTaskFile)
    .filter((task): task is MediaTask => task !== null)
}

// 归一媒体未完成记录的结束原因；旧记录无法判断时明确归入历史未知。
function normalizeMediaFinishReason(task: MediaTask): MediaDiagnosticTask['finishReason'] {
  if (task.finishReason === 'queue_limit') return 'queue_limit'
  if (task.finishReason === 'processing_failed') return 'processing_failed'
  if (task.finishReason === 'restart_interrupted') return 'restart_interrupted'
  return 'legacy_unknown'
}

// 列出资源中心诊断区块需要的未完成媒体任务摘要与已脱敏报错。
function listUnfinishedMediaTasksForDiagnostics(): MediaDiagnosticTask[] {
  ensureMediaDirs()
  return listStoredMediaTasks(MEDIA_DROPPED_ROOT).map(task => ({
    id: task.id,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: String(task.updatedAt || ''),
    finishedAt: String(task.finishedAt || task.updatedAt || task.createdAt || ''),
    finishReason: normalizeMediaFinishReason(task),
    error: redactSensitiveText(String(task.error || '')),
    claimedBy: String(task.claimedBy || ''),
  }))
}

// 汇总单类媒体队列的当前排队、延后、运行、完成和缓存数量。
function buildMediaQueueKindStatus(
  kind: 'image' | 'file' | 'voice',
  pending: MediaTask[],
  running: MediaTask[],
  done: MediaTask[],
  cacheValues: Record<string, unknown>[],
  now = Date.now(),
): MediaQueueKindStatus {
  const pendingForKind = pending.filter(task => mediaKindKey(task.kind) === kind)
  const deferredCount = pendingForKind.filter(task => isMediaTaskDeferred(task, now)).length
  return {
    kind,
    queueTotal: pendingForKind.length,
    readyCount: pendingForKind.length - deferredCount,
    deferredCount,
    runningCount: running.filter(task => mediaKindKey(task.kind) === kind).length,
    queueLimit: mediaQueueLimit(kind),
    doneCount: done.filter(task => mediaKindKey(task.kind) === kind).length,
    cacheReusableCount: cacheValues.filter(item => {
      const storedKind = String(item?.kind || '')
      return !!storedKind && mediaKindKey(storedKind) === kind
    }).length,
  }
}

// 只返回资源中心判断运行数量和诊断详情需要的媒体任务字段。
function sanitizeRunningMediaTask(task: MediaTask): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    claimedBy: String(task.claimedBy || ''),
    claimedAt: String(task.claimedAt || ''),
    updatedAt: String(task.updatedAt || ''),
  }
}

// 汇总媒体处理队列状态，保留旧字段并补充三类队列的可读审计数据。
function getMediaBackpressureStatus(): Record<string, unknown> {
  ensureMediaDirs()
  const pending = listJsonFiles(MEDIA_QUEUE_ROOT, { recursive: true, maxFiles: 20000 })
    .map(readMediaTaskFile)
    .filter((task): task is MediaTask => task !== null)
  const running = listStoredMediaTasks(MEDIA_RUNNING_ROOT)
  const done = listStoredMediaTasks(MEDIA_DONE_ROOT)
  const unfinished = listUnfinishedMediaTasksForDiagnostics()
  const cacheIndex = readCacheIndex()
  const cacheValues = Object.values(cacheIndex)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
  const queues = {
    image: buildMediaQueueKindStatus('image', pending, running, done, cacheValues),
    file: buildMediaQueueKindStatus('file', pending, running, done, cacheValues),
    voice: buildMediaQueueKindStatus('voice', pending, running, done, cacheValues),
  }
  const unfinishedByReason = {
    queue_limit: unfinished.filter(task => task.finishReason === 'queue_limit').length,
    processing_failed: unfinished.filter(task => task.finishReason === 'processing_failed').length,
    restart_interrupted: unfinished.filter(task => task.finishReason === 'restart_interrupted').length,
    legacy_unknown: unfinished.filter(task => task.finishReason === 'legacy_unknown').length,
  }
  const lastQueueLimitAt = unfinished
    .filter(task => task.finishReason === 'queue_limit')
    .map(task => task.finishedAt)
    .sort((a, b) => b.localeCompare(a))[0] || ''
  return {
    imagePending: queues.image.queueTotal,
    filePending: queues.file.queueTotal,
    voicePending: queues.voice.queueTotal,
    running: running.map(sanitizeRunningMediaTask),
    doneCount: done.length,
    droppedCount: unfinished.length,
    cacheIndexSize: cacheValues.length,
    queues,
    unfinishedByReason,
    lastQueueLimitAt,
  }
}

export = {
  MEDIA_ROOT,
  MEDIA_QUEUE_ROOT,
  MEDIA_CACHE_INDEX_FILE,
  MEDIA_ARCHIVE_ROOT,
  MEDIA_RETENTION_CONTROL_FILE,
  ensureMediaDirs,
  writeMediaEvent,
  createMediaHash,
  readCacheIndex,
  writeCacheIndex,
  cleanupExpiredMediaTasks,
  cleanupExpiredMediaTasksThrottled,
  cleanupFinishedMediaTasks,
  cleanupFinishedMediaTasksThrottled,
  enqueueMediaTask,
  listPendingMediaTasks,
  claimNextMediaTask,
  requeueMediaTask,
  completeMediaTask,
  failMediaTask,
  discardInterruptedMediaTasks,
  listUnfinishedMediaTasksForDiagnostics,
  getMediaBackpressureStatus,
  isMediaTaskDeferred,
  _test: {
    parseMediaTask,
  },
}
