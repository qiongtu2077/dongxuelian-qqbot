'use strict'

import type { IncomingMessage, ServerResponse } from 'http'

/**
 * MODULE: Dashboard 资源中心路由。
 * 职责: 读取 S0-S8 资源状态，并提供受控管理操作。
 * 边界: 不重新推理业务准入，不直接执行重任务。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { execFileSync } = require('child_process') as typeof import('child_process')
const { json, collectBody, parsePositiveInt, readFileSyncSafe, writeFileSyncSafe } = require('../utils') as {
  json(res: ServerResponse, data: unknown, status?: number): void
  collectBody(req: IncomingMessage, res: ServerResponse, callback: (body: string) => void | Promise<void>): void
  parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number
  readFileSyncSafe(filePath: string): string
  writeFileSyncSafe(filePath: string, content: string): void
}
const { requireAdmin } = require('../auth') as { requireAdmin(req: IncomingMessage, res: ServerResponse): boolean }
const { AI_LIB, DATA_DIR, KOISHI_DIR } = require('../paths') as { AI_LIB: string; DATA_DIR: string; KOISHI_DIR: string }

type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown

interface ResourceSnapshotLike extends Record<string, unknown> {
  botMode?: unknown
  resourceState?: unknown
  memAvailableMb?: unknown
  memTotalMb?: unknown
  memSource?: unknown
}

interface ResourceGateStatusLike extends Record<string, unknown> {
  meta?: ResourceGateMetaLike | null
}

interface ResourceGateMetaLike extends Record<string, unknown> {
  taskId?: unknown
  kind?: unknown
  step?: unknown
  owner?: unknown
  channelKey?: unknown
  userId?: unknown
  startedAt?: unknown
  heartbeatAt?: unknown
  memAvailableMb?: unknown
}

interface ResourceQueueSummaryLike extends Record<string, unknown> {
  pending?: unknown
}

interface PrecomputeSummaryLike extends Record<string, unknown> {
  coverageCount?: unknown
  slotCount?: unknown
  coverage?: unknown
}

interface ResourceTaskLike extends Record<string, unknown> {
  payload?: unknown
}

interface ResourceEvent extends Record<string, unknown> {
  source: string
  resourceSource: string
  businessSource: unknown
}

interface DiskEntry {
  name: string
  label: string
  path: string
  sizeBytes: number
  sizeMb: number
}

interface ResourceModuleSet {
  gate: {
    GATE_ROOT: string
    getResourceGateStatus(staleMs?: number): ResourceGateStatusLike
    reclaimStaleLock(staleMs: number, source: string): unknown
  }
  scheduler: {
    SCHEDULER_ROOT: string
    readResourceSnapshot(): ResourceSnapshotLike
  }
  tasks: {
    getTaskQueueSummary(): ResourceQueueSummaryLike
    listWorkerStates(): unknown
    listResourceTasks(options: { statuses?: string[]; limit: number }): ResourceTaskLike[]
    cancelTask(taskId: string, source: string, reason: string): boolean
  }
  precompute: {
    PRECOMPUTE_ROOT: string
    getPrecomputeSummary(): PrecomputeSummaryLike
  }
  media: {
    MEDIA_ROOT: string
    getMediaBackpressureStatus(): unknown
  }
  system: {
    RESOURCE_SYSTEM_ROOT: string
    getSystemProtectionStatus(): unknown
  }
  files: {
    readRecentJsonlEvents(dir: string, prefix: string, limit?: number): unknown[]
    appendJsonlEvent(file: string, event: Record<string, unknown>): void
  }
}

const RESOURCE_EVENT_LIMIT = parsePositiveInt(process.env.DASHBOARD_RESOURCE_EVENT_LIMIT, 120, 20, 500)
const RESOURCE_TASK_LIMIT = parsePositiveInt(process.env.DASHBOARD_RESOURCE_TASK_LIMIT, 120, 20, 500)
const RESOURCE_PRECOMPUTE_COVERAGE_LIMIT = parsePositiveInt(process.env.DASHBOARD_RESOURCE_PRECOMPUTE_COVERAGE_LIMIT, 80, 12, 500)
const MAINTENANCE_FILE = path.join(DATA_DIR, 'ai-paused.txt')
const DASHBOARD_MEMORY_SAMPLE_INTERVAL_MS = parsePositiveInt(process.env.DASHBOARD_MEMORY_SAMPLE_INTERVAL_MS, 5000, 1000, 60000)
const WORKER_MEMORY_SAMPLE_INTERVAL_MS = parsePositiveInt(process.env.RESOURCE_WORKER_POLL_MS, 2000, 500, 30000)
const MEMORY_HISTORY_CACHE_TTL_MS = parsePositiveInt(process.env.DASHBOARD_MEMORY_HISTORY_CACHE_TTL_MS, 10000, 1000, 60000)
const MEMORY_HISTORY_MAX_FULL_FILE_BYTES = parsePositiveInt(process.env.DASHBOARD_MEMORY_HISTORY_MAX_FULL_FILE_BYTES, 8 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024)
const MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE = parsePositiveInt(process.env.DASHBOARD_MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE, 2600, 200, 20000)
const MEMORY_HISTORY_SAMPLE_CHUNK_BYTES = parsePositiveInt(process.env.DASHBOARD_MEMORY_HISTORY_SAMPLE_CHUNK_BYTES, 64 * 1024, 16 * 1024, 512 * 1024)
const MEMORY_HISTORY_RETENTION_MS = parsePositiveInt(process.env.RESOURCE_PROCESS_METRICS_RETENTION_HOURS || process.env.DASHBOARD_MEMORY_HISTORY_RETENTION_HOURS, 72, 1, 24 * 30) * 60 * 60 * 1000
const MEMORY_HISTORY_CLEANUP_INTERVAL_MS = parsePositiveInt(process.env.DASHBOARD_MEMORY_HISTORY_CLEANUP_INTERVAL_MS, 10 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000)
const DISK_USAGE_CACHE_TTL_MS = parsePositiveInt(process.env.DASHBOARD_DISK_USAGE_CACHE_TTL_MS, 60 * 1000, 10 * 1000, 10 * 60 * 1000)
const PROCESS_METRICS_FILE_RE = /^process-metrics-\d{4}-\d{2}-\d{2}\.jsonl$/

const MEMORY_RANGE_OPTIONS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '48h': 48 * 60 * 60 * 1000,
  '72h': 72 * 60 * 60 * 1000,
}

const MEMORY_BUCKET_MS: Record<string, number> = {
  '1m': 2000,
  '5m': 5000,
  '10m': 10000,
  '30m': 30000,
  '1h': 60000,
  '12h': 5 * 60 * 1000,
  '24h': 10 * 60 * 1000,
  '48h': 15 * 60 * 1000,
  '72h': 30 * 60 * 1000,
}

let lastDashboardMemorySampleAt = 0
let lastMemoryHistoryCleanupAt = 0
const memoryHistoryCache = new Map<string, { expiresAt: number; payload: unknown }>()
let diskUsageCache: { expiresAt: number; payload: unknown } | null = null

// 动态加载 AI 资源模块，避免 Dashboard 编译期反向依赖源码。
function loadResourceModules(): ResourceModuleSet {
  return {
    gate: require(path.join(AI_LIB, 'resource-gate', 'gate')),
    scheduler: require(path.join(AI_LIB, 'resource-scheduler', 'resource-snapshot')),
    tasks: require(path.join(AI_LIB, 'resource-workers', 'task-store')),
    precompute: require(path.join(AI_LIB, 'daily-precompute', 'precompute-status')),
    media: require(path.join(AI_LIB, 'media', 'backpressure', 'media-queue')),
    system: require(path.join(AI_LIB, 'resource-system', 'system-protection')),
    files: require(path.join(AI_LIB, 'resource-common', 'files')),
  }
}

// 返回资源系统事件文件名使用的 UTC 日期戳。
function eventDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// 返回指定日期的内存 metrics 文件路径。
function processMetricsFile(systemRoot: string, date = new Date()): string {
  return path.join(systemRoot, `process-metrics-${eventDateStamp(date)}.jsonl`)
}

// 清理超过保留时间的内存采样文件，只删除白名单命名的 process-metrics JSONL。
function cleanupOldProcessMetricFiles(systemRoot: string, now = Date.now()): number {
  try {
    const entries = fs.readdirSync(systemRoot, { withFileTypes: true })
    const cutoff = now - MEMORY_HISTORY_RETENTION_MS
    let changed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !PROCESS_METRICS_FILE_RE.test(entry.name)) continue
      const stamp = entry.name.slice('process-metrics-'.length, 'process-metrics-YYYY-MM-DD'.length)
      const fileDay = Date.parse(`${stamp}T00:00:00.000Z`)
      if (!Number.isFinite(fileDay)) continue
      const fileEnd = fileDay + 24 * 60 * 60 * 1000
      const file = path.join(systemRoot, entry.name)
      if (fileEnd <= cutoff) {
        try {
          fs.unlinkSync(file)
          changed += 1
        } catch {
          /* 单个旧文件清理失败不影响采样写入。 */
        }
        continue
      }
      if (fileDay >= cutoff) continue
      if (trimProcessMetricFile(file, cutoff)) changed += 1
    }
    return changed
  } catch {
    /* non-critical: missing metrics directory means the history view has no samples yet. */
    return 0
  }
}

