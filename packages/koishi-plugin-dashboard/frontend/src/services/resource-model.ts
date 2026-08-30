import type { JsonRecord } from '../types'

export interface WorkerProgressDisplay {
  label: string
  level: 'ok' | 'warn' | 'danger' | 'off'
  title: string
}

export interface ResourceWorkerState {
  media: JsonRecord
  status: JsonRecord
  tasks: JsonRecord[]
}

const WORKER_ZOMBIE_STAGNATION_MS = 15 * 60 * 1000
const WORKER_HEARTBEAT_FRESH_MS = 10000
const DAILY_WORKER_KINDS = ['daily_report', 'daily_summary', 'emotion_render']
const AGENT_WORKER_KINDS = ['agent_task', 'dashboard_agent', 'agent_memory', 'agent_memory_compaction', 'conversation_summary', 'sensitive_cache_analysis']
const MEDIA_WORKER_KINDS = ['media_image_analysis', 'media_file_analysis', 'media_voice_transcription']

// Formats a truthy resource value for compact Chinese display.
export function boolText(value: unknown): string {
  return value ? '是' : '否'
}

// Compresses an unknown value into a bounded table cell.
export function display(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 120)
  return String(value)
}

// Formats one resource event and preserves partial process-tree termination semantics.
export function eventDetail(event: JsonRecord): string {
  if (String(event.event || '') === 'process_tree_terminated' && event.treeTerminationConfirmed === false) {
    return '根进程已终止，子进程树未确认'
  }
  return display(event.reason || event.error || event.createdAt)
}

// Converts an unknown numeric field into a finite display value.
export function numberValue(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

// Returns the length of an API list and zero for non-arrays.
export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

// Formats worker heartbeat lag.
export function lagLabel(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '无心跳'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}

// Formats a fractional coverage value as a percentage.
export function percentLabel(value: unknown): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '-'
  return `${Math.round(parsed * 1000) / 10}%`
}

// Formats a memory value in megabytes.
export function mbLabel(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${Math.round(parsed)} MB` : '-'
}

// Resolves used memory from either the current field or the legacy total-minus-available shape.
export function memoryUsedValue(point: JsonRecord): number {
  const direct = Number(point.memUsedMb)
  if (Number.isFinite(direct)) return Math.max(0, direct)
  const total = Number(point.memTotalMb)
  const available = Number(point.memAvailableMb)
  if (Number.isFinite(total) && Number.isFinite(available)) return Math.max(0, total - available)
  return Number.NaN
}

// Formats disk capacity with an automatic MB/GB unit.
export function sizeMbLabel(value: unknown): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '-'
  if (Math.abs(parsed) >= 1024) return `${Math.round((parsed / 1024) * 10) / 10} GB`
  return `${Math.round(parsed)} MB`
}

// Formats a millisecond interval for resource diagnostics.
export function formatInterval(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`
  if (ms < 3600000) return `${Math.round(ms / 6000) / 10}m`
  return `${Math.round(ms / 360000) / 10}h`
}

// Formats an ISO timestamp as elapsed time relative to now.
export function elapsedLabel(iso: unknown, now = Date.now()): string {
  const ts = Date.parse(String(iso || ''))
  if (!Number.isFinite(ts)) return '无认领'
  return `${formatInterval(now - ts)}前`
}

// Resolves the normalized worker kind from either kind or legacy name.
export function workerKind(worker: JsonRecord): string {
  const explicit = String(worker.kind || '').trim().toLowerCase()
  if (explicit) return explicit
  const name = String(worker.name || '').trim().toLowerCase()
  return name.endsWith('-worker') ? name.slice(0, -'-worker'.length) : name
}

// Resolves resource task kinds owned by one worker.
export function workerTaskKinds(worker: JsonRecord): string[] {
  const kind = workerKind(worker)
  if (kind === 'daily') return DAILY_WORKER_KINDS
  if (kind === 'agent') return AGENT_WORKER_KINDS
  if (kind === 'media') return MEDIA_WORKER_KINDS
  return []
}

