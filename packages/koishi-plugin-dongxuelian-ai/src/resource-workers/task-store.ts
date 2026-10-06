/**
 * MODULE: S2 任务存储。
 * 职责: 管理资源任务的原子提交、领取、状态迁移、结果和 worker 心跳。
 * 边界: 不执行日报、Agent 或媒体业务逻辑。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path')
const {
  appendJsonlEvent,
  ensureDir,
  listJsonFiles,
  nowIso,
  readJsonFile,
  removePath,
  renameFileAtomic,
  sanitizeId,
  writeJsonAtomic,
} = require('../resource-common/files') as typeof import('../resource-common/files')
const { redactSensitiveData, redactSensitiveText } = require('../core/redactor') as typeof import('../core/redactor')
const { ReportAnalysisError, createReportAnalysisDiagnostics, isReportTotalTimeoutError, sanitizeReportAnalysisDiagnostics, sanitizeReportDiagnosticText } = require('../daily-precompute/report-analysis') as typeof import('../daily-precompute/report-analysis')
const { resolveReportPeriod } = require('../daily-precompute/report-period') as typeof import('../daily-precompute/report-period')
type ReportAnalysisDiagnostics = import('../daily-precompute/report-analysis').ReportAnalysisDiagnostics
type ResourceTask = import('./task-types').ResourceTask
type ResourceTaskNotify = import('./task-types').ResourceTaskNotify
type DailyReportDeliveryProgress = import('./task-types').DailyReportDeliveryProgress
type ResourceTaskStatus = import('./task-types').ResourceTaskStatus
type ResourceWorkerState = import('./task-types').ResourceWorkerState
const {
  WORKERS_ROOT,
  TASKS_ROOT,
  RESULTS_ROOT,
  WORKER_STATE_DIR,
  SUPERVISOR_DIR,
  getTaskFile,
  getTaskResultDir,
  getTaskStatusDir,
  getPendingKindDir,
  getWorkerStateFile,
  getWorkerEventFile,
} = require('./task-paths') as typeof import('./task-paths')

interface SubmitTaskInput {
  id?: string
  kind: string
  source?: string
  channelKey?: string
  userId?: string
  priority?: number
  expiresAt?: string
  timeoutMs?: number
  payload?: Record<string, unknown>
  notify?: ResourceTaskNotify
}

interface ListTasksOptions {
  statuses?: string[]
  limit?: number
}

interface CountTasksOptions {
  statuses?: string[]
  limit?: number
  kind?: string
}

interface CountTasksByKindOptions {
  statuses?: string[]
  limit?: number
  kind: string
}

interface ScanTasksOptions {
  kinds?: string[]
}

const RESOURCE_TASK_CANONICAL_STATUS_ORDER: ResourceTaskStatus[] = [
  'cancelled',
  'done',
  'failed',
  'deferred',
  'running',
  'claiming',
  'pending',
]

const DEFAULT_ACTIVE_TASK_STATUSES: ResourceTaskStatus[] = ['pending', 'claiming', 'running', 'deferred']

// 任务完成回调集合 - 用于事件驱动通知
const taskCompletedCallbacks: Set<(taskId: string) => void> = new Set()

/**
 * 注册任务完成回调
 * @param fn 回调函数，接收 taskId 参数
 */
function registerTaskCompletedCallback(fn: (taskId: string) => void): void {
  if (typeof fn === 'function') {
    taskCompletedCallbacks.add(fn)
  }
}

/**
 * 取消注册任务完成回调
 * @param fn 回调函数
 */
function unregisterTaskCompletedCallback(fn: (taskId: string) => void): void {
  taskCompletedCallbacks.delete(fn)
}

/**
 * 触发所有任务完成回调
 * @param taskId 完成的任务 ID
 */
function triggerTaskCompletedCallbacks(taskId: string): void {
  for (const fn of taskCompletedCallbacks) {
    try {
      fn(taskId)
    } catch {
      // 单个回调出错不影响其他回调
    }
  }
}

function redactRecord(value: unknown = {}): Record<string, unknown> {
  const redacted = redactSensitiveData(value)
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {}
}

const DEFAULT_DAILY_SUMMARY_RETRY_AFTER_MS = Math.max(
  5 * 60 * 1000,
  Math.min(6 * 60 * 60 * 1000, Number(process.env.DAILY_SUMMARY_RETRY_AFTER_MS || 30 * 60 * 1000)),
)

function buildTaskRetryAfter(task: ResourceTask): string {
  if (String(task.kind || '') !== 'daily_summary') return ''
  return new Date(Date.now() + DEFAULT_DAILY_SUMMARY_RETRY_AFTER_MS).toISOString()
}

// 初始化 S2 任务系统目录。
function ensureTaskDirs(): void {
  for (const dir of [
    WORKERS_ROOT,
    TASKS_ROOT,
    RESULTS_ROOT,
    WORKER_STATE_DIR,
    getTaskStatusDir('pending'),
    getTaskStatusDir('claiming'),
    getTaskStatusDir('running'),
    getTaskStatusDir('done'),
    getTaskStatusDir('failed'),
    getTaskStatusDir('cancelled'),
    getTaskStatusDir('deferred'),
  ]) ensureDir(dir)
}

// 写入 S2 事件，供 Dashboard 资源中心展示。
function writeWorkerEvent(event: string, data: Record<string, unknown> = {}): void {
  appendJsonlEvent(getWorkerEventFile(), { event, ...redactRecord(data) })
}

// 生成资源任务 ID。
function createTaskId(kind: string, channelKey = ''): string {
  return `${sanitizeId(kind)}-${Date.now()}-${sanitizeId(channelKey || 'global')}-${Math.random().toString(36).slice(2, 8)}`
}

