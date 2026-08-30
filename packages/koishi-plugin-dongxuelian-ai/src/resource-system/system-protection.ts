/**
 * MODULE: S8 系统级保护状态。
 * 职责: 采集轻量进程/内存指标，记录内存告警和清理事件。
 * 边界: 只允许清理显式传入的子进程 pid，不执行服务管理或按进程名全局 kill。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { spawnSync } = require('child_process') as typeof import('child_process')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { appendJsonlEvent, ensureDir, readJsonFile, readRecentJsonlEvents } = require('../resource-common/files') as typeof import('../resource-common/files')
const { classifyResourceState, readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')

interface TerminateProcessTreeOptions {
  reason?: string
  source?: string
  taskId?: string
  kind?: string
  owner?: string
  timeoutMs?: number
  allowSingleProcessFallback?: boolean
  windowsRuntime?: WindowsTerminationRuntime
}

interface TerminateRecordedProcessPidsOptions extends TerminateProcessTreeOptions {
  eventNames?: string[]
  limit?: number
}

interface LinuxProcessEntry {
  pid: number
  ppid: number
}

interface WindowsTaskkillResult {
  status: number | null
  signal?: string | null
  error?: unknown
  stdout?: unknown
  stderr?: unknown
}

interface WindowsTerminationRuntime {
  runTaskkill(pid: number, timeoutMs: number): WindowsTaskkillResult
  isPidAlive(pid: number): boolean
  killPid(pid: number): void
}

// Parse a bounded positive integer from env/options and fall back on invalid values.
function parseBoundedPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const RESOURCE_SYSTEM_ROOT = path.join(DATA_DIR, 'resource-system')
const RESOURCE_RETENTION_CONTROL_FILE = path.join(DATA_DIR, 'resource-retention-control.json')
const PROCESS_METRICS_FILE_RE = /^process-metrics-\d{4}-\d{2}-\d{2}\.jsonl$/
const PROCESS_METRICS_RETENTION_MS = parseBoundedPositiveInt(process.env.RESOURCE_PROCESS_METRICS_RETENTION_HOURS, 72, 1, 24 * 30) * 60 * 60 * 1000
const PROCESS_METRICS_CLEANUP_INTERVAL_MS = parseBoundedPositiveInt(process.env.RESOURCE_PROCESS_METRICS_CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000)
const RESOURCE_HISTORY_RETENTION_MS = parseBoundedPositiveInt(process.env.RESOURCE_HISTORY_RETENTION_DAYS, 14, 1, 365) * 24 * 60 * 60 * 1000
const RESOURCE_HISTORY_DELETE_BATCH = parseBoundedPositiveInt(process.env.RESOURCE_HISTORY_DELETE_BATCH, 100, 1, 1000)
const PROCESS_METRICS_SAMPLE_INTERVAL_MS = parseBoundedPositiveInt(process.env.RESOURCE_PROCESS_METRICS_SAMPLE_INTERVAL_MS, 30000, 1000, 10 * 60 * 1000)
const MEMORY_RED_THRESHOLD_MB = parseBoundedPositiveInt(process.env.RESOURCE_MEMORY_RED_THRESHOLD_MB, 300, 64, 8192)
const MEMORY_RED_ALERT_COOLDOWN_MS = parseBoundedPositiveInt(process.env.RESOURCE_MEMORY_RED_ALERT_COOLDOWN_MS, 5 * 60 * 1000, 1000, 10 * 60 * 1000)
const WORKER_MEMORY_ALERT_COOLDOWN_MS = parseBoundedPositiveInt(process.env.RESOURCE_WORKER_MEMORY_ALERT_COOLDOWN_MS, 30000, 1000, 10 * 60 * 1000)
const DEFAULT_WORKER_RSS_LIMITS: Record<string, number> = {
  'daily-worker': Number(process.env.RESOURCE_DAILY_WORKER_RSS_MB || 900),
  'agent-worker': Number(process.env.RESOURCE_AGENT_WORKER_RSS_MB || 900),
  'media-worker': Number(process.env.RESOURCE_MEDIA_WORKER_RSS_MB || 650),
}

let lastResourceHistoryCleanupAt = 0
const recentProcessMetricsSamples = new Map<string, number>()
const recentMemoryRedAlerts = new Map<string, number>()
const recentWorkerMemoryAlerts = new Map<string, number>()

// 返回当天系统事件文件路径。
function systemEventFile(prefix: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(RESOURCE_SYSTEM_ROOT, `${prefix}-${stamp}.jsonl`)
}

// 裁剪跨越保留边界的 metrics 文件，只保留窗口内 JSONL 行。
function trimProcessMetricsFile(file: string, cutoff: number): boolean {
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    /* non-critical: metrics retention should skip unreadable files and keep protection checks running. */
    return false
  }
  const kept: string[] = []
  let changed = false
  for (const line of lines) {
    const normalizedLine = line.replace(/^\uFEFF/, '')
    let item
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
    try { fs.unlinkSync(file) } catch { /* non-critical: retention retry can handle the remaining empty metrics file later. */ return false }
    return true
  }
  const temp = `${file}.${process.pid}.${Date.now()}.retention.tmp`
  try {
    fs.writeFileSync(temp, `${kept.join('\n')}\n`, 'utf8')
    fs.renameSync(temp, file)
    return true
  } catch {
    /* non-critical: failed retention rewrite should leave the previous metrics file in place. */
    try { fs.unlinkSync(temp) } catch { /* 清理失败不影响采样写入。 */ }
    return false
  }
}

