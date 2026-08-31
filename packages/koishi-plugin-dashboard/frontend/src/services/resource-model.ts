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

export interface ReadableStatusDisplay {
  label: string
  detail: string
  level: 'ok' | 'info' | 'warn' | 'danger' | 'off'
}

export interface ReadableWorkerDisplay extends ReadableStatusDisplay {
  name: string
  backlogText: string
  lastContactText: string
  pauseReasons: string[]
}

export interface ReadableMediaQueueDisplay extends ReadableStatusDisplay {
  name: string
  queueTotal: number
  queueLimit: number
  readyCount: number
  deferredCount: number
  runningCount: number
}

const WORKER_ZOMBIE_STAGNATION_MS = 15 * 60 * 1000
const WORKER_HEARTBEAT_FRESH_MS = 10000
const DAILY_WORKER_KINDS = ['daily_report', 'daily_summary', 'emotion_render']
const AGENT_WORKER_KINDS = ['agent_task', 'dashboard_agent', 'agent_memory', 'agent_memory_compaction', 'conversation_summary', 'sensitive_cache_analysis']
const MEDIA_WORKER_KINDS = ['media_image_analysis', 'media_file_analysis', 'media_voice_transcription']

const BOT_MODE_DISPLAY: Record<string, ReadableStatusDisplay> = {
  normal: { label: '正常', detail: '可正常响应消息。', level: 'ok' },
  busy: { label: '正在忙碌', detail: '当前有独占任务正在运行。', level: 'info' },
  report_silent: { label: '日报生成中', detail: '正在生成日报，部分交互会暂时等待。', level: 'info' },
  critical: { label: '资源紧张', detail: '资源保护已生效，请等待资源恢复。', level: 'danger' },
  maintenance: { label: '维护中', detail: '智能回复和后台任务已暂停。', level: 'warn' },
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  maintenance: '维护模式',
  resource_critical: '资源不足',
  browser_active: '浏览器自动操作占用',
  daily_render_active: '日报图片生成占用',
}

const TASK_KIND_LABELS: Record<string, string> = {
  agent_task: '智能助手任务',
  dashboard_agent: '控制台智能助手任务',
  agent_memory: '智能助手记忆任务',
  agent_memory_compaction: '记忆整理任务',
  conversation_summary: '对话总结任务',
  sensitive_cache_analysis: '敏感内容缓存分析',
  daily_report: '日报任务',
  daily_summary: '日报预计算任务',
  emotion_render: '情绪图片生成任务',
  media_image_analysis: '图片分析任务',
  media_file_analysis: '文件分析任务',
  media_voice_transcription: '语音转写任务',
}

const WORKER_NAMES: Record<string, string> = {
  agent: '智能助手后台处理器',
  media: '媒体分析处理器',
  daily: '日报处理器',
}

const MEDIA_KIND_NAMES: Record<string, string> = {
  image: '图片',
  file: '文件',
  voice: '语音',
}

const MEDIA_RISK_DISPLAY: Record<string, ReadableStatusDisplay> = {
  idle: { label: '当前空闲', detail: '当前没有等待任务。', level: 'ok' },
  queued: { label: '正常排队', detail: '队列仍在安全范围内。', level: 'info' },
  near_limit: { label: '接近上限', detail: '队列已达到容量的 80%，请关注后续增长。', level: 'warn' },
  at_limit: { label: '已达上限', detail: '新任务可能触发队列保护并舍弃低优先级任务。', level: 'danger' },
}

// --- 资源中心可读状态 --- //

// Maps the backend bot mode code to a stable Chinese service conclusion.
export function botModeDisplay(value: unknown): ReadableStatusDisplay {
  return BOT_MODE_DISPLAY[String(value || '')] || { label: '状态未知', detail: '后端返回了未识别的服务状态。', level: 'off' }
}

// Maps resource availability and handles unavailable memory as a separate state.
export function resourceStateDisplay(value: unknown, memAvailableMb: unknown, memTotalMb: unknown): ReadableStatusDisplay {
  if (typeof memAvailableMb !== 'number' || !Number.isFinite(memAvailableMb)) {
    return { label: '资源数据暂不可用', detail: '请检查服务器运行环境和内存信息读取权限。', level: 'warn' }
  }
  const total = typeof memTotalMb === 'number' && Number.isFinite(memTotalMb) ? memTotalMb : null
  const memory = total === null
    ? `可用内存 ${Math.round(memAvailableMb)} MB。`
    : `可用内存 ${Math.round(memAvailableMb)} / ${Math.round(total)} MB（${Math.round((memAvailableMb / Math.max(1, total)) * 100)}%）。`
  if (value === 'green') return { label: '充足', detail: memory, level: 'ok' }
  if (value === 'red') return { label: '紧张', detail: memory, level: 'danger' }
  return { label: '注意', detail: memory, level: 'warn' }
}

// Maps the configured resource policy without presenting it as detected hardware.
export function serverModeDisplay(value: unknown): ReadableStatusDisplay {
  if (String(value || '') === 'small') {
    return { label: '小内存策略', detail: '避免浏览器自动操作与日报图片生成并行。', level: 'warn' }
  }
  return { label: '大内存策略', detail: '允许资源许可范围内的后台任务并行。', level: 'ok' }
}

// Translates every backend pause reason code while preserving simultaneous reasons.
export function pauseReasonLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => PAUSE_REASON_LABELS[String(item || '')] || '其他系统保护原因')
}