// 裁剪跨越保留边界的当天采样文件，保留 createdAt 仍在窗口内的 JSONL 行。
function trimProcessMetricFile(file: string, cutoff: number): boolean {
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    /* non-critical: unreadable metrics files are skipped so status requests still work. */
    return false
  }
  const kept: string[] = []
  let changed = false
  for (const line of lines) {
    let item
    const normalizedLine = line.replace(/^\uFEFF/, '')
    try { item = JSON.parse(normalizedLine) } catch {
      /* non-critical: keep malformed retention lines instead of deleting possibly useful data. */
      kept.push(line)
      continue
    }
    const ts = Date.parse(String(item.createdAt || ''))
    if (Number.isFinite(ts) && ts < cutoff) {
      changed = true
      continue
    }
    kept.push(normalizedLine)
  }
  if (!changed) return false
  if (!kept.length) {
    try { fs.unlinkSync(file) } catch { /* non-critical: retention retry can remove the empty metrics file later. */ return false }
    return true
  }
  const temp = `${file}.${process.pid}.${Date.now()}.retention.tmp`
  try {
    fs.writeFileSync(temp, `${kept.join('\n')}\n`, 'utf8')
    fs.renameSync(temp, file)
    return true
  } catch {
    /* non-critical: failed retention rewrite should leave the previous metrics file in place. */
    try {
      fs.unlinkSync(temp)
    } catch {
      /* 清理临时文件失败不影响后续采样。 */
    }
    return false
  }
}

