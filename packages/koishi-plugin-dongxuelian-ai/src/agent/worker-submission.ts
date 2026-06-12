/**
 * MODULE: Agent S2 worker 任务提交。
 * 职责: 将可序列化 Agent payload 提交到 S2 长期队列，供 agent-worker 异步执行。
 * 边界: 不调用 engine.run/resumePending，不获取 S0 锁，不发送最终消息。
 */
const { submitWorkerTaskWithAdmission } = require('../resource-workers/task-client') as typeof import('../resource-workers/task-client')
const { countResourceTasksByKind } = require('../resource-workers/task-store') as typeof import('../resource-workers/task-store')

interface SubmitAgentWorkerTaskOptions {
  channel?: string
  channelKey: string
  userId: string
  source?: string
  taskKind?: string
  priority?: number
  timeoutMs?: number
  maxActivePerUser?: number
  notifyTarget?: 'qq-group' | 'dashboard' | 'none' | string
  acceptedMessageMode?: 'normal' | 'quiet'
  payload: Record<string, unknown>
}

interface AgentWorkerSubmissionResult {
  accepted: boolean
  task?: ResourceTaskLike
  admission?: AdmissionDecisionLike
  taskId?: string
  message: string
  status: number
}

interface ResourceTaskLike extends Record<string, unknown> {
  id?: string
}

interface AdmissionDecisionLike {
  decision?: string
  reason?: unknown
}

interface ResourceDirectiveLike {
  action?: string
  reason?: unknown
}

type AgentDirectiveAction = 'pass' | 'queue' | 'defer' | 'reject' | 'silent_drop' | 'downgrade' | string

const MIN_AGENT_TASK_TIMEOUT_MS = 5000
const MAX_AGENT_TASK_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_AGENT_TASK_TIMEOUT_MS = 600000
const DEFAULT_AGENT_ACTIVE_BACKLOG_MAX = Math.max(
  1,
  Math.min(
    200,
    Number(
      process.env.RESOURCE_AGENT_ACTIVE_BACKLOG_MAX
      || process.env.RESOURCE_DEFERRED_RESTORE_MAX_ACTIVE
      || process.env.DAILY_SLOT_BACKLOG_STOP_MAX_PENDING
      || 8
    ),
  ),
)
const AGENT_DEFERRED_EXPIRY_GRACE_MS = Math.max(
  30 * 1000,
  Math.min(5 * 60 * 1000, Number(process.env.RESOURCE_AGENT_DEFERRED_EXPIRY_GRACE_MS || 2 * 60 * 1000)),
)

function resolveAgentDirectiveAction(directive: ResourceDirectiveLike | null | undefined, admission: AdmissionDecisionLike | null | undefined): AgentDirectiveAction {
  const action = String(directive?.action || '')
  if (action) return action
  const decision = String(admission?.decision || '')
  if (decision === 'run_now') return 'pass'
  return decision || 'reject'
}

// 按 channel 决定 S2 任务类型。
function resolveAgentTaskKind(channel = '', taskKind = ''): string {
  if (taskKind) return String(taskKind)
  return channel === 'dashboard' ? 'dashboard_agent' : 'agent_task'
}

function resolveAgentTaskTimeoutMs(timeoutMs: unknown): number {
  const parsed = Number(timeoutMs)
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_TASK_TIMEOUT_MS
  return Math.max(MIN_AGENT_TASK_TIMEOUT_MS, Math.min(MAX_AGENT_TASK_TIMEOUT_MS, parsed))
}

function getAgentTaskExpiryIso(timeoutMs: number): string {
  const ttlMs = Math.max(MIN_AGENT_TASK_TIMEOUT_MS, timeoutMs + AGENT_DEFERRED_EXPIRY_GRACE_MS)
  return new Date(Date.now() + ttlMs).toISOString()
}

function resolveAgentActiveBacklogMax(): number {
  return DEFAULT_AGENT_ACTIVE_BACKLOG_MAX
}

// 统计同一用户已有的 pending/claiming/running Agent 任务，防止长期队列爆掉。
function countActiveAgentWorkerTasks(kind: string, channelKey: string, userId: string, limit = 1): number {
  return countResourceTasksByKind({
    kind,
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: Math.max(1, Math.min(10, Number(limit || 1))),
  }, task => String(task.channelKey || '') === String(channelKey || '') && String(task.userId || '') === String(userId || ''))
}

function countAgentWorkerTaskBacklog(kind: string, limit = DEFAULT_AGENT_ACTIVE_BACKLOG_MAX): number {
  return countResourceTasksByKind({
    kind,
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: Math.max(1, Math.min(200, Number(limit || DEFAULT_AGENT_ACTIVE_BACKLOG_MAX))),
  })
}