// 提交任务到 S2 pending 队列。
function submitResourceTask(input: SubmitTaskInput): ResourceTask {
  ensureTaskDirs()
  const now = nowIso()
  const task: ResourceTask = {
    id: sanitizeId(input.id || createTaskId(input.kind, input.channelKey)),
    kind: String(input.kind || 'unknown'),
    status: 'pending',
    source: String(input.source || 'unknown'),
    channelKey: String(input.channelKey || ''),
    userId: String(input.userId || ''),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt || '',
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : 300000,
    payload: redactRecord(input.payload || {}),
    notify: redactRecord(input.notify || { target: 'none', status: 'pending' }),
  }
  writeJsonAtomic(getTaskFile('pending', task.kind, task.id), task)
  writeWorkerEvent('task_created', { taskId: task.id, kind: task.kind, source: task.source, channelKey: task.channelKey, priority: task.priority })
  return task
}

// 在 JSON 文件边界验证完整任务 DTO；非法或历史残缺记录不会进入可信域。
function parseResourceTask(value: unknown): ResourceTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const task = value as Partial<ResourceTask>
  if (
    typeof task.id !== 'string' || !task.id
    || typeof task.kind !== 'string' || !task.kind
    || typeof task.status !== 'string' || !isResourceTaskStatus(task.status)
    || typeof task.source !== 'string'
    || typeof task.channelKey !== 'string'
    || typeof task.userId !== 'string'
    || typeof task.priority !== 'number' || !Number.isFinite(task.priority)
    || typeof task.createdAt !== 'string'
    || typeof task.updatedAt !== 'string'
    || typeof task.expiresAt !== 'string'
    || typeof task.timeoutMs !== 'number' || !Number.isFinite(task.timeoutMs)
    || !task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)
    || !task.notify || typeof task.notify !== 'object' || Array.isArray(task.notify)
  ) return null
  return task as ResourceTask
}

// 从任意状态目录读取任务文件。
function readTaskFile(file: string): ResourceTask | null {
  return parseResourceTask(readJsonFile<unknown>(file, null))
}

function normalizeKinds(kinds: string[] = []): string[] {
  return Array.from(new Set(kinds.map(String).filter(Boolean)))
}

// 扫描指定状态的任务，pending 会递归扫描 kind 子目录。
function scanTasksByStatus(status: string, limit = 500, options: ScanTasksOptions = {}): ResourceTask[] {
  const recursive = status === 'pending'
  const kinds = status === 'pending' ? normalizeKinds(options.kinds || []) : []
  const files = kinds.length
    ? kinds.flatMap(kind => listJsonFiles(getPendingKindDir(kind), { recursive, maxFiles: limit }))
    : listJsonFiles(getTaskStatusDir(status), { recursive, maxFiles: limit })
  const tasks = files.map(readTaskFile).filter((task): task is ResourceTask => Boolean(task))
  tasks.sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  return tasks.slice(0, limit)
}

function countTaskFilesByStatus(status: string, limit = 20000): number {
  const recursive = status === 'pending'
  return listJsonFiles(getTaskStatusDir(status), { recursive, maxFiles: limit }).length
}

// 列出任务，用于 Dashboard 队列视图。
function listResourceTasks(options: ListTasksOptions = {}): ResourceTask[] {
  ensureTaskDirs()
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses.map(String)
    : ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 200)))
  const tasks: ResourceTask[] = []
  for (const status of statuses) {
    if (tasks.length >= limit) break
    tasks.push(...scanTasksByStatus(status, limit - tasks.length))
  }
  tasks.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  return tasks.slice(0, limit)
}

// 列出每个状态目录中仍被系统保留的任务，供管理员诊断分页统一排序。
function listResourceTasksForDiagnostics(): ResourceTask[] {
  ensureTaskDirs()
  const tasks: ResourceTask[] = []
  for (const status of ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']) {
    tasks.push(...scanTasksByStatus(status, 20000))
  }
  tasks.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  return tasks
}

// 完整枚举活动日报用于删除保护；读取失败、非法DTO和链接不能被当成无任务。
function listActiveDailyReportTasks(): ResourceTask[] {
  ensureTaskDirs()
  const tasks: ResourceTask[] = []
  for (const status of DEFAULT_ACTIVE_TASK_STATUSES) {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('日报维护任务目录存在链接，已停止清理')
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (status !== 'pending') throw new Error('日报维护任务目录结构异常，已停止清理')
          walk(file)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const task = readTaskFile(file)
        if (!task || task.status !== status || entry.name !== `${sanitizeId(task.id)}.json`
          || path.resolve(file) !== path.resolve(getTaskFile(status, task.kind, task.id))) throw new Error('日报维护活动任务记录损坏或位置不一致，已停止清理')
        if (task.kind === 'daily_report') tasks.push(task)
      }
    }
    walk(getTaskStatusDir(status))
  }
  return tasks
}

// 先过滤已通知记录再应用发送批次上限，历史已完成记录不阻塞新失败日报。
function listTerminalTasksForNotification(matcher: (task: ResourceTask) => boolean, limit: number): ResourceTask[] {
  ensureTaskDirs()
  const tasks: ResourceTask[] = []
  for (const status of ['failed', 'done'] as const) {
    const dir = getTaskStatusDir(status)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const task = readTaskFile(path.join(dir, entry.name))
      if (!task || task.status !== status || !matcher(task)) continue
      tasks.push(task)
      if (tasks.length >= limit) return tasks
    }
  }
  return tasks
}

// 按 kind + statuses 统计任务数量，供后台提交前门做轻量 backlog 判断。
function countResourceTasks(options: CountTasksOptions = {}): number {
  const kind = String(options.kind || '')
  const limit = Math.max(1, Math.min(20000, Number(options.limit || 20000)))
  if (kind) {
    return countResourceTasksByKind({
      kind,
      statuses: options.statuses,
      limit,
    })
  }
  const tasks = listResourceTasks({
    statuses: options.statuses,
    limit,
  })
  return tasks.length
}