// Converts low-level activity leases into three human-readable protection facts.
export function activityLeaseDisplay(status: JsonRecord): { browser: string; render: string; background: string; reasons: string[] } {
  const reasons = pauseReasonLabels(status.backgroundPauseReasons)
  return {
    browser: status.tool_active ? '浏览器自动操作：正在使用' : '浏览器自动操作：空闲',
    render: status.render_active ? '日报图片生成：正在使用' : '日报图片生成：空闲',
    background: status.background_allowed === false
      ? `后台任务已暂停${reasons.length ? `：${reasons.join('、')}` : ''}`
      : '后台任务：允许执行',
    reasons,
  }
}

// Translates a stable task kind for first-screen and diagnostic summaries.
export function taskKindDisplay(value: unknown): string {
  return TASK_KIND_LABELS[String(value || '')] || '其他后台任务'
}

// Formats a worker heartbeat lag using the user-facing “最后联系” vocabulary.
export function lastContactDisplay(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '最后联系：未记录'
  if (ms < 1000) return '最后联系：刚刚'
  return `最后联系：${formatInterval(ms)}前`
}

// Formats a persisted timestamp for user-facing diagnostic and history text.
export function dateTimeDisplay(value: unknown, fallback = '未记录'): string {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : fallback
}

// Translates one backend worker health code without reproducing its decision tree.
export function workerDisplay(worker: JsonRecord): ReadableWorkerDisplay {
  const type = String(worker.workerType || workerKind(worker) || 'unknown')
  const name = WORKER_NAMES[type] || '后台处理器'
  const backlog = numberValue(worker.backlogTotal)
  const runningCount = Math.max(1, numberValue(worker.runningCount))
  const code = String(worker.workerHealthCode || '')
  const pauseReasons = pauseReasonLabels(worker.workerPauseReasons)
  const base = (() : ReadableStatusDisplay => {
    if (code === 'task_timeout') return { label: '任务运行超时', detail: '系统正在自动清理超时任务。', level: 'danger' }
    if (code === 'task_timeout_idle') return { label: '处理器空闲，上一个任务超时', detail: '系统正在自动清理超时任务。', level: 'danger' }
    if (code === 'running_unresponsive_backlog') return { label: `任务运行中，但处理器无响应；另有 ${backlog} 项任务等待处理`, detail: '需要检查处理器运行状态。', level: 'danger' }
    if (code === 'claiming_idle') return { label: '处理器空闲', detail: '任务尚未开始执行。', level: 'ok' }
    if (code === 'stopped_backlog') return { label: `处理器已停止，仍有 ${backlog} 项任务等待处理`, detail: '需要检查处理器运行状态。', level: 'danger' }
    if (code === 'stalled') return { label: '任务积压，处理器长时间未推进', detail: '处理器仍在线，但已超过进展观察窗口。', level: 'danger' }
    if (code === 'paused_auto_resume') return { label: '已暂停，将自动恢复', detail: pauseReasons.join('、') || '系统保护暂时阻止领取新任务。', level: 'off' }
    if (code === 'working') return { label: `正在处理 ${runningCount} 项任务`, detail: '处理器正在执行已领取任务。', level: 'info' }
    if (code === 'idle') return { label: '正常待命', detail: '处理器在线并可领取任务。', level: 'ok' }
    return { label: '已停止', detail: '当前没有运行中的处理器进程。', level: 'off' }
  })()
  return {
    ...base,
    name,
    backlogText: backlog > 0 ? `待处理任务：${backlog}` : '暂无待处理任务',
    lastContactText: lastContactDisplay(worker.heartbeatLagMs),
    pauseReasons,
  }
}

// Translates one media queue and exposes every count required by the readable panel.
export function mediaQueueDisplay(kind: string, queue: JsonRecord, riskCode: unknown): ReadableMediaQueueDisplay {
  const risk = MEDIA_RISK_DISPLAY[String(riskCode || '')] || MEDIA_RISK_DISPLAY.idle
  return {
    ...risk,
    name: MEDIA_KIND_NAMES[kind] || '其他媒体',
    queueTotal: numberValue(queue.queueTotal),
    queueLimit: numberValue(queue.queueLimit),
    readyCount: numberValue(queue.readyCount),
    deferredCount: numberValue(queue.deferredCount),
    runningCount: numberValue(queue.runningCount),
  }
}

// Builds the overall media conclusion from the backend-provided worst risk and tied kinds.
export function mediaSummaryDisplay(media: JsonRecord): ReadableStatusDisplay {
  const risk = MEDIA_RISK_DISPLAY[String(media.mediaRiskCode || '')] || MEDIA_RISK_DISPLAY.idle
  const kinds = Array.isArray(media.mediaRiskKinds)
    ? media.mediaRiskKinds.map(kind => MEDIA_KIND_NAMES[String(kind || '')] || '其他媒体')
    : []
  if (String(media.mediaRiskCode || '') === 'idle') {
    return { ...risk, detail: '当前没有等待的媒体分析任务。' }
  }
  return { ...risk, detail: `${kinds.join('、') || '媒体'}队列${risk.label}。` }
}

// Translates a media diagnostic finish-reason code.
export function mediaFinishReasonDisplay(value: unknown): string {
  if (value === 'queue_limit') return '因队列超限舍弃'
  if (value === 'processing_failed') return '处理失败'
  if (value === 'restart_interrupted') return '服务重启时中断'
  return '历史原因未知'
}

// --- 通用展示格式 --- //

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
