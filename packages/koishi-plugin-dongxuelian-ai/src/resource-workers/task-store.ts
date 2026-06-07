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
const {
  WORKERS_ROOT,
  TASKS_ROOT,
  RESULTS_ROOT,
  WORKER_STATE_DIR,
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
  notify?: Record<string, unknown>
}

interface ListTasksOptions {
  statuses?: string[]
  limit?: number
}

type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred'

interface ResourceTask extends Record<string, unknown> {
  id: string
  kind: string
  status: ResourceTaskStatus
  source: string
  channelKey: string
  userId: string
  priority: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  timeoutMs: number
  payload: Record<string, unknown>
  notify: Record<string, unknown>
  step?: string
  claimedBy?: string
  claimedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

interface ResourceWorkerState extends Record<string, unknown> {
  name: string
  pid: number
  startedAt: string
  heartbeatAt: string
  alive: boolean
  heartbeatLagMs?: number | null
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
  appendJsonlEvent(getWorkerEventFile(), { event, ...data })
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
    payload: input.payload || {},
    notify: input.notify || { target: 'none', status: 'pending' },
  }
  writeJsonAtomic(getTaskFile('pending', task.kind, task.id), task)
  writeWorkerEvent('task_created', { taskId: task.id, kind: task.kind, source: task.source, channelKey: task.channelKey, priority: task.priority })
  return task
}

// 从任意状态目录读取任务文件。
function readTaskFile(file: string): ResourceTask | null {
  const task = readJsonFile<ResourceTask>(file, null)
  if (!task || !task.id || !task.kind) return null
  return task
}