// 按 kind 统计任务数量；当只需要判断是否超过阈值时可提前停。
function countResourceTasksByKind(options: CountTasksByKindOptions, matcher: (task: ResourceTask) => boolean = () => true): number {
  const kind = String(options.kind || '')
  if (!kind) return 0
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses.map(String)
    : ['pending', 'claiming', 'running', 'deferred']
  const limit = Math.max(1, Math.min(20000, Number(options.limit || 20000)))
  let total = 0
  for (const status of statuses) {
    if (total >= limit) break
    const dir = status === 'pending' ? getPendingKindDir(kind) : getTaskStatusDir(status)
    const files = listJsonFiles(dir, { recursive: false, maxFiles: 20000 })
    for (const file of files) {
      const task = readTaskFile(file)
      if (!task) continue
      if (String(task.kind || '') !== kind) continue
      if (!matcher(task)) continue
      total += 1
      if (total >= limit) break
    }
  }
  return total
}

function isResourceTaskStatus(status: string): status is ResourceTaskStatus {
  return (RESOURCE_TASK_CANONICAL_STATUS_ORDER as string[]).includes(status)
}

function normalizeTaskStatusList(statuses?: string[]): ResourceTaskStatus[] {
  const raw = Array.isArray(statuses) && statuses.length ? statuses.map(String) : DEFAULT_ACTIVE_TASK_STATUSES
  const result = raw.filter(isResourceTaskStatus)
  return result.length ? result : DEFAULT_ACTIVE_TASK_STATUSES
}

// 按已知 kind + channel 查找活跃任务，避免调用方用全局窗口扫盘后再过滤。
function findResourceTaskByKindAndChannel(kind: string, channelKey: string, statuses?: string[]): ResourceTask | null {
  ensureTaskDirs()
  const targetKind = String(kind || '')
  const targetChannel = String(channelKey || '')
  if (!targetKind) return null
  for (const status of normalizeTaskStatusList(statuses)) {
    const dir = status === 'pending' ? getPendingKindDir(targetKind) : getTaskStatusDir(status)
    const files = listJsonFiles(dir, { recursive: false, maxFiles: 20000 })
    for (const file of files) {
      const task = readTaskFile(file)
      if (!task) continue
      if (String(task.kind || '') !== targetKind) continue
      if (String(task.channelKey || '') !== targetChannel) continue
      return task
    }
  }
  return null
}

// 汇总任务队列状态，供 S7 总览读取。
function getTaskQueueSummary(): Record<string, unknown> {
  const statuses = ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
  const summary: Record<string, number> = {}
  for (const status of statuses) summary[status] = countTaskFilesByStatus(status, 20000)
  return summary
}

// claim 一个 pending 任务；rename 成功才算抢到。
function claimNextTask(kind: string | string[], workerName: string): ResourceTask | null {
  ensureTaskDirs()
  const kinds = normalizeKinds(Array.isArray(kind) ? kind : [String(kind || '')])
  const tasks = scanTasksByStatus('pending', 1000, { kinds }).filter(task => !kinds.length || kinds.includes(String(task.kind || '')))
  for (const task of tasks) {
    if (hasNonPendingTaskCopy(task.kind, task.id)) continue
    const pendingFile = getTaskFile('pending', task.kind, task.id)
    const claimingFile = getTaskFile('claiming', task.kind, task.id)
    if (!renameFileAtomic(pendingFile, claimingFile)) continue
    const next: ResourceTask = { ...task, status: 'claiming', claimedBy: workerName, claimedAt: nowIso(), updatedAt: nowIso() }
    writeJsonAtomic(claimingFile, next)
    writeWorkerEvent('task_claimed', { taskId: next.id, kind: next.kind, workerName })
    return next
  }
  return null
}

// 按 taskId claim 一个 pending 任务；用于过渡期 inline 执行器标记状态。
function claimTaskById(taskId: string, workerName: string): ResourceTask | null {
  ensureTaskDirs()
  const tasks = scanTasksByStatus('pending', 20000)
  const task = tasks.find(item => item.id === taskId)
  if (!task) return null
  if (hasNonPendingTaskCopy(task.kind, task.id)) return null
  const pendingFile = getTaskFile('pending', task.kind, task.id)
  const claimingFile = getTaskFile('claiming', task.kind, task.id)
  if (!renameFileAtomic(pendingFile, claimingFile)) return null
  const next: ResourceTask = { ...task, status: 'claiming', claimedBy: workerName, claimedAt: nowIso(), updatedAt: nowIso() }
  writeJsonAtomic(claimingFile, next)
  writeWorkerEvent('task_claimed', { taskId: next.id, kind: next.kind, workerName })
  return next
}

// 找到任务当前所在文件，兼容 inline 过渡执行器的状态迁移。
function findCurrentTaskLocation(task: ResourceTask): { status: string; file: string } | null {
  for (const status of ['running', 'claiming', 'pending', 'deferred', 'failed', 'done']) {
    const file = getTaskFile(status, task.kind, task.id)
    if (fs.existsSync(file)) return { status, file }
  }
  return null
}

function hasNonPendingTaskCopy(kind: string, taskId: string): boolean {
  for (const status of ['claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']) {
    if (fs.existsSync(getTaskFile(status, kind, taskId))) return true
  }
  return false
}

function hasTaskCopyInStatuses(kind: string, taskId: string, statuses: string[]): boolean {
  for (const status of statuses) {
    if (fs.existsSync(getTaskFile(status, kind, taskId))) return true
  }
  return false
}