// 清理超过保留时间的 process-metrics 文件；只处理白名单文件名。
function cleanupOldProcessMetricsFiles(now = Date.now()): number {
  try {
    const entries = fs.readdirSync(RESOURCE_SYSTEM_ROOT, { withFileTypes: true })
    const cutoff = now - PROCESS_METRICS_RETENTION_MS
    let changed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !PROCESS_METRICS_FILE_RE.test(entry.name)) continue
      const stamp = entry.name.slice('process-metrics-'.length, 'process-metrics-YYYY-MM-DD'.length)
      const fileDay = Date.parse(`${stamp}T00:00:00.000Z`)
      if (!Number.isFinite(fileDay)) continue
      const fileEnd = fileDay + 24 * 60 * 60 * 1000
      const file = path.join(RESOURCE_SYSTEM_ROOT, entry.name)
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
      if (trimProcessMetricsFile(file, cutoff)) changed += 1
    }
    return changed
  } catch {
    /* non-critical: missing metrics directory means there are no old samples to clean. */
    return 0
  }
}

// 读取资源历史清理门禁；只有显式控制文件和外部备份路径同时有效才允许删除。
function readResourceRetentionControl(): { enabled: boolean; backupPath: string } {
  const control = readJsonFile(RESOURCE_RETENTION_CONTROL_FILE, null) as Record<string, unknown> | null
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

// 从白名单 JSONL 文件名中提取 UTC 日期；不匹配的文件永远不进入删除集合。
function getResourceHistoryFileDay(name: string): string {
  const match = /^(?:admissions|memory-alerts|process-cleanup|events)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
  return match ? match[1] : ''
}

// 在备份门禁下分批清理各资源域的过期按日 JSONL，并复用 process metrics 精细保留逻辑。
function cleanupOldResourceHistoryFiles(now = Date.now()): Record<string, unknown> {
  const control = readResourceRetentionControl()
  if (!control.enabled) return { enabled: false, deleted: 0, metricsChanged: 0, backupPath: control.backupPath }
  const roots = [
    path.join(DATA_DIR, 'resource-scheduler'),
    RESOURCE_SYSTEM_ROOT,
    path.join(DATA_DIR, 'media-backpressure'),
    path.join(DATA_DIR, 'resource-workers'),
    path.join(DATA_DIR, 'resource-gate'),
    path.join(DATA_DIR, 'daily-precompute'),
  ]
  const cutoff = now - RESOURCE_HISTORY_RETENTION_MS
  let deleted = 0
  for (const root of roots) {
    let entries: import('fs').Dirent[] = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (deleted >= RESOURCE_HISTORY_DELETE_BATCH || !entry.isFile()) continue
      const day = getResourceHistoryFileDay(entry.name)
      if (!day) continue
      const dayEnd = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
      if (!Number.isFinite(dayEnd) || dayEnd > cutoff) continue
      try {
        fs.unlinkSync(path.join(root, entry.name))
        deleted += 1
      } catch {
        /* A later daily pass retries an old file that could not be removed. */
      }
    }
  }
  const metricsChanged = cleanupOldProcessMetricsFiles(now)
  return { enabled: true, deleted, metricsChanged, backupPath: control.backupPath }
}

