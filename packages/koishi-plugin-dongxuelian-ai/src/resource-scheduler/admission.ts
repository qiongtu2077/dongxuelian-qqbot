/**
 * MODULE: S1 资源准入决策。
 * 职责: 根据任务预算和资源快照输出 run/queue/downgrade/defer/reject/silent_drop。
 * 边界: 不写长期任务队列，不获取 S0 锁。
 */
const path = require('path') as typeof import('path')
const { appendJsonlEvent } = require('../resource-common/files') as typeof import('../resource-common/files')

type AdmissionDecisionType = 'run_now' | 'queue' | 'downgrade' | 'defer' | 'reject' | 'silent_drop'

type TaskBudgetInput = Record<string, unknown>

interface TaskBudget {
  taskId: string
  kind: string
  source: string
  channelKey: string
  userId: string
  exclusive: boolean
  priority: number
  minMemMb: number
  criticalMemMb: number
  degradable: boolean
  deferable: boolean
  fallbacks: string[]
  queueTimeoutMs: number
  runTimeoutMs: number
}

interface ResourceSnapshotLike {
  resourceState: string
  botMode: string
  memAvailableMb: number | null
  locked: boolean
  running: unknown | null
}

const { normalizeTaskBudget } = require('./task-budget') as { normalizeTaskBudget(input: TaskBudgetInput): TaskBudget }
const { SCHEDULER_ROOT, readResourceSnapshot } = require('./resource-snapshot') as { SCHEDULER_ROOT: string; readResourceSnapshot(): ResourceSnapshotLike }

interface RunningTaskLike {
  taskId?: unknown
}

interface AdmissionDecision {
  decision: AdmissionDecisionType
  reason: string
  resourceState: string
  botMode: string
  memAvailableMb: number | null
  fallback?: string
  budget: unknown
  snapshot: unknown
}

function isRunningTaskLike(value: unknown): value is RunningTaskLike {
  return !!value && typeof value === 'object'
}

// 返回当天 S1 准入事件日志路径。
function admissionEventFile(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(SCHEDULER_ROOT, `admissions-${stamp}.jsonl`)
}

// 判断某任务是否允许作为低成本状态查询绕过重任务限制。
function isStatusQuery(kind: string): boolean {
  return kind === 'status_query'
}

// 判断任务是否属于普通聊天入口。
function isNormalChat(kind: string): boolean {
  return kind === 'normal_chat'
}

// 判断任务是否属于媒体后台负载。
function isMediaTask(kind: string): boolean {
  return kind === 'media_image_analysis' || kind === 'media_file_analysis' || kind === 'media_voice_transcription'
}

// 判断任务是否需要 Chromium 或浏览器工具。
function isChromiumTask(kind: string): boolean {
  return kind === 'daily_report_render' || kind === 'browser_action'
}

// 判断当前任务是否低于自身最低内存预算，避免全局档位放宽后重任务越过预算运行。
function isBelowTaskMinMemory(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): boolean {
  if (isStatusQuery(kind) || isNormalChat(kind)) return false
  if (snapshot.memAvailableMb === null) return false
  return snapshot.memAvailableMb < budget.minMemMb
}

// 在非 red 档下按任务自身预算输出保守降级/延后决策。
function decideBelowTaskMinMemory(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): AdmissionDecision | null {
  if (!isBelowTaskMinMemory(kind, budget, snapshot)) return null
  if (kind === 'daily_report' || kind === 'daily_report_render') {
    const fallback = budget.fallbacks[0] || 'daily_report_text'
    return buildDecision('downgrade', 'available memory is below task min memory budget', budget, snapshot, fallback)
  }
  if (budget.deferable) return buildDecision('defer', 'available memory is below task min memory budget', budget, snapshot)
  return buildDecision('reject', 'available memory is below task min memory budget', budget, snapshot)
}

// 判断当前任务是否可按自身预算在 red 档继续运行。
function canRunInRedState(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): boolean {
  if (kind !== 'external_video_download') return false
  if (snapshot.memAvailableMb === null) return false
  return snapshot.memAvailableMb >= budget.minMemMb
}

// 构造准入结果。
function buildDecision(decision: AdmissionDecisionType, reason: string, budget: TaskBudget, snapshot: ResourceSnapshotLike, fallback = ''): AdmissionDecision {
  return {
    decision,
    reason,
    resourceState: snapshot.resourceState,
    botMode: snapshot.botMode,
    memAvailableMb: snapshot.memAvailableMb,
    fallback: fallback || undefined,
    budget,
    snapshot,
  }
}

