/**
 * MODULE: S8 系统级保护状态。
 * 职责: 采集轻量进程/内存指标，记录内存告警和清理事件。
 * 边界: 只允许清理显式传入的子进程 pid，不执行服务管理或按进程名全局 kill。
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { appendJsonlEvent, ensureDir, readRecentJsonlEvents } = require('../resource-common/files') as typeof import('../resource-common/files')
const { readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')

interface TerminateProcessTreeOptions {
  reason?: string
  source?: string
  taskId?: string
  kind?: string
  owner?: string
  timeoutMs?: number
}

interface TerminateRecordedProcessPidsOptions extends TerminateProcessTreeOptions {
  eventNames?: string[]
  limit?: number
}

interface LinuxProcessEntry {
  pid: number
  ppid: number
}

const RESOURCE_SYSTEM_ROOT = path.join(DATA_DIR, 'resource-system')
const DEFAULT_WORKER_RSS_LIMITS: Record<string, number> = {
  'daily-worker': Number(process.env.RESOURCE_DAILY_WORKER_RSS_MB || 900),
  'agent-worker': Number(process.env.RESOURCE_AGENT_WORKER_RSS_MB || 900),
  'media-worker': Number(process.env.RESOURCE_MEDIA_WORKER_RSS_MB || 650),
}

// 返回当天系统事件文件路径。
function systemEventFile(prefix: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(RESOURCE_SYSTEM_ROOT, `${prefix}-${stamp}.jsonl`)
}

// 读取当前进程 RSS，单位 MB。
function readCurrentProcessRssMb(): number | null {
  try {
    return Math.round((process.memoryUsage().rss || 0) / 1024 / 1024)
  } catch {
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

// 读取 Linux /proc 进程父子关系，用于只清理指定 root pid 的子树。
function readLinuxProcessEntries(): LinuxProcessEntry[] {
  if (process.platform !== 'linux') return []
  let entries: string[] = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
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

// 在 Windows 上使用 taskkill 定点清理指定 pid 的子树。
function terminateWindowsProcessTree(pid: number, timeoutMs: number): Record<string, unknown> {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return {
    command: 'taskkill',
    status: result.status,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : '',
    stdout: String(result.stdout || '').slice(0, 1000),
    stderr: String(result.stderr || '').slice(0, 1000),
    killedPids: result.status === 0 ? [pid] : [],
    failedPids: result.status === 0 ? [] : [pid],
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
  const base = {
    rootPid: pid,
    platform: process.platform,
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
  if (!isPidAlive(pid)) {
    const result = { ...base, event: 'process_tree_not_running' }
    writeProcessCleanupEvent(result)
    return result
  }
  const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs || 5000)))
  const detail = process.platform === 'win32'
    ? terminateWindowsProcessTree(pid, timeoutMs)
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
  const candidates: number[] = []
  const seen = new Set<number>()
  for (const rawEvent of events) {
    const event = rawEvent && typeof rawEvent === 'object' ? rawEvent as Record<string, unknown> : {}
    if (String(event.taskId || '') !== taskId) continue
    if (!eventNames.has(String(event.event || ''))) continue
    const pid = readRecordedProcessPid(event)
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    candidates.push(pid)
  }
  const results = candidates.map(pid => terminateProcessTree(pid, {
    reason: options.reason || 'recorded_process_cleanup',
    source: options.source || 'recorded_process_cleanup',
    taskId,
    kind: options.kind || '',
    owner: options.owner || '',
    timeoutMs: options.timeoutMs,
  }))
  const result = {
    event: 'recorded_process_cleanup_completed',
    reason: options.reason || 'recorded_process_cleanup',
    source: options.source || '',
    taskId,
    kind: options.kind || '',
    owner: options.owner || '',
    candidateCount: candidates.length,
    pids: candidates,
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
  if (exceeded) {
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
  const mem = readLinuxMeminfo()
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
  appendJsonlEvent(systemEventFile('process-metrics'), metrics)
  if (mem.availableMb !== null && mem.availableMb < 300) {
    appendJsonlEvent(systemEventFile('memory-alerts'), {
      event: 'memory_black',
      pid: process.pid,
      memAvailableMb: mem.availableMb,
      memTotalMb: mem.totalMb,
      memSource: mem.source,
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
  collectProcessMetrics,
  checkWorkerMemoryLimit,
  writeProcessCleanupEvent,
  terminateProcessTree,
  terminateRecordedProcessPids,
  getSystemProtectionStatus,
}
