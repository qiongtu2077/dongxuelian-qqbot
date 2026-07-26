/**
 * MODULE: S1 资源准入决策。
 * 职责: 根据任务预算和资源快照输出 run/queue/downgrade/defer/reject/silent_drop。
 * 边界: 不写长期任务队列，不获取 S0 锁。
 */
const path = require('path') as typeof import('path')
const { appendJsonlEvent } = require('../resource-common/files') as typeof import('../resource-common/files')
const {
  isStatusQueryKind,
  isNormalChatKind,
  isMediaTaskKind,
  isChromiumTaskKind,
  isDailyReportKind,
  canRunInRedStateByKind,
} = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')

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

const ADMISSION_EVENT_AGGREGATE_WINDOW_MS = Math.max(1000, Math.min(60000, Number(process.env.RESOURCE_ADMISSION_EVENT_AGGREGATE_MS || process.env.RESOURCE_ADMISSION_EVENT_DEDUPE_MS || 10000)))

interface AdmissionEventAggregate {
  lastWrittenAt: number
  suppressedCount: number
}

const recentAdmissionEvents = new Map<string, AdmissionEventAggregate>()

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

// 判断 S0 running 元数据是否可安全读取任务 ID。
function isRunningTaskLike(value: unknown): value is RunningTaskLike {
  return !!value && typeof value === 'object'
}

// 返回当天 S1 准入事件日志路径。
function admissionEventFile(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10)
  return path.join(SCHEDULER_ROOT, `admissions-${stamp}.jsonl`)
}

// 判断当前任务是否低于自身最低内存预算，避免全局档位放宽后重任务越过预算运行。
function isBelowTaskMinMemory(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): boolean {
  if (isStatusQueryKind(kind) || isNormalChatKind(kind)) return false
  if (snapshot.memAvailableMb === null) return false
  return snapshot.memAvailableMb < budget.minMemMb
}

// 在非 red 档下按任务自身预算输出保守降级/延后决策。
function decideBelowTaskMinMemory(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): AdmissionDecision | null {
  if (!isBelowTaskMinMemory(kind, budget, snapshot)) return null
  if (isDailyReportKind(kind)) {
    const fallback = budget.fallbacks[0] || 'daily_report_text'
    return buildDecision('downgrade', 'available memory is below task min memory budget', budget, snapshot, fallback)
  }
  if (budget.deferable) return buildDecision('defer', 'available memory is below task min memory budget', budget, snapshot)
  return buildDecision('reject', 'available memory is below task min memory budget', budget, snapshot)
}