function hasHigherRankTaskCopy(task: ResourceTask): boolean {
  const currentStatus = String(task.status || '') as ResourceTaskStatus
  const currentIndex = RESOURCE_TASK_CANONICAL_STATUS_ORDER.indexOf(currentStatus)
  if (currentIndex <= 0) return false
  return hasTaskCopyInStatuses(
    task.kind,
    task.id,
    RESOURCE_TASK_CANONICAL_STATUS_ORDER.slice(0, currentIndex),
  )
}

function getCanonicalTaskCopyById(taskId: string, statuses?: ResourceTaskStatus[]): ResourceTask | null {
  const target = String(taskId || '')
  if (!target) return null
  const allowedStatuses = new Set<ResourceTaskStatus>(
    Array.isArray(statuses) && statuses.length
      ? statuses.map(String).filter(Boolean) as ResourceTaskStatus[]
      : RESOURCE_TASK_CANONICAL_STATUS_ORDER,
  )
  for (const status of RESOURCE_TASK_CANONICAL_STATUS_ORDER) {
    if (!allowedStatuses.has(status)) continue
    const task = scanTasksByStatus(status, 20000).find(item => String(item.id || '') === target)
    if (task) return task
  }
  return null
}

function getResourceTaskByIdForKind(taskId: string, kind: string, statuses?: ResourceTaskStatus[]): ResourceTask | null {
  const target = String(taskId || '')
  const targetKind = String(kind || '')
  if (!target || !targetKind) return null
  const allowedStatuses = new Set<ResourceTaskStatus>(
    Array.isArray(statuses) && statuses.length
      ? statuses.map(String).filter(Boolean) as ResourceTaskStatus[]
      : RESOURCE_TASK_CANONICAL_STATUS_ORDER,
  )
  for (const status of RESOURCE_TASK_CANONICAL_STATUS_ORDER) {
    if (!allowedStatuses.has(status)) continue
    const task = readTaskFile(getTaskFile(status, targetKind, target))
    if (task) return task
  }
  return null
}

function prepareTaskTransition(task: ResourceTask, targetStatus: ResourceTaskStatus): { file: string } | null {
  const targetFile = getTaskFile(targetStatus, task.kind, task.id)
  const knownFile = getTaskFile(task.status, task.kind, task.id)
  if (fs.existsSync(targetFile)) return null
  if (hasHigherRankTaskCopy(task)) return null
  if (task.status === targetStatus) return { file: targetFile }
  if (fs.existsSync(knownFile)) {
    if (!renameFileAtomic(knownFile, targetFile)) return null
    return { file: targetFile }
  }
  return null
}

// 按 taskId 读取任务；用于 Dashboard 轮询单个后台任务状态。
function getResourceTaskById(taskId: string): ResourceTask | null {
  ensureTaskDirs()
  return getCanonicalTaskCopyById(taskId)
}

// 将 claiming 任务移动为 running。
function markTaskRunning(task: ResourceTask, workerName: string, step = 'starting'): ResourceTask {
  const target = prepareTaskTransition(task, 'running')
  if (!target) return task
  const next: ResourceTask = { ...task, status: 'running', claimedBy: workerName, startedAt: task.startedAt || nowIso(), updatedAt: nowIso(), step }
  writeJsonAtomic(target.file, next)
  writeWorkerEvent('task_running', { taskId: next.id, kind: next.kind, workerName, step })
  return next
}

// 当任务未能从 claiming 进入 running 且当前仍是唯一 claiming 副本时，
// 保守地将其收为 failed，避免新任务永久沉底在 claiming。
function failIsolatedClaimingTask(task: ResourceTask, error: unknown, result: Record<string, unknown> = {}): ResourceTask {
  if (String(task?.status || '') !== 'claiming') return task
  const claimingFile = getTaskFile('claiming', task.kind, task.id)
  if (!fs.existsSync(claimingFile)) return task
  if (hasTaskCopyInStatuses(task.kind, task.id, ['pending', 'running', 'done', 'failed', 'cancelled', 'deferred'])) return task
  return failTask(task, error, result)
}

// 更新 running 任务步骤。
function updateTaskStep(taskId: string, kind: string, step: string): ResourceTask | null {
  const runningFile = getTaskFile('running', kind, taskId)
  const task = readTaskFile(runningFile)
  if (!task) return null
  const next: ResourceTask = { ...task, step, updatedAt: nowIso() }
  writeJsonAtomic(runningFile, next)
  writeWorkerEvent('task_step', { taskId, kind, step })
  return next
}

// 写入任务结果 JSON。
function writeTaskResult(taskId: string, result: Record<string, unknown>): string {
  const resultDir = getTaskResultDir(taskId)
  ensureDir(resultDir)
  const file = path.join(resultDir, 'result.json')
  const safeResult = redactRecord(result)
  // 通用凭据键脱敏会误伤tokenUsage；只有已校验日报诊断的数值白名单可绕过此规则。
  if (result.kind === 'daily_report' && result.analysisMeta && typeof result.analysisMeta === 'object'
    && (result.analysisMeta as { reportPolicyVersion?: unknown }).reportPolicyVersion === 2) safeResult.analysisMeta = sanitizeReportAnalysisDiagnostics(result.analysisMeta)
  writeJsonAtomic(file, { taskId, createdAt: nowIso(), ...safeResult })
  return file
}