// 节流执行采样文件清理，避免 Dashboard 高频状态刷新时重复扫目录。
function cleanupOldProcessMetricFilesThrottled(systemRoot: string, now = Date.now()): void {
  if (now - lastMemoryHistoryCleanupAt < MEMORY_HISTORY_CLEANUP_INTERVAL_MS) return
  lastMemoryHistoryCleanupAt = now
  cleanupOldProcessMetricFiles(systemRoot, now)
}

// 补写 Dashboard 自身的低频内存采样，避免 worker 空闲时折线图没有新点。
function recordDashboardMemorySample(mods: ResourceModuleSet, snapshot: ResourceSnapshotLike): void {
  const now = Date.now()
  if (now - lastDashboardMemorySampleAt < DASHBOARD_MEMORY_SAMPLE_INTERVAL_MS) return
  lastDashboardMemorySampleAt = now
  try {
    cleanupOldProcessMetricFilesThrottled(mods.system.RESOURCE_SYSTEM_ROOT, now)
    mods.files.appendJsonlEvent(processMetricsFile(mods.system.RESOURCE_SYSTEM_ROOT), {
      event: 'process_metrics',
      source: 'dashboard-resource-status',
      pid: process.pid,
      processName: process.title,
      rssMb: Math.round((process.memoryUsage().rss || 0) / 1024 / 1024),
      memAvailableMb: snapshot.memAvailableMb,
      memTotalMb: snapshot.memTotalMb,
      memSource: snapshot.memSource || '',
    })
  } catch {
    /* Dashboard 状态读取不应因辅助采样失败而失败。 */
  }
}

