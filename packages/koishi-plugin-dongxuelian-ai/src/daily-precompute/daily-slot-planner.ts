/**
 * MODULE: S3 分片规划器。
 * 职责: 根据 index 和 coverage 生成未覆盖分片任务。
 * 边界: 不执行分片，不调用 AI。
 */
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client') as typeof import('../resource-workers/task-client')
const { getResourceTaskByIdForKind, requeueTask, countResourceTasks } = require('../resource-workers/task-store') as typeof import('../resource-workers/task-store')
const { sanitizeId } = require('../resource-common/files') as typeof import('../resource-common/files')
const { readPrecomputeIndex, writePrecomputeEvent } = require('./precompute-index') as typeof import('./precompute-index')
const { readDailySlots } = require('./daily-summary-merge') as typeof import('./daily-summary-merge')
const {
  decideTaskDirective,
  readResourceContext,
} = require('../resource-scheduler/resource-directive') as typeof import('../resource-scheduler/resource-directive')

interface PlanSlotOptions {
  slotSize?: number
  maxSlots?: number
  source?: string
}

interface PrecomputeRecordLike extends Record<string, unknown> {
  messageId?: string
  timestamp?: number
}

interface SlotPlanningResultLike {
  task?: unknown
  admission?: unknown
  accepted?: unknown
  restored?: unknown
}

interface ResourceTaskLike extends Record<string, unknown> {
  id?: string
  kind?: string
  status?: string
  retryAfter?: string
}

interface SlotTaskTrackingState {
  tracked: boolean
  restoredTask?: unknown
}

interface SlotRangeLike {
  start: number
  end: number
}

const DAILY_SLOT_TAIL_FILL_MIN_TOTAL_MESSAGES = Math.max(20, Number(process.env.DAILY_SLOT_TAIL_FILL_MIN_TOTAL_MESSAGES || 80))
const DAILY_SLOT_TAIL_FILL_MAX_UNCOVERED_MESSAGES = Math.max(1, Number(process.env.DAILY_SLOT_TAIL_FILL_MAX_UNCOVERED_MESSAGES || 10))
const DAILY_SLOT_TAIL_FILL_MIN_COVERAGE_RATE = Math.max(0.5, Math.min(0.999, Number(process.env.DAILY_SLOT_TAIL_FILL_MIN_COVERAGE_RATE || 0.95)))
const DAILY_SLOT_BACKLOG_STOP_MAX_PENDING = Math.max(1, Number(process.env.DAILY_SLOT_BACKLOG_STOP_MAX_PENDING || 8))
const recentPlannerStopStates = new Map<string, string>()

// 生成 slot id，使用索引范围和消息时间便于排障。
function buildSlotId(records: PrecomputeRecordLike[], start: number, end: number): string {
  const first = records[start]
  const last = records[end - 1]
  return `${start}-${end - 1}-${sanitizeId(first?.messageId || first?.timestamp || 'start')}-${sanitizeId(last?.messageId || last?.timestamp || 'end')}`.slice(0, 140)
}

// 从已有 slot 文件收集已覆盖 messageId，避免重复提交已经完成的分片。
function getCoveredMessageIds(date: string, channelKey: string): Set<string> {
  const covered = new Set<string>()
  for (const slot of readDailySlots(date, channelKey)) {
    for (const id of Array.isArray(slot.coveredMessageIds) ? slot.coveredMessageIds : []) covered.add(String(id))
  }
  return covered
}

function isRetryAfterActive(task: ResourceTaskLike | null): boolean {
  const retryAfterMs = Date.parse(String(task?.retryAfter || ''))
  return Number.isFinite(retryAfterMs) && retryAfterMs > Date.now()
}

function countUncoveredMessages(records: PrecomputeRecordLike[], coveredIds: Set<string>): number | null {
  let uncoveredMessages = 0
  for (const record of records) {
    const messageId = String(record?.messageId || '')
    if (!messageId) return null
    if (!coveredIds.has(messageId)) uncoveredMessages += 1
  }
  return uncoveredMessages
}