// 按单任务读取有限大小的最新诊断，接口不接受任意路径，也不返回任务载荷与正文。
function readDailyReportAnalysis(taskId: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(taskId) || ['.', '..'].includes(taskId)) throw new Error('日报任务ID无效')
  const task = getResourceTaskByIdForKind(taskId, 'daily_report')
  if (!task) return { state: 'not_found', message: '任务不存在或不是日报任务' }
  const delivery = task.notify.dailyReportDelivery
  const notification: Record<string, unknown> = { status: ['pending', 'sent', 'failed', 'skipped'].includes(String(task.notify.status)) ? task.notify.status : 'unknown',
    error: sanitizeReportDiagnosticText(typeof task.notify.error === 'string' ? task.notify.error : '') }
  if (delivery?.version === 2) {
    if (!['image', 'text', 'failure'].includes(delivery.mode) || !['ready', 'sending', 'confirmed', 'unknown'].includes(delivery.state)
      || !Number.isSafeInteger(delivery.totalSegments) || delivery.totalSegments < 1 || !Number.isSafeInteger(delivery.confirmedSegments)
      || delivery.confirmedSegments < 0 || delivery.confirmedSegments > delivery.totalSegments
      || (delivery.pendingSegment !== null && (!Number.isSafeInteger(delivery.pendingSegment) || delivery.pendingSegment < 0 || delivery.pendingSegment >= delivery.totalSegments))) throw new Error('日报通知诊断进度无效')
    notification.delivery = { mode: delivery.mode, totalSegments: delivery.totalSegments, confirmedSegments: delivery.confirmedSegments, pendingSegment: delivery.pendingSegment, state: delivery.state }
  }
  const files = ['pending', 'claiming', 'running', 'deferred'].includes(task.status) ? ['analysis-progress.json', 'result.json'] : ['result.json', 'analysis-progress.json']
  for (const name of files) {
    const file = path.join(getTaskResultDir(task.id), name)
    if (!fs.existsSync(file)) continue
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('日报诊断文件超限或不可读取')
    const content: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('日报诊断文件结构无效')
    const meta = (content as { analysisMeta?: unknown }).analysisMeta
    if (meta && typeof meta === 'object' && (meta as { reportPolicyVersion?: unknown }).reportPolicyVersion === 2) return { state: 'available', taskStatus: task.status, analysis: sanitizeReportAnalysisDiagnostics(meta), notification }
  }
  const active = ['pending', 'claiming', 'running', 'deferred'].includes(task.status)
  // 新排队任务的窗口已知，但收录与覆盖尚未计算，不能用零计数代替未知。
  const reportPeriod = active && task.payload.reportPolicyVersion === 2 ? resolveReportPeriod(task.payload, task.createdAt) : undefined
  return { state: active ? 'not_started' : 'legacy_unknown', reportPeriod,
    message: ['pending', 'claiming', 'running', 'deferred'].includes(task.status) ? '尚未保存分析进度' : '旧版本未记录分析覆盖信息', notification }
}

// 将任务标记为 done。
function completeTask(task: ResourceTask, result: Record<string, unknown> = {}): ResourceTask {
  const next: ResourceTask = { ...task, status: 'done', finishedAt: nowIso(), updatedAt: nowIso(), step: 'done' }
  const target = prepareTaskTransition(task, 'done')
  if (!target) return task
  writeTaskResult(task.id, { kind: task.kind, ok: true, ...result })
  writeJsonAtomic(target.file, next)
  writeWorkerEvent('task_done', { taskId: next.id, kind: next.kind })
  triggerTaskCompletedCallbacks(next.id)
  return next
}

// 日报失败保留最近进度和管线结果；硬退出后仍可由主进程发送正确固定提示。
function buildDailyReportFailureResult(task: ResourceTask, error: unknown, result: Record<string, unknown>): Record<string, unknown> {
  if (task.kind !== 'daily_report') return result
  const resultDir = getTaskResultDir(task.id)
  const stored = readJsonFile<Record<string, unknown>>(path.join(resultDir, 'result.json'), null, 1024 * 1024) || {}
  const progress = readJsonFile<{ analysisMeta?: ReportAnalysisDiagnostics }>(path.join(resultDir, 'analysis-progress.json'), null, 1024 * 1024)
  const latest = error instanceof ReportAnalysisError ? error.diagnostics : progress?.analysisMeta || stored.analysisMeta as ReportAnalysisDiagnostics | undefined
  const diagnostics = latest?.reportPolicyVersion === 2 ? { ...latest } : createReportAnalysisDiagnostics({
    windowMessageCount: 0, selectedMessageCount: 0, sourceCompleteness: 'legacy_unknown',
  })
  // 监督器的确定终止原因和共享错误码可确认总超时；错误文字不参与分类。
  const timedOut = isReportTotalTimeoutError(error) || result.reason === 'task_timed_out' || diagnostics.failureKind === 'total_timeout'
  const kind = timedOut ? 'total_timeout' : 'generation_failed'
  const stage = timedOut ? 'runtime' : diagnostics.failureStage || 'worker'
  new ReportAnalysisError(redactSensitiveText(error instanceof Error ? error.message : String(error || '')), kind, stage, diagnostics)
  return { ...stored, ...result, ok: false, reportPolicyVersion: 2, analysisMeta: diagnostics,
    failureKind: kind, failureStage: stage, failureNotificationVersion: 2,
    reason: timedOut ? 'daily_report_total_timeout' : 'daily_report_generation_failed' }
}

// 将任务标记为 failed，日报诊断不会被外层一行错误覆盖。
function failTask(task: ResourceTask, error: unknown, result: Record<string, unknown> = {}): ResourceTask {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error || ''))
  const retryAfter = buildTaskRetryAfter(task)
  const next: ResourceTask = {
    ...task,
    status: 'failed',
    finishedAt: nowIso(),
    updatedAt: nowIso(),
    step: 'failed',
    error: message,
    retryAfter: retryAfter || undefined,
    notify: task.kind === 'daily_report' ? { ...task.notify, failureNotificationVersion: 2 } : task.notify,
  }
  const target = prepareTaskTransition(task, 'failed')
  if (!target) return task
  writeTaskResult(task.id, { kind: task.kind, ok: false, error: message, ...buildDailyReportFailureResult(task, error, result) })
  writeJsonAtomic(target.file, next)
  writeWorkerEvent('task_failed', { taskId: next.id, kind: next.kind, error: message, retryAfter: retryAfter || '' })
  if (next.kind === 'daily_report') triggerTaskCompletedCallbacks(next.id)
  return next
}