// 判断当前任务是否可按自身预算在 red 档继续运行。
function canRunInRedState(kind: string, budget: TaskBudget, snapshot: ResourceSnapshotLike): boolean {
  if (!canRunInRedStateByKind(kind)) return false
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

// 使用稳定业务维度生成聚合键；禁止把每次变化的 taskId 带入键中。
function buildAdmissionEventKey(decision: AdmissionDecision): string {
  const budget = decision.budget as TaskBudget
  return [
    String(budget.kind || ''),
    String(decision.decision || ''),
    String(decision.reason || ''),
    String(decision.resourceState || ''),
  ].join('|')
}

// 合并聚合窗口内的同类准入事件；窗口结束后的下一条携带完整累计数量。
function takeAdmissionEventAggregateCount(decision: AdmissionDecision, now = Date.now()): number | null {
  const key = buildAdmissionEventKey(decision)
  const aggregate = recentAdmissionEvents.get(key)
  if (aggregate && now - aggregate.lastWrittenAt < ADMISSION_EVENT_AGGREGATE_WINDOW_MS) {
    aggregate.suppressedCount += 1
    return null
  }
  const aggregateCount = 1 + Number(aggregate?.suppressedCount || 0)
  recentAdmissionEvents.set(key, { lastWrittenAt: now, suppressedCount: 0 })
  for (const [entryKey, entry] of recentAdmissionEvents) {
    if (now - entry.lastWrittenAt > ADMISSION_EVENT_AGGREGATE_WINDOW_MS * 6) recentAdmissionEvents.delete(entryKey)
  }
  return aggregateCount
}

// 按 S1 最终计划输出统一资源准入决策。
function decideAdmission(input: TaskBudgetInput, snapshot: ResourceSnapshotLike = readResourceSnapshot()): AdmissionDecision {
  const budget = normalizeTaskBudget(input)
  const kind = String(budget.kind || '')
  const currentLock = snapshot.running || null
  const lockedBySelf = !!(budget.taskId && isRunningTaskLike(currentLock) && currentLock.taskId === budget.taskId)

  if (isStatusQueryKind(kind)) return buildDecision('run_now', 'status query is always low cost', budget, snapshot)

  if (snapshot.botMode === 'maintenance') {
    if (isNormalChatKind(kind)) return buildDecision('silent_drop', 'maintenance mode silences normal chat', budget, snapshot)
    return buildDecision('reject', 'maintenance mode rejects heavy tasks', budget, snapshot)
  }

  if (snapshot.botMode === 'report_silent') {
    if (isNormalChatKind(kind)) return buildDecision('silent_drop', 'daily report is running', budget, snapshot)
    if (isMediaTaskKind(kind)) return buildDecision('defer', 'media drain paused during daily report', budget, snapshot)
    if (isDailyReportKind(kind)) return buildDecision('queue', 'daily report already running', budget, snapshot)
    if (budget.exclusive) return buildDecision('queue', 'exclusive task waits for current report', budget, snapshot)
  }

  if (snapshot.resourceState === 'black') {
    if (isNormalChatKind(kind)) return buildDecision('silent_drop', 'resource state black silences chat', budget, snapshot)
    if (budget.deferable) return buildDecision('defer', 'resource state black defers heavy task', budget, snapshot)
    return buildDecision('reject', 'resource state black rejects heavy task', budget, snapshot)
  }

  if (snapshot.resourceState === 'red') {
    if (isNormalChatKind(kind)) return buildDecision('silent_drop', 'resource state red silences chat', budget, snapshot)
    if (canRunInRedState(kind, budget, snapshot)) {
      if (snapshot.locked && !lockedBySelf && budget.exclusive) return buildDecision('queue', 'exclusive slot is busy', budget, snapshot)
      return buildDecision('run_now', 'red state accepted by task min memory budget', budget, snapshot)
    }
    if (isDailyReportKind(kind)) {
      const fallback = budget.fallbacks[0] || 'daily_report_text'
      return buildDecision('downgrade', 'resource state red disables Chromium', budget, snapshot, fallback)
    }
    if (isChromiumTaskKind(kind)) return buildDecision(budget.deferable ? 'defer' : 'reject', 'Chromium task blocked in red state', budget, snapshot)
    if (isMediaTaskKind(kind)) return buildDecision('defer', 'media task deferred in red state', budget, snapshot)
    if (budget.exclusive) return buildDecision(budget.deferable ? 'defer' : 'reject', 'exclusive task deferred in red state', budget, snapshot)
  }

  if (snapshot.locked && !lockedBySelf && budget.exclusive) return buildDecision('queue', 'exclusive slot is busy', budget, snapshot)
  if (snapshot.locked && !lockedBySelf && isMediaTaskKind(kind)) return buildDecision('defer', 'media waits for exclusive slot to clear', budget, snapshot)

  const belowMinDecision = decideBelowTaskMinMemory(kind, budget, snapshot)
  if (belowMinDecision) return belowMinDecision

  return buildDecision('run_now', 'resource budget accepted', budget, snapshot)
}

// 记录准入事件；Dashboard 只展示事件，不反推业务原因。
function writeAdmissionEvent(decision: AdmissionDecision): void {
  const aggregateCount = takeAdmissionEventAggregateCount(decision)
  if (aggregateCount === null) return
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
    aggregateCount,
    aggregateWindowMs: ADMISSION_EVENT_AGGREGATE_WINDOW_MS,
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