// 返回用户可见的准入拒绝/延期提示。
function formatAdmissionBlockedMessage(directive: ResourceDirectiveLike | null | undefined, admission: AdmissionDecisionLike | null | undefined, taskId = ''): string {
  const action = resolveAgentDirectiveAction(directive, admission)
  const reason = String(directive?.reason || admission?.reason || action || 'resource unavailable')
  if (action === 'defer') return `当前资源紧张，Agent 任务已记录为延期任务${taskId ? `：${taskId}` : ''}。`
  if (action === 'reject' || action === 'silent_drop' || action === 'downgrade') return `当前资源不足，Agent 暂时不能执行：${reason}`
  return `Agent 任务暂时不能进入队列：${reason}`
}

// 返回用户可见的提交成功提示。
function formatAcceptedMessage(
  task: ResourceTaskLike | null | undefined,
  directiveOrAdmission: ResourceDirectiveLike | AdmissionDecisionLike | null | undefined,
  admissionOrMode: AdmissionDecisionLike | 'normal' | 'quiet' | null | undefined,
  modeArg: 'normal' | 'quiet' = 'normal'
): string {
  const mode = admissionOrMode === 'quiet' || admissionOrMode === 'normal' ? admissionOrMode : modeArg
  const directive = admissionOrMode === 'quiet' || admissionOrMode === 'normal'
    ? null
    : directiveOrAdmission as ResourceDirectiveLike | null | undefined
  const admission = admissionOrMode === 'quiet' || admissionOrMode === 'normal'
    ? directiveOrAdmission as AdmissionDecisionLike | null | undefined
    : admissionOrMode
  const taskId = String(task?.id || '')
  const action = resolveAgentDirectiveAction(directive, admission)
  const prefix = action === 'queue' ? 'Agent 已加入资源队列' : 'Agent 已提交后台执行'
  if (mode === 'quiet') return `我先去后台查一下，拿到可靠结果再说。${taskId ? `任务 ID：${taskId}。` : ''}`
  return `${prefix}，任务 ID：${taskId}。完成后会自动发回结果。`
}

// 提交 Agent worker 任务：入口只落 S2 队列，真正执行交给 agent-worker。
function submitAgentWorkerTask(options: SubmitAgentWorkerTaskOptions): AgentWorkerSubmissionResult {
  const channel = String(options.channel || '')
  const kind = resolveAgentTaskKind(channel, options.taskKind || '')
  const channelKey = String(options.channelKey || '')
  const userId = String(options.userId || '')
  const notifyTarget = options.notifyTarget || (channel === 'dashboard' ? 'dashboard' : 'qq-group')
  const acceptedMessageMode = options.acceptedMessageMode === 'quiet' ? 'quiet' : 'normal'
  const maxActivePerUser = Math.max(1, Math.min(10, Number(options.maxActivePerUser || 1)))
  const timeoutMs = resolveAgentTaskTimeoutMs(options.timeoutMs)
  const activeCount = countActiveAgentWorkerTasks(kind, channelKey, userId, maxActivePerUser)
  if (activeCount >= maxActivePerUser) {
    return {
      accepted: false,
      status: 429,
      message: 'Agent 已有任务在处理或排队，请等当前任务结束后再试。',
    }
  }
  const maxBacklog = resolveAgentActiveBacklogMax()
  const activeBacklog = countAgentWorkerTaskBacklog(kind, maxBacklog)
  if (activeBacklog >= maxBacklog) {
    return {
      accepted: false,
      status: 429,
      message: '当前 Agent 后台队列已满，请稍后再试。',
    }
  }

  const result = submitWorkerTaskWithAdmission({
    kind,
    source: String(options.source || 'koishi-worker'),
    channelKey,
    userId,
    priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : (kind === 'dashboard_agent' ? 45 : 40),
    timeoutMs,
    expiresAt: getAgentTaskExpiryIso(timeoutMs),
    payload: {
      channel,
      taskKind: kind,
      ...(options.payload || {}),
    },
    notify: {
      target: notifyTarget,
      channelKey,
      status: 'pending',
    },
  }, { checkAdmission: true, exclusive: true })

  if (!result.accepted) {
    const action = resolveAgentDirectiveAction(result.directive, result.admission)
    return {
      accepted: action === 'pass' || action === 'queue',
      task: result.task,
      admission: result.admission,
      taskId: result.task?.id,
      status: action === 'defer' ? 202 : 503,
      message: formatAdmissionBlockedMessage(result.directive, result.admission, result.task?.id),
    }
  }

  const action = resolveAgentDirectiveAction(result.directive, result.admission)
  return {
    accepted: action === 'pass' || action === 'queue',
    task: result.task,
    admission: result.admission,
    taskId: result.task?.id,
    status: 202,
    message: formatAcceptedMessage(result.task, result.directive, result.admission, acceptedMessageMode),
  }
}

export = {
  submitAgentWorkerTask,
  countActiveAgentWorkerTasks,
  formatAcceptedMessage,
}
