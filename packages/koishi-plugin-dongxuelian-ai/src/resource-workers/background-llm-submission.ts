/**
 * MODULE: 后台 LLM 任务提交器。
 * 职责: 为 Koishi 主进程提交对话摘要、敏感缓存分析任务。
 * 边界: 不调用模型，不执行后台 LLM，只写 S2 任务。
 */
const { submitWorkerTaskWithAdmission } = require('./task-client') as typeof import('./task-client')
const { countResourceTasksByKind } = require('./task-store') as typeof import('./task-store')
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive') as typeof import('../resource-scheduler/background-directive')
type ResourceTask = import('./task-types').ResourceTask

interface BackgroundSubmissionResult {
  accepted: boolean
  task?: ResourceTaskLike
  admission?: AdmissionDecisionLike
  taskId?: string
  status: string
  message: string
}

type ResourceTaskLike = Partial<Pick<ResourceTask, 'id' | 'kind' | 'channelKey' | 'userId' | 'payload'>>

interface AdmissionDecisionLike {
  decision?: string
  reason?: unknown
}

interface SubmissionResultLike {
  task?: ResourceTaskLike
  admission?: AdmissionDecisionLike
  accepted?: boolean
}

interface ConversationSummarySubmissionOptions {
  key: string
  source?: string
}

interface SensitiveAnalysisSubmissionOptions {
  channelKey: string
  source?: string
}

interface BackgroundSubmissionGateInput {
  kind: string
  source: string
  channelKey: string
  userId: string
  priority: number
  timeoutMs: number
}

// 返回后台 LLM 任务过期时间，避免 hidden pending 无限堆积。
function getBackgroundExpiryIso(ttlMs: number): string {
  return new Date(Date.now() + Math.max(1000, Number(ttlMs) || 1000)).toISOString()
}

// 统计同类活跃后台 LLM 任务，防止定时器重复提交刷爆队列。
function countActiveBackgroundTasks(kind: string, matcher: (task: ResourceTaskLike) => boolean, limit = 1): number {
  return countResourceTasksByKind({
    kind,
    statuses: ['pending', 'claiming', 'running', 'deferred'],
    limit: Math.max(1, Math.min(10, Number(limit || 1))),
  }, task => matcher(task))
}

// 将 task-client 返回值压成调用方可记录的轻量结果。
function normalizeBackgroundSubmission(result: SubmissionResultLike, kind: string): BackgroundSubmissionResult {
  const decision = String(result.admission?.decision || '')
  const accepted = !!result.accepted || decision === 'queue' || decision === 'defer'
  return {
    accepted,
    task: result.task,
    admission: result.admission,
    taskId: result.task?.id,
    status: accepted ? (decision || 'accepted') : 'rejected',
    message: `${kind} task ${accepted ? 'submitted' : 'rejected'}${result.task?.id ? `: ${result.task.id}` : ''}`,
  }
}

function getParkedBackgroundSubmission(input: BackgroundSubmissionGateInput): BackgroundSubmissionResult | null {
  const gate = decideBackgroundDirective({
    kind: input.kind,
    source: input.source,
    channelKey: input.channelKey,
    userId: input.userId,
    priority: input.priority,
    exclusive: true,
    timeoutMs: input.timeoutMs,
    queueTimeoutMs: input.timeoutMs,
    runTimeoutMs: input.timeoutMs,
  })
  if (gate.directive.action !== 'park') return null
  return {
    accepted: false,
    status: 'parked',
    message: `${input.kind} task parked: ${gate.directive.reason}`,
  }
}

// 提交对话摘要任务；主进程不再同步调用轻量模型。
function submitConversationSummaryTask(options: ConversationSummarySubmissionOptions): BackgroundSubmissionResult {
  const key = String(options.key || '')
  if (!key) return { accepted: false, status: 'invalid', message: 'conversation key is empty' }
  if (countActiveBackgroundTasks('conversation_summary', task => String(task.payload?.key || '') === key, 1) >= 1) {
    return { accepted: false, status: 'skipped', message: 'active conversation_summary task already exists' }
  }
  const channelKey = key.split('::')[0] || 'conversation'
  const userId = key.split('::')[1] || ''
  const parked = getParkedBackgroundSubmission({
    kind: RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
    source: String(options.source || 'conversation-summary'),
    channelKey,
    userId,
    priority: 98,
    timeoutMs: 120000,
  })
  if (parked) return parked
  const result = submitWorkerTaskWithAdmission({
    kind: RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
    source: String(options.source || 'conversation-summary'),
    channelKey,
    userId,
    priority: 98,
    timeoutMs: 120000,
    expiresAt: getBackgroundExpiryIso(60 * 60 * 1000),
    payload: { key },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: true, exclusive: true })
  return normalizeBackgroundSubmission(result, 'conversation_summary')
}

// 提交敏感缓存分析任务；worker 命中后写持久 alert 文件供主进程消费。
function submitSensitiveCacheAnalysisTask(options: SensitiveAnalysisSubmissionOptions): BackgroundSubmissionResult {
  const channelKey = String(options.channelKey || '')
  if (!channelKey) return { accepted: false, status: 'invalid', message: 'channelKey is empty' }
  if (countActiveBackgroundTasks('sensitive_cache_analysis', task => String(task.channelKey || task.payload?.channelKey || '') === channelKey, 1) >= 1) {
    return { accepted: false, status: 'skipped', message: 'active sensitive_cache_analysis task already exists' }
  }
  const parked = getParkedBackgroundSubmission({
    kind: RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
    source: String(options.source || 'sensitive-cache-analysis'),
    channelKey,
    userId: '',
    priority: 60,
    timeoutMs: 120000,
  })
  if (parked) return parked
  const result = submitWorkerTaskWithAdmission({
    kind: RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
    source: String(options.source || 'sensitive-cache-analysis'),
    channelKey,
    userId: '',
    priority: 60,
    timeoutMs: 120000,
    expiresAt: getBackgroundExpiryIso(2 * 60 * 60 * 1000),
    payload: { channelKey },
    notify: { target: 'none', status: 'pending' },
  }, { checkAdmission: true, exclusive: true })
  return normalizeBackgroundSubmission(result, 'sensitive_cache_analysis')
}

export = {
  submitConversationSummaryTask,
  submitSensitiveCacheAnalysisTask,
}