// 扫描指定状态的任务，pending 会递归扫描 kind 子目录。
function scanTasksByStatus(status: string, limit = 500): ResourceTask[] {
  const recursive = status === 'pending'
  const files = listJsonFiles(getTaskStatusDir(status), { recursive, maxFiles: limit })
  const tasks = files.map(readTaskFile).filter((task): task is ResourceTask => Boolean(task))
  tasks.sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  return tasks.slice(0, limit)
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

// 汇总任务队列状态，供 S7 总览读取。
function getTaskQueueSummary(): Record<string, unknown> {
  const statuses = ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
  const summary: Record<string, number> = {}
  for (const status of statuses) summary[status] = scanTasksByStatus(status, 20000).length
  return summary
}

// claim 一个 pending 任务；rename 成功才算抢到。
function claimNextTask(kind: string | string[], workerName: string): ResourceTask | null {
  ensureTaskDirs()
  const kinds = Array.isArray(kind) ? kind.map(String).filter(Boolean) : [String(kind || '')].filter(Boolean)
  const tasks = scanTasksByStatus('pending', 1000).filter(task => !kinds.length || kinds.includes(String(task.kind || '')))
  for (const task of tasks) {
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

// 按 taskId 读取任务；用于 Dashboard 轮询单个后台任务状态。
function getResourceTaskById(taskId: string): ResourceTask | null {
  ensureTaskDirs()
  const target = String(taskId || '')
  if (!target) return null
  for (const status of ['pending', 'claiming', 'running', 'done', 'failed', 'deferred', 'cancelled']) {
    const task = scanTasksByStatus(status, 20000).find(item => String(item.id || '') === target)
    if (task) return task
  }
  return null
}

// 将 claiming 任务移动为 running。
function markTaskRunning(task: ResourceTask, workerName: string, step = 'starting'): ResourceTask {
  const location = findCurrentTaskLocation(task)
  const runningFile = getTaskFile('running', task.kind, task.id)
  const next: ResourceTask = { ...task, status: 'running', claimedBy: workerName, startedAt: task.startedAt || nowIso(), updatedAt: nowIso(), step }
  if (location && location.status !== 'running') renameFileAtomic(location.file, runningFile)
  writeJsonAtomic(runningFile, next)
  writeWorkerEvent('task_running', { taskId: next.id, kind: next.kind, workerName, step })
  return next
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
  writeJsonAtomic(file, { taskId, createdAt: nowIso(), ...result })
  return file
}

// 将任务标记为 done。
function completeTask(task: ResourceTask, result: Record<string, unknown> = {}): ResourceTask {
  const location = findCurrentTaskLocation(task)
  const doneFile = getTaskFile('done', task.kind, task.id)
  writeTaskResult(task.id, { kind: task.kind, ok: true, ...result })
  const next: ResourceTask = { ...task, status: 'done', finishedAt: nowIso(), updatedAt: nowIso(), step: 'done' }
  if (location && location.status !== 'done') renameFileAtomic(location.file, doneFile)
  writeJsonAtomic(doneFile, next)
  writeWorkerEvent('task_done', { taskId: next.id, kind: next.kind })
  return next
}

// 将任务标记为 failed。
function failTask(task: ResourceTask, error: unknown, result: Record<string, unknown> = {}): ResourceTask {
  const location = findCurrentTaskLocation(task)
  const failedFile = getTaskFile('failed', task.kind, task.id)
  const message = error instanceof Error ? error.message : String(error || '')
  writeTaskResult(task.id, { kind: task.kind, ok: false, error: message, ...result })
  const next: ResourceTask = { ...task, status: 'failed', finishedAt: nowIso(), updatedAt: nowIso(), step: 'failed', error: message }
  if (location && location.status !== 'failed') renameFileAtomic(location.file, failedFile)
  writeJsonAtomic(failedFile, next)
  writeWorkerEvent('task_failed', { taskId: next.id, kind: next.kind, error: message })
  return next
}

// 将任务标记为 deferred，供 S1 返回 defer 时保存长期状态。
function deferTask(task: ResourceTask, reason = 'deferred'): ResourceTask {
  const location = findCurrentTaskLocation(task)
  const deferredFile = getTaskFile('deferred', task.kind, task.id)
  const next: ResourceTask = { ...task, status: 'deferred', updatedAt: nowIso(), step: 'deferred', error: reason }
  if (location && location.status !== 'deferred') renameFileAtomic(location.file, deferredFile)
  writeJsonAtomic(deferredFile, next)
  writeWorkerEvent('task_deferred', { taskId: next.id, kind: next.kind, reason })
  return next
}

// 将 claiming/running/deferred 任务放回 S2 pending 队列。
function requeueTask(task: ResourceTask, reason = 'requeued'): ResourceTask {
  const location = findCurrentTaskLocation(task)
  const pendingFile = getTaskFile('pending', task.kind, task.id)
  const next: ResourceTask = { ...task, status: 'pending', updatedAt: nowIso(), step: 'pending', requeueReason: reason }
  if (location && location.status !== 'pending') renameFileAtomic(location.file, pendingFile)
  writeJsonAtomic(pendingFile, next)
  writeWorkerEvent('task_requeued', { taskId: next.id, kind: next.kind, reason })
  return next
}

// 更新任务通知状态，供 result-notifier 标记发送或跳过结果。
function updateTaskNotifyStatus(task: ResourceTask, status: string, error = ''): ResourceTask {
  const location = findCurrentTaskLocation(task)
  if (!location) return task
  const next = {
    ...task,
    updatedAt: nowIso(),
    notify: {
      ...(task.notify || {}),
      status,
      error,
      updatedAt: nowIso(),
    },
  }
  writeJsonAtomic(location.file, next)
  writeWorkerEvent('task_notify_updated', { taskId: next.id, kind: next.kind, status, error })
  return next
}

// 取消 pending/deferred 任务。
function cancelTask(taskId: string, actor = 'system', reason = 'cancelled'): boolean {
  ensureTaskDirs()
  const candidates = [...scanTasksByStatus('pending', 20000), ...scanTasksByStatus('deferred', 20000)]
  const task = candidates.find(item => item.id === taskId)
  if (!task) return false
  const src = getTaskFile(task.status, task.kind, task.id)
  const dst = getTaskFile('cancelled', task.kind, task.id)
  const next = { ...task, status: 'cancelled', updatedAt: nowIso(), finishedAt: nowIso(), error: reason }
  renameFileAtomic(src, dst)
  writeJsonAtomic(dst, next)
  writeWorkerEvent('task_cancelled', { taskId, kind: task.kind, actor, reason })
  return true
}

// 写入 worker 心跳。
function writeWorkerHeartbeat(workerName: string, state: Record<string, unknown> = {}): ResourceWorkerState {
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

// 清理任务系统状态，测试或管理员回收时使用。
function removeTaskFile(status: string, kind: string, taskId: string): boolean {
  return removePath(getTaskFile(status, kind, taskId))
}

export = {
  ensureTaskDirs,
  writeWorkerEvent,
  createTaskId,
  submitResourceTask,
  getResourceTaskById,
  listResourceTasks,
  getTaskQueueSummary,
  claimNextTask,
  claimTaskById,
  markTaskRunning,
  updateTaskStep,
  writeTaskResult,
  completeTask,
  failTask,
  deferTask,
  requeueTask,
  updateTaskNotifyStatus,
  cancelTask,
  writeWorkerHeartbeat,
  listWorkerStates,
  removeTaskFile,
}