// 由统一 Koishi sampler 每天触发一次资源历史维护，worker 和 Dashboard 不参与。
function cleanupOldResourceHistoryFilesThrottled(now = Date.now()): void {
  if (now - lastResourceHistoryCleanupAt < PROCESS_METRICS_CLEANUP_INTERVAL_MS) return
  lastResourceHistoryCleanupAt = now
  const result = cleanupOldResourceHistoryFiles(now)
  if (result.enabled === true && (Number(result.deleted || 0) > 0 || Number(result.metricsChanged || 0) > 0)) {
    appendJsonlEvent(systemEventFile('process-cleanup'), { event: 'resource_history_retention_completed', ...result })
  }
}

// 清除超过节流窗口的内存态记录，限制常驻 Map 大小。
function cleanupRecentEntries(store: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, at] of store) {
    if (now - at > ttlMs) store.delete(key)
  }
}

// 判断统一 sampler 当前是否允许写入一条主机指标。
function shouldWriteProcessMetricsSample(extra: Record<string, unknown>, now = Date.now()): boolean {
  const sampleKey = [
    String(extra.sampler || extra.workerName || 'host'),
  ].join('|')
  const lastAt = recentProcessMetricsSamples.get(sampleKey) || 0
  if (now - lastAt < PROCESS_METRICS_SAMPLE_INTERVAL_MS) return false
  recentProcessMetricsSamples.set(sampleKey, now)
  cleanupRecentEntries(recentProcessMetricsSamples, now, PROCESS_METRICS_SAMPLE_INTERVAL_MS)
  return true
}

// 按资源档位和内存来源节流告警，档位变化时立即允许新事件。
function shouldWriteMemoryRedAlert(resourceState: string, source: string, now = Date.now()): boolean {
  const alertKey = [
    String(resourceState || 'unknown'),
    String(source || ''),
  ].join('|')
  const lastAt = recentMemoryRedAlerts.get(alertKey) || 0
  if (now - lastAt < MEMORY_RED_ALERT_COOLDOWN_MS) return false
  recentMemoryRedAlerts.set(alertKey, now)
  cleanupRecentEntries(recentMemoryRedAlerts, now, MEMORY_RED_ALERT_COOLDOWN_MS)
  return true
}

// 按 worker 身份与上限节流单进程 RSS 告警。
function shouldWriteWorkerMemoryAlert(workerName: string, pid: number, limitMb: number, now = Date.now()): boolean {
  const alertKey = [String(workerName || ''), String(pid), String(limitMb)].join('|')
  const lastAt = recentWorkerMemoryAlerts.get(alertKey) || 0
  if (now - lastAt < WORKER_MEMORY_ALERT_COOLDOWN_MS) return false
  recentWorkerMemoryAlerts.set(alertKey, now)
  cleanupRecentEntries(recentWorkerMemoryAlerts, now, WORKER_MEMORY_ALERT_COOLDOWN_MS)
  return true
}

// 读取当前进程 RSS，单位 MB。
function readCurrentProcessRssMb(): number | null {
  try {
    return Math.round((process.memoryUsage().rss || 0) / 1024 / 1024)
  } catch {
    /* non-critical: memoryUsage failure should only omit this process RSS sample. */
    return null
  }
}

// 返回 worker RSS 上限；未知 worker 使用保守默认值。
function getWorkerRssLimitMb(workerName: string): number {
  const name = String(workerName || '')
  return DEFAULT_WORKER_RSS_LIMITS[name] || Number(process.env.RESOURCE_WORKER_RSS_MB || 768)
}

// 将外部传入 pid 收敛成正整数。
function normalizePid(value: unknown): number | null {
  const pid = Number(value)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return pid
}