// 将任务标记为 deferred，供 S1 返回 defer 时保存长期状态。
function deferTask(task: ResourceTask, reason = 'deferred'): ResourceTask {
  const deferredFile = getTaskFile('deferred', task.kind, task.id)
  const safeReason = redactSensitiveText(reason)
  const next: ResourceTask = { ...task, status: 'deferred', updatedAt: nowIso(), step: 'deferred', error: safeReason }
  const target = prepareTaskTransition(task, 'deferred')
  if (!target) return task
  writeJsonAtomic(deferredFile, next)
  writeWorkerEvent('task_deferred', { taskId: next.id, kind: next.kind, reason: safeReason })
  return next
}

// 将 claiming/running/deferred 任务放回 S2 pending 队列。
function requeueTask(task: ResourceTask, reason = 'requeued'): ResourceTask {
  const pendingFile = getTaskFile('pending', task.kind, task.id)
  const safeReason = redactSensitiveText(reason)
  const next: ResourceTask = {
    ...task,
    status: 'pending',
    updatedAt: nowIso(),
    step: 'pending',
    requeueReason: safeReason,
    claimedBy: undefined,
    claimedAt: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    error: undefined,
    retryAfter: undefined,
  }
  const target = prepareTaskTransition(task, 'pending')
  if (!target) return task
  writeJsonAtomic(pendingFile, next)
  writeWorkerEvent('task_requeued', { taskId: next.id, kind: next.kind, reason: safeReason })
  return next
}

// 更新任务通知状态，供 result-notifier 标记发送或跳过结果。
// 幂等：若 notify.status 已是目标值则跳过，避免每轮 tick 重复写同一 taskId。
// 写回路径以传入 task 所在位置（task.status）为准，不走多副本猜测。
function updateTaskNotifyStatus(task: ResourceTask, status: string, error = ''): ResourceTask {
  // 优先写回扫描到的实体所在位置，不依赖 findCurrentTaskLocation 跨目录猜测
  const knownFile = getTaskFile(task.status, task.kind, task.id)
  const location = fs.existsSync(knownFile)
    ? { file: knownFile }
    : findCurrentTaskLocation(task)
  if (!location) return task
  const safeError = redactSensitiveText(error)
  const currentTask = readTaskFile(location.file) || task
  const currentNotifyStatus = String((currentTask.notify || {}).status || '')
  if (currentNotifyStatus === status && status !== 'failed') return currentTask
  if (['sent', 'skipped'].includes(currentNotifyStatus) && status !== currentNotifyStatus) return currentTask
  const next: ResourceTask = {
    ...currentTask,
    updatedAt: nowIso(),
    notify: {
      ...(currentTask.notify || {}),
      status,
      error: safeError,
      updatedAt: nowIso(),
    },
  }
  writeJsonAtomic(location.file, next)
  writeWorkerEvent('task_notify_updated', { taskId: next.id, kind: next.kind, status, error: safeError })
  return next
}

// 每段发送前后同步落盘，仅保存编号和状态；落盘失败时禁止继续发送。
function updateDailyReportDeliveryProgress(task: ResourceTask, progress: DailyReportDeliveryProgress): ResourceTask {
  if (task.kind !== 'daily_report' || !['done', 'failed'].includes(task.status)) throw new Error('日报通知任务状态无效')
  const file = getTaskFile(task.status, task.kind, task.id)
  const current = readTaskFile(file)
  if (!current || current.id !== task.id || current.kind !== task.kind || current.status !== task.status) throw new Error('日报通知任务记录不可读取')
  if (['sent', 'skipped'].includes(String(current.notify.status || ''))) return current
  if (progress.version !== 2 || !Number.isInteger(progress.totalSegments) || progress.totalSegments < 1
    || !Number.isInteger(progress.confirmedSegments) || progress.confirmedSegments < 0 || progress.confirmedSegments > progress.totalSegments
    || (progress.pendingSegment !== null && progress.pendingSegment !== progress.confirmedSegments)) throw new Error('日报通知分段进度无效')
  const next = { ...current, notify: { ...current.notify, dailyReportDelivery: { ...progress } } }
  writeJsonAtomic(file, next)
  return next
}

// 取消排队或暂缓任务，并返回已确认的失败原因供管理界面展示。
function cancelTaskWithResult(taskId: string, actor = 'system', reason = 'cancelled'): { ok: true } | { ok: false; code: string; message: string } {
  ensureTaskDirs()
  const task = getCanonicalTaskCopyById(taskId, ['deferred', 'pending'])
  if (!task) {
    const current = getCanonicalTaskCopyById(taskId)
    if (!current) return { ok: false, code: 'TASK_NOT_FOUND', message: '任务记录已不存在，请刷新任务列表。' }
    const labels: Record<string, string> = { claiming: '准备执行', running: '处理中', done: '已完成', failed: '失败', cancelled: '已取消' }
    return { ok: false, code: 'TASK_NOT_CANCELLABLE', message: `任务当前为“${labels[current.status] || current.status}”，只能取消排队中或暂缓处理的任务。请刷新任务列表。` }
  }
  // 同 ID 的终态或执行中记录不能被排队记录覆盖，明确报告冲突而不是隐藏失败。
  if (hasHigherRankTaskCopy(task) || fs.existsSync(getTaskFile('cancelled', task.kind, task.id))) {
    const guidance = task.kind === 'external_video_download' ? '视频服务启动时会归档这条冲突记录，请刷新任务列表。' : '请检查重复的任务记录后重试。'
    return { ok: false, code: 'TASK_ID_CONFLICT', message: `任务 ID 与已有记录重复，系统为保留历史记录拒绝取消。${guidance}` }
  }
  const target = prepareTaskTransition(task, 'cancelled')
  if (!target) return { ok: false, code: 'TASK_TRANSITION_FAILED', message: '任务文件未能更新，取消操作未完成。请刷新后重试；若仍失败，请检查服务器日志。' }
  const safeReason = redactSensitiveText(reason)
  const next: ResourceTask = { ...task, status: 'cancelled', updatedAt: nowIso(), finishedAt: nowIso(), error: safeReason }
  writeJsonAtomic(target.file, next)
  writeWorkerEvent('task_cancelled', { taskId, kind: task.kind, actor, reason: safeReason })
  return { ok: true }
}