// 解析前端传入的内存查询区间。
function normalizeMemoryRange(value: unknown): string {
  const range = String(value || '5m').trim()
  return Object.prototype.hasOwnProperty.call(MEMORY_RANGE_OPTIONS, range) ? range : '5m'
}

// 列出覆盖查询区间的 process-metrics 文件。
function listProcessMetricFiles(systemRoot: string, startMs: number, endMs: number): string[] {
  const startDate = new Date(startMs)
  const endDate = new Date(endMs)
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  const endDay = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  const files: string[] = []
  while (cursor <= endDay) {
    const file = processMetricsFile(systemRoot, new Date(cursor))
    if (fs.existsSync(file)) files.push(file)
    cursor += 24 * 60 * 60 * 1000
  }
  return files
}

// 从文件尾部读取最近 JSONL 行，短区间优先保留最新精度。
function readJsonlTailLines(file: string, maxBytes = MEMORY_HISTORY_MAX_FULL_FILE_BYTES): string[] {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return []
    const size = stat.size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      return start > 0 ? lines.slice(1) : lines
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* non-critical: Dashboard status remains usable without an auxiliary memory sample. */
    return []
  }
}

// 从文件指定偏移附近读取 JSONL 行，采样大文件时避免整文件读入。
function readJsonlChunkLines(file: string, size: number, offset: number): string[] {
  const half = Math.floor(MEMORY_HISTORY_SAMPLE_CHUNK_BYTES / 2)
  const start = Math.max(0, Math.min(size, offset - half))
  const length = Math.max(0, Math.min(MEMORY_HISTORY_SAMPLE_CHUNK_BYTES, size - start))
  if (!length) return []
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      const leftSafe = start === 0 ? 0 : 1
      const rightSafe = start + length >= size ? lines.length : Math.max(leftSafe, lines.length - 1)
      return lines.slice(leftSafe, rightSafe)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* non-critical: Dashboard history sampling skips unreadable file chunks. */
    return []
  }
}