// 按 S1 最终计划输出统一资源准入决策。
function decideAdmission(input: TaskBudgetInput, snapshot: ResourceSnapshotLike = readResourceSnapshot()): AdmissionDecision {
  const budget = normalizeTaskBudget(input)
  const kind = String(budget.kind || '')
  const currentLock = snapshot.running || null
  const lockedBySelf = !!(budget.taskId && isRunningTaskLike(currentLock) && currentLock.taskId === budget.taskId)

  if (isStatusQuery(kind)) return buildDecision('run_now', 'status query is always low cost', budget, snapshot)

  if (snapshot.botMode === 'maintenance') {
    if (isNormalChat(kind)) return buildDecision('silent_drop', 'maintenance mode silences normal chat', budget, snapshot)
    return buildDecision('reject', 'maintenance mode rejects heavy tasks', budget, snapshot)
  }

  if (snapshot.botMode === 'report_silent') {
    if (isNormalChat(kind)) return buildDecision('silent_drop', 'daily report is running', budget, snapshot)
    if (isMediaTask(kind)) return buildDecision('defer', 'media drain paused during daily report', budget, snapshot)
    if (kind === 'daily_report' || kind === 'daily_report_render') return buildDecision('queue', 'daily report already running', budget, snapshot)
    if (budget.exclusive) return buildDecision('queue', 'exclusive task waits for current report', budget, snapshot)
  }

  if (snapshot.resourceState === 'black') {
    if (isNormalChat(kind)) return buildDecision('silent_drop', 'resource state black silences chat', budget, snapshot)
    if (budget.deferable) return buildDecision('defer', 'resource state black defers heavy task', budget, snapshot)
    return buildDecision('reject', 'resource state black rejects heavy task', budget, snapshot)
  }

  if (snapshot.resourceState === 'red') {
    if (isNormalChat(kind)) return buildDecision('silent_drop', 'resource state red silences chat', budget, snapshot)
    if (canRunInRedState(kind, budget, snapshot)) {
      if (snapshot.locked && !lockedBySelf && budget.exclusive) return buildDecision('queue', 'exclusive slot is busy', budget, snapshot)
      return buildDecision('run_now', 'red state accepted by task min memory budget', budget, snapshot)
    }
    if (kind === 'daily_report' || kind === 'daily_report_render') {
      const fallback = budget.fallbacks[0] || 'daily_report_text'
      return buildDecision('downgrade', 'resource state red disables Chromium', budget, snapshot, fallback)
    }
    if (isChromiumTask(kind)) return buildDecision(budget.deferable ? 'defer' : 'reject', 'Chromium task blocked in red state', budget, snapshot)
    if (isMediaTask(kind)) return buildDecision('defer', 'media task deferred in red state', budget, snapshot)
    if (budget.exclusive) return buildDecision(budget.deferable ? 'defer' : 'reject', 'exclusive task deferred in red state', budget, snapshot)
  }

  if (snapshot.locked && !lockedBySelf && budget.exclusive) return buildDecision('queue', 'exclusive slot is busy', budget, snapshot)
  if (snapshot.locked && !lockedBySelf && isMediaTask(kind)) return buildDecision('defer', 'media waits for exclusive slot to clear', budget, snapshot)

  const belowMinDecision = decideBelowTaskMinMemory(kind, budget, snapshot)
  if (belowMinDecision) return belowMinDecision

  if (snapshot.resourceState === 'yellow' && isMediaTask(kind)) return buildDecision('defer', 'media is throttled in yellow state', budget, snapshot)
  return buildDecision('run_now', 'resource budget accepted', budget, snapshot)
}

// 记录准入事件；Dashboard 只展示事件，不反推业务原因。
function writeAdmissionEvent(decision: AdmissionDecision): void {
  const budget = decision.budget as TaskBudget
  appendJsonlEvent(admissionEventFile(), {
    event: 'admission_decided',
    taskId: budget.taskId,
    kind: budget.kind,
    source: budget.source,
    channelKey: budget.channelKey,
    userId: budget.userId,
    decision: decision.decision,
    resourceState: decision.resourceState,
    botMode: decision.botMode,
    memAvailableMb: decision.memAvailableMb,
    fallback: decision.fallback || '',
    reason: decision.reason,
  })
}

// 统一入口：读取快照、决策、写事件并返回结果。
function admitTask(input: TaskBudgetInput): AdmissionDecision {
  const snapshot = readResourceSnapshot()
  const decision = decideAdmission(input, snapshot)
  writeAdmissionEvent(decision)
  return decision
}

export = {
  admissionEventFile,
  decideAdmission,
  decideBelowTaskMinMemory,
  writeAdmissionEvent,
  admitTask,
}
