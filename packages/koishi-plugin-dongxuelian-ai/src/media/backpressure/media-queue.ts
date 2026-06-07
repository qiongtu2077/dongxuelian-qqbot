/**
 * MODULE: S6 媒体背压队列。
 * 职责: 管理图片/文件/语音媒体任务的入队、去重、队列上限和状态汇总。
 * 边界: 不下载、不解析、不调用视觉或文件分析模型。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path')
const crypto = require('crypto')
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

interface MediaTask extends Record<string, unknown> {
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
  error?: string
  result?: Record<string, unknown>
}

type EnqueueMediaTaskResult =
  | MediaTask
  | { reused: true; cache: unknown; urlHash: string }
  | { reused: false; existing: MediaTask; urlHash: string }

const MEDIA_ROOT = path.join(DATA_DIR, 'media-backpressure')
const MEDIA_QUEUE_ROOT = path.join(MEDIA_ROOT, 'queue')
const MEDIA_RUNNING_ROOT = path.join(MEDIA_ROOT, 'running')
const MEDIA_DONE_ROOT = path.join(MEDIA_ROOT, 'done')
const MEDIA_DROPPED_ROOT = path.join(MEDIA_ROOT, 'dropped')
const MEDIA_CACHE_INDEX_FILE = path.join(MEDIA_ROOT, 'cache-index.json')
const MAX_IMAGE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_IMAGE_MAX || 120)
const MAX_FILE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_FILE_MAX || 60)
const MAX_VOICE_QUEUE = Number(process.env.MEDIA_BACKPRESSURE_VOICE_MAX || 80)
const DEFAULT_MEDIA_TTL_MS = Number(process.env.MEDIA_BACKPRESSURE_TTL_MS || 2 * 60 * 60 * 1000)

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
  ]) ensureDir(dir)
}

// 写入 S6 事件。
function writeMediaEvent(event: string, data: Record<string, unknown> = {}): void {
  appendJsonlEvent(mediaEventFile(), { event, ...data })
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

// 读取 cache-index。
function readCacheIndex(): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(MEDIA_CACHE_INDEX_FILE, {}) || {}
}

// 写 cache-index。
function writeCacheIndex(index: Record<string, unknown>): void {
  writeJsonAtomic(MEDIA_CACHE_INDEX_FILE, index)
}

// 清理过期 pending 媒体任务。
function cleanupExpiredMediaTasks(): number {
  ensureMediaDirs()
  const now = Date.now()
  let removed = 0
  for (const file of listJsonFiles(MEDIA_QUEUE_ROOT, { recursive: true, maxFiles: 20000 })) {
    const task = readJsonFile<MediaTask>(file, null)
    if (!task) continue
    const expiresAt = Date.parse(String(task.expiresAt || ''))
    if (Number.isFinite(expiresAt) && expiresAt < now) {
      removePath(file)
      removed++
      writeMediaEvent('media_task_expired', { taskId: task.id, kind: task.kind })
    }
  }
  return removed
}

// 判断同 hash 任务是否已经存在。
function findExistingMediaTask(hash: string): MediaTask | null {
  const files = [
    ...listJsonFiles(MEDIA_QUEUE_ROOT, { recursive: true, maxFiles: 20000 }),
    ...listJsonFiles(MEDIA_RUNNING_ROOT, { maxFiles: 20000 }),
    ...listJsonFiles(MEDIA_DONE_ROOT, { maxFiles: 20000 }),
  ]
  for (const file of files) {
    const task = readJsonFile<MediaTask>(file, null)
    if (task && task.urlHash === hash) return task
  }
  return null
}

// 读取媒体任务文件，非法任务返回 null。
function readMediaTaskFile(file: string): MediaTask | null {
  const task = readJsonFile<MediaTask>(file, null)
  if (!task || !task.id || !task.kind) return null
  return task
}

// 列出 pending 媒体任务，按优先级和创建时间排序。
function listPendingMediaTasks(kind = '', limit = 500): MediaTask[] {
  ensureMediaDirs()
  cleanupExpiredMediaTasks()
  const tasks = listJsonFiles(MEDIA_QUEUE_ROOT, { recursive: true, maxFiles: Math.max(1, Math.min(20000, Number(limit || 500))) })
    .map(readMediaTaskFile)
    .filter((task): task is MediaTask => task !== null && (!kind || task.kind === kind))
  tasks.sort((a, b) => Number(a.priority || 80) - Number(b.priority || 80) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  return tasks.slice(0, limit)
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
    const next: MediaTask = { ...task, status: 'running', claimedBy: workerName, claimedAt: nowIso(), updatedAt: nowIso() }
    writeJsonAtomic(dst, next)
    writeMediaEvent('media_task_claimed', { taskId: next.id, kind: next.kind, workerName })
    return next
  }
  return null
}

// 将已领取但暂不能执行的媒体任务放回 pending。
function requeueMediaTask(task: MediaTask, reason = 'resource_defer'): MediaTask {
  ensureMediaDirs()
  const src = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
  const dst = path.join(mediaKindDir(task.kind), `${sanitizeId(task.id)}.json`)
  const next: MediaTask = { ...task, status: 'pending', updatedAt: nowIso(), deferredReason: reason }
  try {
    fs.renameSync(src, dst)
  } catch {
    removePath(src)
  }
  writeJsonAtomic(dst, next)
  writeMediaEvent('media_task_requeued', { taskId: next.id, kind: next.kind, reason })
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
  if (task.urlHash) {
    const index = readCacheIndex()
    index[task.urlHash] = { taskId: task.id, kind: task.kind, channelKey: task.channelKey, messageId: task.messageId, updatedAt: next.updatedAt, result }
    writeCacheIndex(index)
  }
  writeMediaEvent('media_task_done', { taskId: next.id, kind: next.kind, hasResult: Object.keys(result || {}).length > 0 })
  return next
}

// 将媒体任务标记为失败，文件进入 dropped 区便于 Dashboard 追踪。
function failMediaTask(task: MediaTask, error: unknown, reason = 'failed'): MediaTask {
  ensureMediaDirs()
  const src = getFlatMediaTaskFile(MEDIA_RUNNING_ROOT, task.id)
  const dst = getFlatMediaTaskFile(MEDIA_DROPPED_ROOT, task.id)
  const message = error instanceof Error ? error.message : String(error || reason)
  const next: MediaTask = { ...task, status: 'failed', finishedAt: nowIso(), updatedAt: nowIso(), error: message }
  try {
    fs.renameSync(src, dst)
  } catch {
    removePath(src)
  }
  writeJsonAtomic(dst, next)
  writeMediaEvent('media_task_failed', { taskId: next.id, kind: next.kind, reason, error: message })
  return next
}

// 队列超限时丢弃低优先级旧任务。
function enforceMediaQueueLimit(kind: string): number {
  const dir = mediaKindDir(kind)
  const max = /voice/i.test(kind) ? MAX_VOICE_QUEUE : /file/i.test(kind) ? MAX_FILE_QUEUE : MAX_IMAGE_QUEUE
  const tasks = listJsonFiles(dir, { maxFiles: 20000 })
    .map(file => ({ file, task: readJsonFile<MediaTask>(file, null) }))
    .filter((item): item is { file: string; task: MediaTask } => Boolean(item.task))
  if (tasks.length <= max) return 0
  tasks.sort((a, b) => Number(b.task.priority || 80) - Number(a.task.priority || 80) || String(a.task.createdAt || '').localeCompare(String(b.task.createdAt || '')))
  const drop = tasks.slice(0, tasks.length - max)
  for (const item of drop) {
    const dst = path.join(MEDIA_DROPPED_ROOT, path.basename(item.file))
    try { fs.renameSync(item.file, dst) } catch { removePath(item.file) }
    writeMediaEvent('media_task_dropped', { taskId: item.task.id, kind: item.task.kind, reason: 'queue_limit' })
  }
  return drop.length
}

// 创建媒体任务；已有缓存或 pending/running 时不会重复入队。
function enqueueMediaTask(input: MediaTaskInput): EnqueueMediaTaskResult {
  ensureMediaDirs()
  cleanupExpiredMediaTasks()
  const hash = createMediaHash(input)
  const cacheIndex = readCacheIndex()
  if (cacheIndex[hash]) {
    writeMediaEvent('media_cache_reused', { kind: input.kind, channelKey: input.channelKey, messageId: input.messageId, urlHash: hash })
    return { reused: true, cache: cacheIndex[hash], urlHash: hash }
  }
  const existing = findExistingMediaTask(hash)
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
  const dropped = enforceMediaQueueLimit(input.kind)
  writeMediaEvent('media_task_created', { taskId: task.id, kind: task.kind, channelKey: task.channelKey, messageId: task.messageId, dropped })
  return task
}

// 汇总媒体背压状态。
function getMediaBackpressureStatus(): Record<string, unknown> {
  ensureMediaDirs()
  return {
    imagePending: listJsonFiles(path.join(MEDIA_QUEUE_ROOT, 'image'), { maxFiles: 20000 }).length,
    filePending: listJsonFiles(path.join(MEDIA_QUEUE_ROOT, 'file'), { maxFiles: 20000 }).length,
    voicePending: listJsonFiles(path.join(MEDIA_QUEUE_ROOT, 'voice'), { maxFiles: 20000 }).length,
    running: listJsonFiles(MEDIA_RUNNING_ROOT, { maxFiles: 20000 }).map(file => readJsonFile(file, null)).filter(Boolean),
    doneCount: listJsonFiles(MEDIA_DONE_ROOT, { maxFiles: 20000 }).length,
    droppedCount: listJsonFiles(MEDIA_DROPPED_ROOT, { maxFiles: 20000 }).length,
    cacheIndexSize: Object.keys(readCacheIndex()).length,
  }
}

export = {
  MEDIA_ROOT,
  MEDIA_QUEUE_ROOT,
  MEDIA_CACHE_INDEX_FILE,
  ensureMediaDirs,
  writeMediaEvent,
  createMediaHash,
  readCacheIndex,
  writeCacheIndex,
  cleanupExpiredMediaTasks,
  enqueueMediaTask,
  listPendingMediaTasks,
  claimNextMediaTask,
  requeueMediaTask,
  completeMediaTask,
  failMediaTask,
  getMediaBackpressureStatus,
}