// 读取 metrics 行；小文件全读，大文件按偏移均匀取样。
function readSampledJsonlLines(file: string, rangeMs: number, isEndFile: boolean): string[] {
  let stat
  try {
    stat = fs.statSync(file)
    if (!stat.isFile()) return []
  } catch {
    /* non-critical: Dashboard history treats missing or unreadable metrics files as empty. */
    return []
  }
  if (stat.size <= MEMORY_HISTORY_MAX_FULL_FILE_BYTES) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) } catch { /* non-critical: Dashboard history skips transiently unreadable small metrics files. */ return [] }
  }
  if (isEndFile && rangeMs <= 60 * 60 * 1000) return readJsonlTailLines(file, MEMORY_HISTORY_MAX_FULL_FILE_BYTES * 2)

  const maxChunks = Math.max(4, Math.min(96, Math.ceil(MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE / 80)))
  const seen = new Set<string>()
  const lines: string[] = []
  for (let i = 0; i < maxChunks; i += 1) {
    const offset = maxChunks === 1 ? stat.size - 1 : Math.floor((stat.size - 1) * (i / (maxChunks - 1)))
    for (const line of readJsonlChunkLines(file, stat.size, offset)) {
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  if (lines.length <= MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE) return lines
  const step = lines.length / MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE
  const sampled: string[] = []
  for (let i = 0; i < MEMORY_HISTORY_MAX_SAMPLED_LINES_PER_FILE; i += 1) sampled.push(lines[Math.floor(i * step)])
  return sampled
}

// 将原始 JSONL metrics 聚合为固定桶，长区间采用采样读取以避免 Dashboard 请求超时。
function collectMemoryHistory(mods: ResourceModuleSet, range: string) {
  const nowMs = Date.now()
  cleanupOldProcessMetricFilesThrottled(mods.system.RESOURCE_SYSTEM_ROOT, nowMs)
  const rangeMs = MEMORY_RANGE_OPTIONS[range]
  const startMs = nowMs - rangeMs
  const bucketMs = MEMORY_BUCKET_MS[range] || 10000
  const endStamp = eventDateStamp(new Date(nowMs))
  const buckets = new Map<number, {
    ts: number
    availableSum: number
    availableCount: number
    minAvailableMb: number
    maxAvailableMb: number
    totalMb: number | null
    rssSum: number
    rssCount: number
    sources: Set<string>
  }>()
  const sources = new Set<string>()
  const files = listProcessMetricFiles(mods.system.RESOURCE_SYSTEM_ROOT, startMs, nowMs)
  let parsedLineCount = 0

  for (const file of files) {
    const isEndFile = path.basename(file).includes(endStamp)
    const lines = readSampledJsonlLines(file, rangeMs, isEndFile)
    for (const line of lines) {
      let item
      try { item = JSON.parse(line) } catch { /* non-critical: malformed metrics lines are ignored. */ continue }
      parsedLineCount += 1
      const ts = Date.parse(String(item.createdAt || ''))
      if (!Number.isFinite(ts) || ts < startMs || ts > nowMs) continue
      const available = Number(item.memAvailableMb)
      if (!Number.isFinite(available)) continue
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs
      const bucket = buckets.get(bucketTs) || {
        ts: bucketTs,
        availableSum: 0,
        availableCount: 0,
        minAvailableMb: available,
        maxAvailableMb: available,
        totalMb: null,
        rssSum: 0,
        rssCount: 0,
        sources: new Set<string>(),
      }
      bucket.availableSum += available
      bucket.availableCount += 1
      bucket.minAvailableMb = Math.min(bucket.minAvailableMb, available)
      bucket.maxAvailableMb = Math.max(bucket.maxAvailableMb, available)
      const total = Number(item.memTotalMb)
      if (Number.isFinite(total)) bucket.totalMb = total
      const rss = Number(item.rssMb)
      if (Number.isFinite(rss)) {
        bucket.rssSum += rss
        bucket.rssCount += 1
      }
      const source = String(item.source || item.workerName || item.workerType || item.processName || '').trim()
      if (source) {
        sources.add(source)
        bucket.sources.add(source)
      }
      buckets.set(bucketTs, bucket)
    }
  }

  const points = Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map(bucket => ({
      ts: bucket.ts,
      createdAt: new Date(bucket.ts).toISOString(),
      memAvailableMb: Math.round(bucket.availableSum / Math.max(1, bucket.availableCount)),
      minAvailableMb: Math.round(bucket.minAvailableMb),
      maxAvailableMb: Math.round(bucket.maxAvailableMb),
      memTotalMb: bucket.totalMb,
      rssMb: bucket.rssCount ? Math.round(bucket.rssSum / bucket.rssCount) : null,
      sampleCount: bucket.availableCount,
      sources: Array.from(bucket.sources).slice(0, 8),
    }))

  return {
    ok: true,
    range,
    rangeMs,
    bucketMs,
    dashboardSampleIntervalMs: DASHBOARD_MEMORY_SAMPLE_INTERVAL_MS,
    workerSampleIntervalMs: WORKER_MEMORY_SAMPLE_INTERVAL_MS,
    uiRefreshMs: 5000,
    retentionMs: MEMORY_HISTORY_RETENTION_MS,
    pointCount: points.length,
    parsedLineCount,
    fileCount: files.length,
    cacheTtlMs: MEMORY_HISTORY_CACHE_TTL_MS,
    sources: Array.from(sources).slice(0, 20),
    points,
  }
}

// 返回带短缓存的内存历史，避免高频刷新重复扫描大 JSONL。
function getCachedMemoryHistory(mods: ResourceModuleSet, range: string) {
  const cached = memoryHistoryCache.get(range)
  if (cached && cached.expiresAt > Date.now()) return cached.payload
  const payload = collectMemoryHistory(mods, range)
  memoryHistoryCache.set(range, { expiresAt: Date.now() + MEMORY_HISTORY_CACHE_TTL_MS, payload })
  return payload
}

// 将字节数换算为整数 MB，供接口和前端统一展示。
function bytesToMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

// 读取项目所在文件系统的容量和可用空间。
function getFilesystemUsage(root: string): Record<string, unknown> | null {
  try {
    const stat = fs.statfsSync(root)
    const totalBytes = Number(stat.blocks) * Number(stat.bsize)
    const freeBytes = Number(stat.bfree) * Number(stat.bsize)
    const availableBytes = Number(stat.bavail) * Number(stat.bsize)
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    return {
      root,
      totalBytes,
      usedBytes,
      freeBytes,
      availableBytes,
      totalMb: bytesToMb(totalBytes),
      usedMb: bytesToMb(usedBytes),
      freeMb: bytesToMb(freeBytes),
      availableMb: bytesToMb(availableBytes),
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
    }
  } catch {
    return null
  }
}

// 使用系统 du 读取目录体积，避免在 Node 中递归扫描大量文件。
function getPathSizeBytes(targetPath: string): number | null {
  try {
    if (!fs.existsSync(targetPath)) return null
    const output = execFileSync('du', ['-sk', targetPath], {
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const sizeKb = Number(output.split(/\s+/)[0])
    return Number.isFinite(sizeKb) ? sizeKb * 1024 : null
  } catch {
    return getPathSizeBytesByWalk(targetPath)
  }
}

// 在缺少 du 的平台上递归累加文件大小，主要用于本地测试和 Windows 环境。
function getPathSizeBytesByWalk(targetPath: string): number | null {
  try {
    const stat = fs.statSync(targetPath)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let total = 0
    for (const name of fs.readdirSync(targetPath)) {
      const childSize = getPathSizeBytesByWalk(path.join(targetPath, name))
      if (childSize !== null) total += childSize
    }
    return total
  } catch {
    return null
  }
}

// 收集资源中心需要展示的关键目录磁盘占用。
function collectDiskUsage(): Record<string, unknown> {
  const filesystem = getFilesystemUsage(KOISHI_DIR)
  const candidates = [
    { name: 'data', label: '运行数据', path: path.join(KOISHI_DIR, 'data') },
    { name: 'resource-system', label: '资源采样', path: path.join(DATA_DIR, 'resource-system') },
    { name: 'resource-scheduler', label: '调度状态', path: path.join(DATA_DIR, 'resource-scheduler') },
    { name: 'media-backpressure', label: '媒体队列', path: path.join(DATA_DIR, 'media-backpressure') },
    { name: 'gallery', label: '图库', path: path.join(DATA_DIR, 'gallery') },
    { name: 'packages', label: '源码包', path: path.join(KOISHI_DIR, 'packages') },
    { name: 'node_modules', label: '依赖', path: path.join(KOISHI_DIR, 'node_modules') },
    { name: 'git', label: 'Git 对象', path: path.join(KOISHI_DIR, '.git') },
    { name: 'backups', label: '备份', path: path.join(KOISHI_DIR, 'backups') },
    { name: 'deploy-backups', label: '部署备份', path: path.join(KOISHI_DIR, 'deploy-backups') },
    { name: 'tmp', label: '临时目录', path: path.join(KOISHI_DIR, 'tmp') },
  ]
  const entries: DiskEntry[] = []
  for (const item of candidates) {
    const sizeBytes = getPathSizeBytes(item.path)
    if (sizeBytes === null) continue
    entries.push({
      name: item.name,
      label: item.label,
      path: path.relative(KOISHI_DIR, item.path).replace(/\\/g, '/') || '.',
      sizeBytes,
      sizeMb: bytesToMb(sizeBytes),
    })
  }
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return {
    ok: true,
    collectedAt: new Date().toISOString(),
    cacheTtlMs: DISK_USAGE_CACHE_TTL_MS,
    filesystem,
    entries,
  }
}

// 返回带短缓存的磁盘占用详情，避免资源中心刷新时重复执行 du。
function getCachedDiskUsage(): unknown {
  if (diskUsageCache && diskUsageCache.expiresAt > Date.now()) return diskUsageCache.payload
  const payload = collectDiskUsage()
  diskUsageCache = { expiresAt: Date.now() + DISK_USAGE_CACHE_TTL_MS, payload }
  return payload
}

// 将任务 payload 从 Dashboard 响应中移除，避免泄露上下文和文件内容。
function sanitizeTask(task: ResourceTaskLike) {
  const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {}
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    source: task.source,
    channelKey: task.channelKey,
    userId: task.userId,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    timeoutMs: task.timeoutMs,
    step: task.step,
    claimedBy: task.claimedBy,
    claimedAt: task.claimedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    notify: task.notify,
    error: task.error,
    payloadKeys: Object.keys(payload),
  }
}

// 读取跨 S0-S8 的最近事件，供资源中心统一显示。
function collectResourceEvents(mods: ResourceModuleSet, limit = RESOURCE_EVENT_LIMIT) {
  const events: ResourceEvent[] = []
  const read = (dir: string, prefix: string, source: string) => {
    for (const event of mods.files.readRecentJsonlEvents(dir, prefix, limit)) {
      const item: Record<string, unknown> = event && typeof event === 'object' && !Array.isArray(event) ? event as Record<string, unknown> : {}
      events.push({
        ...item,
        source,
        resourceSource: source,
        businessSource: item.source,
      })
    }
  }
  read(mods.gate.GATE_ROOT, 'events-', 'S0')
  read(mods.scheduler.SCHEDULER_ROOT, 'admissions-', 'S1')
  read(path.join(DATA_DIR, 'resource-workers'), 'events-', 'S2')
  read(mods.precompute.PRECOMPUTE_ROOT, 'events-', 'S3')
  read(mods.media.MEDIA_ROOT, 'events-', 'S6')
  read(mods.system.RESOURCE_SYSTEM_ROOT, 'memory-alerts-', 'S8')
  read(mods.system.RESOURCE_SYSTEM_ROOT, 'process-cleanup-', 'S8')
  events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return events.slice(0, limit)
}

// 合成资源中心总览状态。
function buildResourceStatus(mods: ResourceModuleSet): Record<string, unknown> {
  const snapshot = mods.scheduler.readResourceSnapshot()
  recordDashboardMemorySample(mods, snapshot)
  const gate = mods.gate.getResourceGateStatus()
  const queue = mods.tasks.getTaskQueueSummary()
  const workers = mods.tasks.listWorkerStates()
  const media = mods.media.getMediaBackpressureStatus()
  const precompute = mods.precompute.getPrecomputeSummary()
  const system = mods.system.getSystemProtectionStatus()
  return {
    ok: true,
    mode: snapshot.botMode,
    resourceState: snapshot.resourceState,
    memAvailableMb: snapshot.memAvailableMb,
    memTotalMb: snapshot.memTotalMb,
    memSource: snapshot.memSource || '',
    running: gate.meta ? {
      taskId: gate.meta.taskId,
      kind: gate.meta.kind,
      step: gate.meta.step,
      owner: gate.meta.owner,
      channelKey: gate.meta.channelKey,
      userId: gate.meta.userId,
      startedAt: gate.meta.startedAt,
      heartbeatAt: gate.meta.heartbeatAt,
      memAvailableMb: gate.meta.memAvailableMb,
    } : null,
    gate,
    queue,
    queueLength: Number(queue.pending || 0),
    workers,
    media,
    precompute: {
      coverageCount: precompute.coverageCount,
      slotCount: precompute.slotCount,
      coverage: Array.isArray(precompute.coverage) ? precompute.coverage.slice(0, RESOURCE_PRECOMPUTE_COVERAGE_LIMIT) : [],
    },
    system,
    disk: getCachedDiskUsage(),
    maintenance: !!readFileSyncSafe(MAINTENANCE_FILE),
    events: collectResourceEvents(mods, 40),
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error')
}

// GET /resource/memory-history：返回按区间聚合后的内存折线图数据。
function handleGetResourceMemoryHistory(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
  if (!requireAdmin(req, res)) return
  try {
    const range = normalizeMemoryRange(url.searchParams.get('range'))
    return json(res, getCachedMemoryHistory(loadResourceModules(), range))
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/status：返回资源中心总览。
function handleGetResourceStatus(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  try {
    return json(res, buildResourceStatus(loadResourceModules()))
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/tasks：返回脱敏任务列表。
function handleGetResourceTasks(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
  if (!requireAdmin(req, res)) return
  try {
    const mods = loadResourceModules()
    const status = String(url.searchParams.get('status') || '').trim()
    const limit = parsePositiveInt(url.searchParams.get('limit'), RESOURCE_TASK_LIMIT, 1, 500)
    const statuses = status ? status.split(',').map((item: string) => item.trim()).filter(Boolean) : undefined
    const tasks = mods.tasks.listResourceTasks({ statuses, limit }).map(sanitizeTask)
    return json(res, { ok: true, tasks })
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/events：返回最近资源事件。
function handleGetResourceEvents(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
  if (!requireAdmin(req, res)) return
  try {
    const mods = loadResourceModules()
    const limit = parsePositiveInt(url.searchParams.get('limit'), RESOURCE_EVENT_LIMIT, 1, 500)
    return json(res, { ok: true, events: collectResourceEvents(mods, limit) })
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/workers：返回 worker 心跳。
function handleGetResourceWorkers(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  try {
    return json(res, { ok: true, workers: loadResourceModules().tasks.listWorkerStates() })
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/media：返回媒体背压状态。
function handleGetResourceMedia(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  try {
    return json(res, { ok: true, media: loadResourceModules().media.getMediaBackpressureStatus() })
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// GET /resource/precompute：返回日报预计算状态。
function handleGetResourcePrecompute(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  try {
    return json(res, { ok: true, precompute: loadResourceModules().precompute.getPrecomputeSummary() })
  } catch (e) {
    return json(res, { ok: false, message: getErrorMessage(e) }, 500)
  }
}

// POST /resource/cancel：取消 pending/deferred 任务。
function handlePostResourceCancel(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}')
      const taskId = String(data.taskId || '').trim()
      if (!taskId) return json(res, { ok: false, message: 'taskId 不能为空' }, 400)
      const ok = loadResourceModules().tasks.cancelTask(taskId, 'dashboard', String(data.reason || 'dashboard cancel'))
      return json(res, { ok, message: ok ? '任务已取消' : '只能取消 pending/deferred 任务' }, ok ? 200 : 404)
    } catch (e) {
      return json(res, { ok: false, message: getErrorMessage(e) }, 400)
    }
  })
}

// POST /resource/reclaim-stale：回收已确认 stale 的 S0 锁。
function handlePostResourceReclaimStale(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}')
      const staleMs = parsePositiveInt(data.staleMs, 30000, 5000, 10 * 60 * 1000)
      const mods = loadResourceModules()
      const reclaimed = mods.gate.reclaimStaleLock(staleMs, 'dashboard')
      return json(res, { ok: true, reclaimed, status: mods.gate.getResourceGateStatus(staleMs) })
    } catch (e) {
      return json(res, { ok: false, message: getErrorMessage(e) }, 400)
    }
  })
}

// POST /resource/maintenance：切换同一份 ai-paused.txt 维护模式。
function handlePostResourceMaintenance(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}')
      if (data.enabled) writeFileSyncSafe(MAINTENANCE_FILE, String(data.message || '优化中，别急'))
      else try { fs.unlinkSync(MAINTENANCE_FILE) } catch { /* non-critical: missing maintenance file is already disabled */ }
      return json(res, { ok: true, enabled: !!data.enabled, message: data.enabled ? '维护模式已开启' : '维护模式已关闭' })
    } catch (e) {
      return json(res, { ok: false, message: getErrorMessage(e) }, 400)
    }
  })
}

const routes: Record<string, RouteHandler> = {
  'GET /dashboard/api/resource/status': handleGetResourceStatus,
  'GET /dashboard/api/resource/memory-history': handleGetResourceMemoryHistory,
  'GET /dashboard/api/resource/tasks': handleGetResourceTasks,
  'GET /dashboard/api/resource/events': handleGetResourceEvents,
  'GET /dashboard/api/resource/workers': handleGetResourceWorkers,
  'GET /dashboard/api/resource/media': handleGetResourceMedia,
  'GET /dashboard/api/resource/precompute': handleGetResourcePrecompute,
  'POST /dashboard/api/resource/cancel': handlePostResourceCancel,
  'POST /dashboard/api/resource/reclaim-stale': handlePostResourceReclaimStale,
  'POST /dashboard/api/resource/maintenance': handlePostResourceMaintenance,
}

export = { routes, buildResourceStatus, sanitizeTask, collectMemoryHistory, normalizeMemoryRange, getCachedMemoryHistory, cleanupOldProcessMetricFiles, collectDiskUsage, getCachedDiskUsage }