// 拒绝明显危险的 pid，避免清理当前进程、父进程或系统根进程。
function getUnsafePidReason(pid: number): string {
  if (pid <= 1) return 'pid_le_1'
  if (pid === process.pid) return 'current_process'
  if (pid === process.ppid) return 'parent_process'
  return ''
}

// 判断 pid 当前是否仍可见。
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code || '') : ''
    return code === 'EPERM'
  }
}

// 提取系统调用错误码，供清理事件保留可诊断信息。
function getProcessErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  return String((error as { code?: unknown }).code || '')
}

// 提取系统调用错误消息，避免事件中丢失非 Error 异常。
function getProcessErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || '')
  }
  return error ? String(error) : ''
}

// 使用 Windows taskkill 清理指定根进程及其子进程树。
function runWindowsTaskkill(pid: number, timeoutMs: number): WindowsTaskkillResult {
  return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
}

// 使用 Node 的 Windows 单进程强制终止能力清理根 PID。
function killWindowsPid(pid: number): void {
  process.kill(pid, 'SIGKILL')
}

const DEFAULT_WINDOWS_TERMINATION_RUNTIME: WindowsTerminationRuntime = {
  runTaskkill: runWindowsTaskkill,
  isPidAlive,
  killPid: killWindowsPid,
}

// 读取 Linux /proc 进程父子关系，用于只清理指定 root pid 的子树。
function readLinuxProcessEntries(): LinuxProcessEntry[] {
  if (process.platform !== 'linux') return []
  let entries: string[] = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    /* non-critical: /proc may be unavailable outside Linux-like environments. */
    return []
  }
  const result: LinuxProcessEntry[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const stat = fs.readFileSync(path.join('/proc', entry, 'stat'), 'utf8')
      const end = stat.lastIndexOf(')')
      if (end < 0) continue
      const parts = stat.slice(end + 2).trim().split(/\s+/)
      const ppid = Number(parts[1])
      if (Number.isInteger(pid) && Number.isInteger(ppid)) result.push({ pid, ppid })
    } catch {
      /* Process may exit while scanning /proc. */
    }
  }
  return result
}

// 收集 root pid 的 Linux 子树，返回顺序为子进程在前、root 在后。
function collectLinuxProcessTree(rootPid: number): number[] {
  const entries = readLinuxProcessEntries()
  const childrenByParent = new Map<number, number[]>()
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ppid) || []
    children.push(entry.pid)
    childrenByParent.set(entry.ppid, children)
  }
  const result: number[] = []
  const seen = new Set<number>()
  const visit = (pid: number): void => {
    if (seen.has(pid)) return
    seen.add(pid)
    for (const child of childrenByParent.get(pid) || []) visit(child)
    result.push(pid)
  }
  visit(rootPid)
  return result
}

