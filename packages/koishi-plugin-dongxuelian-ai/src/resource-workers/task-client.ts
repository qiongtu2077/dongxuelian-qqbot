/**
 * MODULE: S2 任务客户端。
 * 职责: 为 Koishi/Dashboard 提供统一的资源任务提交入口。
 * 边界: 不执行任务，不获取 S0 锁。
 */
const { admitTask } = require('../resource-scheduler/admission') as typeof import('../resource-scheduler/admission')
const { submitResourceTask, deferTask, failTask, createTaskId } = require('./task-store') as typeof import('./task-store')

interface ResourceTaskLike extends Record<string, unknown> {
  id: string
  kind: string
  status: string
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
}

interface AdmissionDecisionLike {
  decision: string
  reason?: string
}

type SkippedAdmissionDecision = {
  decision: 'run_now'
  reason: string
}

interface SubmitWorkerTaskInput {
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

interface SubmitWorkerTaskOptions {
  checkAdmission?: boolean
  exclusive?: boolean
}

interface SubmitWorkerTaskWithAdmissionResult {
  task: ResourceTaskLike
  admission: AdmissionDecisionLike | SkippedAdmissionDecision
  accepted: boolean
}

// 构造 S1 准入预算；具体默认阈值由 S1 normalizeTaskBudget 处理。
function buildAdmissionInput(taskId: string, input: SubmitWorkerTaskInput, options: SubmitWorkerTaskOptions = {}): Record<string, unknown> {
  return {
    taskId,
    kind: input.kind,
    source: input.source || 'task-client',
    channelKey: input.channelKey || '',
    userId: input.userId || '',
    priority: input.priority,
    exclusive: options.exclusive,
    queueTimeoutMs: input.timeoutMs,
    runTimeoutMs: input.timeoutMs,
  }
}

// 只提交 S2 pending 任务，适合入口已完成 S1 判断的调用方。
function submitWorkerTask(input: SubmitWorkerTaskInput): ResourceTaskLike {
  const taskId = input.id || createTaskId(input.kind, input.channelKey || '')
  return submitResourceTask({ ...input, id: taskId })
}

// 提交任务前顺便问 S1；非 run/queue 时仍落盘为 deferred/failed，方便 Dashboard 追踪。
function submitWorkerTaskWithAdmission(input: SubmitWorkerTaskInput, options: SubmitWorkerTaskOptions = {}): SubmitWorkerTaskWithAdmissionResult {
  const taskId = input.id || createTaskId(input.kind, input.channelKey || '')
  const skippedAdmission: SkippedAdmissionDecision = { decision: 'run_now', reason: 'admission skipped by caller' }
  const admission = options.checkAdmission === false
    ? skippedAdmission
    : admitTask(buildAdmissionInput(taskId, input, options))
  const task = submitResourceTask({ ...input, id: taskId })
  if (admission.decision === 'defer') {
    return { task: deferTask(task, String(admission.reason || 'resource defer')), admission, accepted: false }
  }
  if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
    return { task: failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision }), admission, accepted: false }
  }
  return { task, admission, accepted: true }
}

export = {
  submitWorkerTask,
  submitWorkerTaskWithAdmission,
  buildAdmissionInput,
}