// 保留内部调用方的布尔取消接口，实际状态迁移共用同一实现。
function cancelTask(taskId: string, actor = 'system', reason = 'cancelled'): boolean {
  return cancelTaskWithResult(taskId, actor, reason).ok
}

// 仅取消指定 kind 在给定非终态中的任务，供视频插件启动时丢弃本类旧任务且不影响其他 AI 任务。
function cancelResourceTasksByKind(kind: string, statuses: string[] = DEFAULT_ACTIVE_TASK_STATUSES, actor = 'system', reason = 'cancelled'): ResourceTask[] {
  ensureTaskDirs()
  const targetKind = String(kind || '')
  if (!targetKind) return []
  const allowedStatuses = normalizeTaskStatusList(statuses)
  const safeReason = redactSensitiveText(reason) || 'cancelled'
  const cancelled: ResourceTask[] = []
  for (const status of allowedStatuses) {
    const tasks = scanTasksByStatus(status, 20000, status === 'pending' ? { kinds: [targetKind] } : {})
      .filter(task => String(task.kind || '') === targetKind)
    for (const task of tasks) {
      const target = prepareTaskTransition(task, 'cancelled')
      if (!target) continue
      const next: ResourceTask = {
        ...task,
        status: 'cancelled',
        updatedAt: nowIso(),
        finishedAt: nowIso(),
        step: 'cancelled',
        error: safeReason,
      }
      writeJsonAtomic(target.file, next)
      writeWorkerEvent('task_cancelled', { taskId: next.id, kind: next.kind, actor, reason: safeReason })
      cancelled.push(next)
    }
  }
  return cancelled
}

// --- 历史任务冲突归档 --- //

// 将与其他状态同名的 pending 记录归档到独立取消 ID，保留原历史记录和任务内容。
function discardConflictingPendingTasks(kind: string, actor: string): ResourceTask[] {
  ensureTaskDirs()
  const discarded: ResourceTask[] = []
  for (const task of scanTasksByStatus('pending', 20000, { kinds: [kind] })) {
    if (task.kind !== kind || !hasNonPendingTaskCopy(task.kind, task.id)) continue
    const archivedId = createTaskId(task.kind, task.channelKey)
    const target = getTaskFile('cancelled', task.kind, archivedId)
    if (fs.existsSync(target) || !renameFileAtomic(getTaskFile('pending', task.kind, task.id), target)) continue
    // 原 ID 已由另一条历史记录占用，不能覆盖它或重新执行没有会话的旧请求。
    const archived: ResourceTask = {
      ...task, id: archivedId, status: 'cancelled', step: 'cancelled',
      updatedAt: nowIso(), finishedAt: nowIso(), error: 'task_id_conflict',
    }
    writeJsonAtomic(target, archived)
    writeWorkerEvent('task_id_conflict_discarded', { taskId: archivedId, previousTaskId: task.id, kind, actor, reason: 'task_id_conflict' })
    discarded.push(archived)
  }
  return discarded
}

// --- Worker 心跳 --- //

// 写入 worker 心跳。
function writeWorkerHeartbeat(workerName: string, state: Partial<ResourceWorkerState> = {}): ResourceWorkerState {
  ensureTaskDirs()
  const now = nowIso()
  const payload: ResourceWorkerState = {
    ...state,
    name: workerName,
    pid: process.pid,
    startedAt: String(state.startedAt || now),
    heartbeatAt: now,
    alive: true,
  }
  writeJsonAtomic(getWorkerStateFile(workerName), payload)
  return payload
}

// 读取全部 worker 心跳状态。
function listWorkerStates(): ResourceWorkerState[] {
  ensureTaskDirs()
  const files = listJsonFiles(WORKER_STATE_DIR, { maxFiles: 200 })
  const now = Date.now()
  const states: ResourceWorkerState[] = []
  for (const file of files) {
    const item = readJsonFile<ResourceWorkerState>(file, null)
    if (!item) continue
    const heartbeat = Date.parse(String(item.heartbeatAt || ''))
    const heartbeatLagMs = Number.isFinite(heartbeat) ? now - heartbeat : null
    states.push({ ...item, heartbeatLagMs, alive: heartbeatLagMs !== null && heartbeatLagMs < 10000 })
  }
  return states
}

interface DiscardInterruptedResourceTaskStateResult {
  cancelled: number
  workerStateFilesRemoved: number
  supervisorStateFilesRemoved: number
}