// 在 Windows 上优先清理进程树，并按显式授权决定是否兜底终止根 PID。
function terminateWindowsProcessTree(
  pid: number,
  timeoutMs: number,
  allowSingleProcessFallback: boolean,
  runtime: WindowsTerminationRuntime,
): Record<string, unknown> {
  const taskkill = runtime.runTaskkill(pid, timeoutMs)
  const aliveAfterTaskkill = runtime.isPidAlive(pid)
  const taskkillError = getProcessErrorMessage(taskkill.error)
  const taskkillErrorCode = getProcessErrorCode(taskkill.error)
  const base = {
    command: 'taskkill',
    status: taskkill.status,
    signal: taskkill.signal || null,
    error: taskkillError,
    errorCode: taskkillErrorCode,
    stdout: String(taskkill.stdout || '').slice(0, 1000),
    stderr: String(taskkill.stderr || '').slice(0, 1000),
    fallbackAttempted: false,
    fallbackScope: 'none',
    aliveAfterTaskkill,
    aliveAfterFallback: null,
    treeTerminationConfirmed: taskkill.status === 0 && !aliveAfterTaskkill,
  }

  if (!aliveAfterTaskkill) {
    return { ...base, killedPids: [pid], failedPids: [] }
  }
  if (taskkill.status === 0) {
    const error = 'process_still_alive_after_taskkill'
    return { ...base, error, killedPids: [], failedPids: [{ pid, error, errorCode: '' }] }
  }
  if (!allowSingleProcessFallback) {
    const error = 'single_process_fallback_not_authorized'
    return { ...base, error, killedPids: [], failedPids: [{ pid, error, errorCode: taskkillErrorCode }] }
  }

  try {
    runtime.killPid(pid)
  } catch (error) {
    const fallbackError = getProcessErrorMessage(error)
    const fallbackErrorCode = getProcessErrorCode(error)
    return {
      ...base,
      command: 'taskkill+process.kill',
      error: fallbackError,
      errorCode: fallbackErrorCode,
      fallbackAttempted: true,
      fallbackScope: 'root_only',
      aliveAfterFallback: runtime.isPidAlive(pid),
      treeTerminationConfirmed: false,
      killedPids: [],
      failedPids: [{ pid, error: fallbackError, errorCode: fallbackErrorCode }],
    }
  }

  const aliveAfterFallback = runtime.isPidAlive(pid)
  if (aliveAfterFallback) {
    const error = 'process_still_alive_after_fallback'
    return {
      ...base,
      command: 'taskkill+process.kill',
      error,
      fallbackAttempted: true,
      fallbackScope: 'root_only',
      aliveAfterFallback,
      treeTerminationConfirmed: false,
      killedPids: [],
      failedPids: [{ pid, error, errorCode: '' }],
    }
  }
  return {
    ...base,
    command: 'taskkill+process.kill',
    fallbackAttempted: true,
    fallbackScope: 'root_only',
    aliveAfterFallback,
    treeTerminationConfirmed: false,
    killedPids: [pid],
    failedPids: [],
  }
}