function countTrailingUncoveredMessages(records: PrecomputeRecordLike[], coveredIds: Set<string>): number {
  let trailingUncoveredMessages = 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const messageId = String(records[index]?.messageId || '')
    if (!messageId || coveredIds.has(messageId)) break
    trailingUncoveredMessages += 1
  }
  return trailingUncoveredMessages
}

function shouldStopTailFill(records: PrecomputeRecordLike[], coveredIds: Set<string>, slotSize: number): boolean {
  const totalMessages = records.length
  if (!Number.isFinite(totalMessages) || totalMessages < DAILY_SLOT_TAIL_FILL_MIN_TOTAL_MESSAGES) return false
  const uncoveredMessages = countUncoveredMessages(records, coveredIds)
  if (!Number.isFinite(uncoveredMessages) || uncoveredMessages === null) return false
  if (uncoveredMessages <= 0) return false
  const coveredMessages = totalMessages - uncoveredMessages
  const coverageRate = totalMessages > 0 ? coveredMessages / totalMessages : 0
  if (coverageRate < DAILY_SLOT_TAIL_FILL_MIN_COVERAGE_RATE) return false
  if (uncoveredMessages > Math.min(slotSize, DAILY_SLOT_TAIL_FILL_MAX_UNCOVERED_MESSAGES)) return false
  return countTrailingUncoveredMessages(records, coveredIds) === uncoveredMessages
}

function getActiveDailySummaryBacklog(): number {
  return countResourceTasks({
    kind: 'daily_summary',
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: 20000,
  })
}

function buildPlanningRanges(totalMessages: number, slotSize: number): SlotRangeLike[] {
  const ranges: SlotRangeLike[] = []
  for (let start = 0; start < totalMessages; start += slotSize) {
    ranges.push({
      start,
      end: Math.min(totalMessages, start + slotSize),
    })
  }
  return ranges
}

function buildPlannerStopStateKey(date: string, channelKey: string): string {
  return `${sanitizeId(date)}|${sanitizeId(channelKey)}`
}

function writePlannerStopEventOnce(date: string, channelKey: string, event: string, data: Record<string, unknown> = {}): void {
  const key = buildPlannerStopStateKey(date, channelKey)
  const signature = `${event}|${JSON.stringify(data)}`
  if (recentPlannerStopStates.get(key) === signature) return
  recentPlannerStopStates.set(key, signature)
  writePrecomputeEvent(event, { date, channelKey, ...data })
}

function clearPlannerStopEventState(date: string, channelKey: string): void {
  recentPlannerStopStates.delete(buildPlannerStopStateKey(date, channelKey))
}

function collectRestoredSlotTasks(
  records: PrecomputeRecordLike[],
  date: string,
  channelKey: string,
  slotSize: number,
  maxSlots: number,
): SlotPlanningResultLike[] {
  const restored: SlotPlanningResultLike[] = []
  for (const range of buildPlanningRanges(records.length, slotSize)) {
    if (restored.length >= maxSlots) break
    const slotId = buildSlotId(records, range.start, range.end)
    const taskId = `daily_slot-${sanitizeId(date)}-${sanitizeId(channelKey)}-${sanitizeId(slotId)}`
    const tracking = ensureSlotTaskReadyForPlanning(taskId)
    if (tracking.restoredTask) restored.push({ task: tracking.restoredTask, accepted: true, restored: true })
  }
  return restored
}

// 判断确定性 slot 任务是否已经在 S2 队列或历史中，不重复提交同一个 taskId。
// failed 任务在 retryAfter 冷却窗口内仍算 tracked；到期后恢复回 pending。
function ensureSlotTaskReadyForPlanning(taskId: string): SlotTaskTrackingState {
  const task = getResourceTaskByIdForKind(taskId, 'daily_summary')
  if (!task) return { tracked: false }
  const status = String(task.status || '')
  if (['pending', 'claiming', 'running', 'done', 'deferred'].includes(status)) return { tracked: true }
  if (status !== 'failed') return { tracked: false }
  if (isRetryAfterActive(task)) return { tracked: true }
  const restoredTask = requeueTask(task, 'daily_slot retryAfter elapsed')
  writePrecomputeEvent('daily_slot_retry_restored', {
    taskId: String(task.id || ''),
    kind: String(task.kind || ''),
    retryAfter: String(task.retryAfter || ''),
  })
  return { tracked: true, restoredTask }
}