// Bot 启动时将已领取或正在执行的 S2 任务标为已取消，并清除旧 worker 状态。
function discardInterruptedResourceTaskState(reason = 'restart_discarded'): DiscardInterruptedResourceTaskStateResult {
  ensureTaskDirs()
  const safeReason = redactSensitiveText(reason) || 'restart_discarded'
  let cancelled = 0
  for (const status of ['claiming', 'running'] as ResourceTaskStatus[]) {
    for (const task of scanTasksByStatus(status, 20000)) {
      const target = prepareTaskTransition(task, 'cancelled')
      if (!target) continue
      const next: ResourceTask = {
        ...task,
        status: 'cancelled',
        finishedAt: nowIso(),
        updatedAt: nowIso(),
        step: 'cancelled',
        error: safeReason,
        retryAfter: undefined,
      }
      writeJsonAtomic(target.file, next)
      writeWorkerEvent('task_discarded_on_startup', { taskId: next.id, kind: next.kind, previousStatus: status, reason: safeReason })
      cancelled++
    }
  }

  const workerStateFilesRemoved = listJsonFiles(WORKER_STATE_DIR, { maxFiles: 20000 }).length
  const supervisorStateFilesRemoved = listJsonFiles(SUPERVISOR_DIR, { maxFiles: 20000 }).length
  if (workerStateFilesRemoved > 0) removePath(WORKER_STATE_DIR)
  if (supervisorStateFilesRemoved > 0) removePath(SUPERVISOR_DIR)
  ensureTaskDirs()
  if (cancelled || workerStateFilesRemoved || supervisorStateFilesRemoved) {
    writeWorkerEvent('startup_runtime_discarded', { cancelled, workerStateFilesRemoved, supervisorStateFilesRemoved, reason: safeReason })
  }
  return { cancelled, workerStateFilesRemoved, supervisorStateFilesRemoved }
}

// 清理任务系统状态，测试或管理员回收时使用。
function removeTaskFile(status: string, kind: string, taskId: string): boolean {
  return removePath(getTaskFile(status, kind, taskId))
}

interface CleanupFinishedTasksOptions {
  retentionDays?: number
  now?: number
  maxScan?: number
}

interface CleanupFinishedTasksResult {
  removed: number
  resultsRemoved: number
  orphanResultsRemoved: number
  scanned: number
}

// 终态任务的回收：done/failed/cancelled 超过保留期的任务文件 + 其 result 目录一并删除，
// 并清掉「任务文件早已不存在、只剩 result 目录」的孤儿。
// 安全边界：默认保留 3 天，远大于 notifier 通知窗口，绝不会删到尚未推送的任务。
function cleanupFinishedTasks(options: CleanupFinishedTasksOptions = {}): CleanupFinishedTasksResult {
  ensureTaskDirs()
  const retentionDays = Math.max(1, Number(options.retentionDays || process.env.RESOURCE_TASK_RETENTION_DAYS || 3))
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const maxScan = Math.max(1, Math.min(20000, Number(options.maxScan || 20000)))
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const result: CleanupFinishedTasksResult = { removed: 0, resultsRemoved: 0, orphanResultsRemoved: 0, scanned: 0 }
  const liveTaskIds = new Set<string>()

  // 先扫所有活跃 + 未到期终态任务，记录仍存活的 taskId（用于孤儿判定）。
  for (const status of ['pending', 'claiming', 'running', 'deferred', 'done', 'failed', 'cancelled']) {
    const files = listJsonFiles(getTaskStatusDir(status), { recursive: status === 'pending', maxFiles: maxScan })
    for (const file of files) {
      const task = readTaskFile(file)
      if (!task) continue
      result.scanned += 1
      const isTerminal = status === 'done' || status === 'failed' || status === 'cancelled'
      if (!isTerminal) {
        liveTaskIds.add(task.id)
        continue
      }
      const stamp = Date.parse(String(task.finishedAt || task.updatedAt || task.createdAt || ''))
      const age = Number.isFinite(stamp) ? stamp : now
      if (age >= cutoff) {
        liveTaskIds.add(task.id)
        continue
      }
      if (removePath(file)) {
        result.removed += 1
        if (removePath(getTaskResultDir(task.id))) result.resultsRemoved += 1
      } else {
        liveTaskIds.add(task.id)
      }
    }
  }

  // 清孤儿 result 目录：result 在、但任何状态都已无对应任务文件。
  let resultDirs: import('fs').Dirent[] = []
  try {
    resultDirs = fs.readdirSync(RESULTS_ROOT, { withFileTypes: true })
  } catch {
    resultDirs = []
  }
  for (const entry of resultDirs) {
    if (!entry.isDirectory()) continue
    const taskId = String(entry.name)
    if (liveTaskIds.has(taskId)) continue
    if (removePath(path.join(RESULTS_ROOT, taskId))) result.orphanResultsRemoved += 1
  }

  writeWorkerEvent('task_cleanup', {
    removed: result.removed,
    resultsRemoved: result.resultsRemoved,
    orphanResultsRemoved: result.orphanResultsRemoved,
    retentionDays,
  })
  return result
}

export = {
  ensureTaskDirs,
  writeWorkerEvent,
  createTaskId,
  submitResourceTask,
  discardConflictingPendingTasks,
  getResourceTaskById,
  getResourceTaskByIdForKind,
  findResourceTaskByKindAndChannel,
  listResourceTasks,
  listResourceTasksForDiagnostics,
  listActiveDailyReportTasks,
  listTerminalTasksForNotification,
  countResourceTasks,
  countResourceTasksByKind,
  getTaskQueueSummary,
  claimNextTask,
  claimTaskById,
  markTaskRunning,
  failIsolatedClaimingTask,
  updateTaskStep,
  writeTaskResult,
  readDailyReportAnalysis,
  completeTask,
  failTask,
  deferTask,
  requeueTask,
  updateTaskNotifyStatus,
  updateDailyReportDeliveryProgress,
  cancelTask,
  cancelTaskWithResult,
  cancelResourceTasksByKind,
  writeWorkerHeartbeat,
  listWorkerStates,
  discardInterruptedResourceTaskState,
  removeTaskFile,
  cleanupFinishedTasks,
  registerTaskCompletedCallback,
  unregisterTaskCompletedCallback,
  _test: {
    parseResourceTask,
  },
}