// 在 POSIX 平台上定点清理 root pid 及其可枚举子进程。
function terminatePosixProcessTree(pid: number): Record<string, unknown> {
  const targets = process.platform === 'linux' ? collectLinuxProcessTree(pid) : [pid]
  const killedPids: number[] = []
  const failedPids: Array<{ pid: number, error: string }> = []
  for (const targetPid of targets) {
    const unsafeReason = getUnsafePidReason(targetPid)
    if (unsafeReason) {
      failedPids.push({ pid: targetPid, error: unsafeReason })
      continue
    }
    if (!isPidAlive(targetPid)) continue
    try {
      process.kill(targetPid, 'SIGKILL')
      killedPids.push(targetPid)
    } catch (error) {
      failedPids.push({ pid: targetPid, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { command: 'process.kill', killedPids, failedPids }
}

// 对调用方显式传入的进程 pid 做定点清理，并把所有尝试落到 S8 事件。
function terminateProcessTree(pidValue: unknown, options: TerminateProcessTreeOptions = {}): Record<string, unknown> {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  const pid = normalizePid(pidValue)
  const platform = options.windowsRuntime ? 'win32' : process.platform
  const base = {
    rootPid: pid,
    platform,
    reason: options.reason || 'process_tree_terminate',
    source: options.source || '',
    taskId: options.taskId || '',
    kind: options.kind || '',
    owner: options.owner || '',
  }
  if (!pid) {
    const result = { ...base, event: 'process_tree_terminate_skipped', skippedReason: 'invalid_pid' }
    writeProcessCleanupEvent(result)
    return result
  }
  const unsafeReason = getUnsafePidReason(pid)
  if (unsafeReason) {
    const result = { ...base, event: 'process_tree_terminate_skipped', skippedReason: unsafeReason }
    writeProcessCleanupEvent(result)
    return result
  }
  const windowsRuntime = options.windowsRuntime || DEFAULT_WINDOWS_TERMINATION_RUNTIME
  const pidAlive = platform === 'win32' ? windowsRuntime.isPidAlive(pid) : isPidAlive(pid)
  if (!pidAlive) {
    const result = { ...base, event: 'process_tree_not_running' }
    writeProcessCleanupEvent(result)
    return result
  }
  const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs || 5000)))
  const detail = platform === 'win32'
    ? terminateWindowsProcessTree(pid, timeoutMs, options.allowSingleProcessFallback === true, windowsRuntime)
    : terminatePosixProcessTree(pid)
  const failed = Array.isArray(detail.failedPids) && detail.failedPids.length > 0
  const result = {
    ...base,
    event: failed ? 'process_tree_terminate_failed' : 'process_tree_terminated',
    timeoutMs,
    ...detail,
  }
  writeProcessCleanupEvent(result)
  return result
}

// 从 S8 cleanup 事件中提取已记录的 browser/root pid。
function readRecordedProcessPid(event: Record<string, unknown>): number | null {
  return normalizePid(event.browserPid || event.rootPid)
}

// 按 taskId 清理此前已经记录过的 Chromium/browser pid；不按进程名扫描系统。
function terminateRecordedProcessPids(options: TerminateRecordedProcessPidsOptions = {}): Record<string, unknown> {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  const taskId = String(options.taskId || '')
  const eventNames = new Set((options.eventNames && options.eventNames.length
    ? options.eventNames
    : ['chromium_launched', 'daily_chromium_launched']
  ).map(String))
  if (!taskId) {
    const result = {
      event: 'recorded_process_cleanup_skipped',
      reason: options.reason || 'recorded_process_cleanup',
      skippedReason: 'missing_task_id',
      source: options.source || '',
      kind: options.kind || '',
      owner: options.owner || '',
      candidateCount: 0,
    }
    writeProcessCleanupEvent(result)
    return result
  }
  const limit = Math.max(40, Math.min(500, Number(options.limit || 160)))
  const events = readRecentJsonlEvents(RESOURCE_SYSTEM_ROOT, 'process-cleanup-', limit)
  const candidates = new Map<number, boolean>()
  for (const rawEvent of events) {
    const event = rawEvent && typeof rawEvent === 'object' ? rawEvent as Record<string, unknown> : {}
    if (String(event.taskId || '') !== taskId) continue
    if (!eventNames.has(String(event.event || ''))) continue
    const pid = readRecordedProcessPid(event)
    if (!pid) continue
    // 只有明确由当前进程启动并记录的子进程才允许 Windows 根进程兜底。
    const ownedByCurrentProcess = Number(event.parentPid || 0) === process.pid
    candidates.set(pid, (candidates.get(pid) || false) || ownedByCurrentProcess)
  }
  if (!candidates.size) {
    return {
      event: 'recorded_process_cleanup_skipped',
      reason: options.reason || 'recorded_process_cleanup',
      source: options.source || '',
      taskId,
      kind: options.kind || '',
      owner: options.owner || '',
      skippedReason: 'no_recorded_pid',
      candidateCount: 0,
      pids: [],
      resultEvents: [],
    }
  }
  const candidateEntries = Array.from(candidates.entries())
  const results = candidateEntries.map(([pid, allowSingleProcessFallback]) => terminateProcessTree(pid, {
    reason: options.reason || 'recorded_process_cleanup',
    source: options.source || 'recorded_process_cleanup',
    taskId,
    kind: options.kind || '',
    owner: options.owner || '',
    timeoutMs: options.timeoutMs,
    allowSingleProcessFallback,
    windowsRuntime: options.windowsRuntime,
  }))
  const hasRealCleanup = results.some((item) => {
    const event = item && typeof item === 'object' ? String((item as Record<string, unknown>).event || '') : ''
    const killedPidsValue = item && typeof item === 'object'
      ? (item as Record<string, unknown>).killedPids
      : null
    const killedPids = Array.isArray(killedPidsValue) ? killedPidsValue : []
    return event === 'process_tree_terminated' && killedPids.length > 0
  })
  const result = {
    event: hasRealCleanup ? 'recorded_process_cleanup_completed' : 'recorded_process_cleanup_skipped',
    reason: options.reason || 'recorded_process_cleanup',
    source: options.source || '',
    taskId,
    kind: options.kind || '',
    owner: options.owner || '',
    skippedReason: hasRealCleanup ? '' : 'no_process_terminated',
    candidateCount: candidateEntries.length,
    pids: candidateEntries.map(([pid]) => pid),
    resultEvents: results.map(item => item.event),
  }
  writeProcessCleanupEvent(result)
  return result
}

// 检查当前 worker 进程是否超过 RSS 上限；只写事件，不执行系统 kill。
function checkWorkerMemoryLimit(workerName: string, limitMb?: number): Record<string, unknown> {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  const rssMb = readCurrentProcessRssMb()
  const resolvedLimit = Number.isFinite(Number(limitMb)) ? Number(limitMb) : getWorkerRssLimitMb(workerName)
  const exceeded = rssMb !== null && rssMb > resolvedLimit
  const result = {
    workerName,
    pid: process.pid,
    rssMb,
    limitMb: resolvedLimit,
    exceeded,
  }
  if (exceeded && shouldWriteWorkerMemoryAlert(workerName, process.pid, resolvedLimit)) {
    appendJsonlEvent(systemEventFile('memory-alerts'), {
      event: 'worker_memory_limit_exceeded',
      ...result,
    })
    appendJsonlEvent(systemEventFile('process-cleanup'), {
      event: 'worker_should_exit',
      reason: 'memory_limit_exceeded',
      ...result,
    })
  }
  return result
}

// 采集轻量系统指标并落盘。
function collectProcessMetrics(extra: Record<string, unknown> = {}): Record<string, unknown> {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  const now = Date.now()
  cleanupOldResourceHistoryFilesThrottled(now)
  const mem = readLinuxMeminfo()
  const resourceState = classifyResourceState(mem.availableMb)
  const metrics = {
    event: 'process_metrics',
    pid: process.pid,
    processName: process.title,
    rssMb: readCurrentProcessRssMb(),
    memAvailableMb: mem.availableMb,
    memTotalMb: mem.totalMb,
    memSource: mem.source,
    ...extra,
  }
  if (shouldWriteProcessMetricsSample(extra, now)) {
    appendJsonlEvent(systemEventFile('process-metrics'), metrics)
  }
  if (
    mem.availableMb !== null
    && mem.availableMb < MEMORY_RED_THRESHOLD_MB
    && shouldWriteMemoryRedAlert(resourceState, mem.source, now)
  ) {
    appendJsonlEvent(systemEventFile('memory-alerts'), {
      event: 'memory_red',
      pid: process.pid,
      memAvailableMb: mem.availableMb,
      memTotalMb: mem.totalMb,
      memSource: mem.source,
      resourceState,
      thresholdMb: MEMORY_RED_THRESHOLD_MB,
    })
  }
  return metrics
}

// 写入 worker 或 Chromium 清理事件，只记录不直接操作系统进程。
function writeProcessCleanupEvent(data: Record<string, unknown>): void {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  appendJsonlEvent(systemEventFile('process-cleanup'), { event: 'process_cleanup', ...data })
}

// 返回 Dashboard 所需系统保护摘要。
function getSystemProtectionStatus(): Record<string, unknown> {
  ensureDir(RESOURCE_SYSTEM_ROOT)
  const mem = readLinuxMeminfo()
  return {
    pid: process.pid,
    processName: process.title,
    rssMb: readCurrentProcessRssMb(),
    memAvailableMb: mem.availableMb,
    memTotalMb: mem.totalMb,
    memSource: mem.source,
    hasProcMeminfo: fs.existsSync('/proc/meminfo'),
    memoryAlerts: readRecentJsonlEvents(RESOURCE_SYSTEM_ROOT, 'memory-alerts-', 40),
    processMetrics: readRecentJsonlEvents(RESOURCE_SYSTEM_ROOT, 'process-metrics-', 40),
    cleanupEvents: readRecentJsonlEvents(RESOURCE_SYSTEM_ROOT, 'process-cleanup-', 40),
  }
}

export = {
  RESOURCE_SYSTEM_ROOT,
  RESOURCE_RETENTION_CONTROL_FILE,
  PROCESS_METRICS_RETENTION_MS,
  MEMORY_RED_THRESHOLD_MB,
  collectProcessMetrics,
  checkWorkerMemoryLimit,
  writeProcessCleanupEvent,
  terminateProcessTree,
  terminateRecordedProcessPids,
  getSystemProtectionStatus,
  cleanupOldProcessMetricsFiles,
  cleanupOldResourceHistoryFiles,
}