// 规划指定日期频道的 slot 任务。
function planDailySlotTasks(date: string, channelKey: string, options: PlanSlotOptions = {}): SlotPlanningResultLike[] {
  // 止血：red/black/维护模式下后台预计算必须让路，连规划扫描都不做。
  // S3 是机会式增强，不具备默认运行权（见 S0-S8 资源架构重整计划 9.6 节）。
  const snapshot = readResourceContext()
  const resourceState = String(snapshot.resourceState || '')
  const planningGate = decideTaskDirective({
    kind: 'daily_summary',
    source: options.source || 'daily-slot-planner',
    channelKey,
    priority: 70,
    exclusive: false,
    timeoutMs: 120000,
    queueTimeoutMs: 120000,
    runTimeoutMs: 120000,
  }, snapshot)
  const planningAction = String(planningGate.directive.action || '')
  if (resourceState === 'red' || snapshot.maintenance || planningAction === 'defer' || planningAction === 'reject' || planningAction === 'silent_drop') {
    writePlannerStopEventOnce(''+date, ''+channelKey, 'daily_slot_planning_skipped', { resourceState, maintenance: !!snapshot.maintenance })
    return []
  }
  const activeBacklog = getActiveDailySummaryBacklog()
  if (activeBacklog >= DAILY_SLOT_BACKLOG_STOP_MAX_PENDING) {
    writePlannerStopEventOnce(date, channelKey, 'daily_slot_planning_backlog_stopped', {
      activeBacklog,
      backlogLimit: DAILY_SLOT_BACKLOG_STOP_MAX_PENDING,
    })
    return []
  }
  const records = readPrecomputeIndex(date, channelKey) as PrecomputeRecordLike[]
  const coveredIds = getCoveredMessageIds(date, channelKey)
  const slotSize = Math.max(20, Math.min(500, Number(options.slotSize || 120)))
  const maxSlots = Math.max(1, Math.min(100, Number(options.maxSlots || 12)))
  const restoredTasks = collectRestoredSlotTasks(records, date, channelKey, slotSize, maxSlots)
  if (restoredTasks.length) {
    clearPlannerStopEventState(date, channelKey)
    return restoredTasks
  }
  if (shouldStopTailFill(records, coveredIds, slotSize)) {
    writePlannerStopEventOnce(date, channelKey, 'daily_slot_planning_tail_stopped', {
      totalMessages: records.length,
      coveredMessages: coveredIds.size,
      uncoveredMessages: Math.max(0, records.length - coveredIds.size),
      slotSize,
    })
    return []
  }
  const tasks: SlotPlanningResultLike[] = []
  for (const range of buildPlanningRanges(records.length, slotSize)) {
    if (tasks.length >= maxSlots) break
    const start = range.start
    const end = range.end
    const slice = records.slice(start, end)
    if (!slice.length) continue
    const messageIds = slice.map(item => String(item.messageId || '')).filter(Boolean)
    if (messageIds.length && messageIds.every(id => coveredIds.has(id))) continue
    const slotId = buildSlotId(records, start, end)
    const taskId = `daily_slot-${sanitizeId(date)}-${sanitizeId(channelKey)}-${sanitizeId(slotId)}`
    const tracking = ensureSlotTaskReadyForPlanning(taskId)
    if (tracking.restoredTask) {
      tasks.push({ task: tracking.restoredTask, accepted: true, restored: true })
      continue
    }
    if (tracking.tracked) continue
    const submit = submitWorkerTaskWithAdmission({
      id: taskId,
      kind: 'daily_summary',
      source: options.source || 'daily-slot-planner',
      channelKey,
      priority: 70,
      timeoutMs: 120000,
      payload: {
        date,
        channelKey,
        slotId,
        start,
        end,
        messageIds,
      },
      notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: false })
    tasks.push(submit)
  }
  clearPlannerStopEventState(date, channelKey)
  writePrecomputeEvent('daily_slot_tasks_planned', { date, channelKey, totalMessages: records.length, tasks: tasks.length })
  return tasks
}

export = {
  planDailySlotTasks,
}