// Counts pending work attributable to one worker.
export function workerBacklogCount(worker: JsonRecord, state: ResourceWorkerState): number {
  if (workerKind(worker) === 'media') {
    return numberValue(state.media.imagePending) + numberValue(state.media.filePending) + numberValue(state.media.voicePending)
  }
  const kinds = new Set(workerTaskKinds(worker))
  if (!kinds.size) return numberValue(state.status.queueLength)
  return state.tasks.filter(task => String(task.status || '') === 'pending' && kinds.has(String(task.kind || ''))).length
}

// Finds the running resource task claimed by one worker.
export function findRunningTaskForWorker(worker: JsonRecord, tasks: JsonRecord[]): JsonRecord | null {
  const currentTaskId = String(worker.currentTaskId || '').trim()
  if (!currentTaskId) return null
  return tasks.find(task => String(task.id || '') === currentTaskId && String(task.status || '') === 'running') || null
}

// Checks whether a claimed worker task remains inside its declared timeout.
export function isWorkerRunningWithinTimeout(worker: JsonRecord, tasks: JsonRecord[], now = Date.now()): boolean {
  const currentTaskId = String(worker.currentTaskId || '').trim()
  if (!currentTaskId) return false
  const task = findRunningTaskForWorker(worker, tasks)
  if (!task) return false
  const timeoutMs = Number(task.timeoutMs || 0)
  const startedAt = Date.parse(String(worker.currentTaskStartedAt || task.startedAt || ''))
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(startedAt)) return false
  return now - startedAt < timeoutMs
}

// Builds the worker progress metadata line.
export function workerProgressMeta(worker: JsonRecord, state: ResourceWorkerState, now = Date.now()): string {
  const loops = Number(worker.loopIterations)
  const loopLabel = Number.isFinite(loops) ? `loop ${loops}` : 'loop -'
  return `${loopLabel} · 认领 ${elapsedLabel(worker.lastClaimAttemptAt, now)} · backlog ${workerBacklogCount(worker, state)}`
}

// Classifies worker progress using heartbeat, claim progress, backlog and task timeout.
export function workerProgressStatus(worker: JsonRecord, state: ResourceWorkerState, now = Date.now()): WorkerProgressDisplay {
  if (!worker.alive) return { label: '离线', level: 'off', title: 'worker 心跳已失效或进程不可用' }
  if (worker.parked === true) return { label: '已停放', level: 'off', title: `worker 正按后台指令休眠 ${formatInterval(worker.parkSleepMs)}` }
  if (isWorkerRunningWithinTimeout(worker, state.tasks, now)) return { label: '运行中', level: 'ok', title: `当前任务 ${display(worker.currentTaskId)}` }

  const heartbeatLagMs = Number(worker.heartbeatLagMs)
  const progressAt = Date.parse(String(worker.lastClaimAttemptAt || worker.loopChangedAt || worker.heartbeatAt || ''))
  const progressLagMs = Number.isFinite(progressAt) ? now - progressAt : Number.MAX_SAFE_INTEGER
  const backlog = workerBacklogCount(worker, state)
  if (Number.isFinite(heartbeatLagMs) && heartbeatLagMs <= WORKER_HEARTBEAT_FRESH_MS && progressLagMs > WORKER_ZOMBIE_STAGNATION_MS && backlog > 0) {
    return { label: '疑似僵尸', level: 'danger', title: '心跳仍新鲜，但认领进度长时间未推进且仍有待处理任务' }
  }
  if (backlog > 0 && progressLagMs > WORKER_ZOMBIE_STAGNATION_MS) {
    return { label: '进度停滞', level: 'warn', title: '该 worker 有积压任务，但最近认领时间已超过观察窗口' }
  }
  return { label: '推进中', level: 'ok', title: 'worker 心跳和认领进度未显示异常' }
}

// Rounds an SVG coordinate to one decimal place.
export function round(value: number): number {
  return Math.round(value * 10) / 10
}

// Builds a stable coverage-row key.
export function coverageKey(item: JsonRecord): string {
  return `${display(item.date)}:${display(item.channelKey)}:${display(item.updatedAt)}`
}

// Builds a stable resource-event key.
export function eventKey(item: JsonRecord): string {
  return `${display(item.source)}:${display(item.event)}:${display(item.createdAt)}:${display(item.taskId)}`
}

// Reports whether a resource task can be cancelled from the dashboard.
export function canCancel(task: JsonRecord): boolean {
  return ['pending', 'deferred'].includes(String(task.status || ''))
}
