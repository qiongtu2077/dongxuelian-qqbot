/**
 * MODULE: 外部视频 S2 持久队列。
 * 职责: 校验 task-store 接口、串行执行容量检查与落盘、按顺序领取视频任务并维护终态。
 * 边界: 不解析消息、不下载媒体、不保存 Koishi session、Cookie、正文或临时文件路径。
 */
const path = require('path') as typeof import('path')

type ResourceTask = import('../../koishi-plugin-dongxuelian-ai/lib/resource-workers/task-types').ResourceTask

interface VideoTaskStore {
  submitResourceTask(input: Record<string, unknown>): ResourceTask
  getResourceTaskById(taskId: string): ResourceTask | null
  countResourceTasksByKind(options: { kind: string, statuses?: string[], limit?: number }): number
  claimNextTask(kind: string, workerName: string): ResourceTask | null
  markTaskRunning(task: ResourceTask, workerName: string, step?: string): ResourceTask
  completeTask(task: ResourceTask, result?: Record<string, unknown>): ResourceTask
  failTask(task: ResourceTask, error: unknown, result?: Record<string, unknown>): ResourceTask
  requeueTask(task: ResourceTask, reason?: string): ResourceTask
  cancelResourceTasksByKind(kind: string, statuses?: string[], actor?: string, reason?: string): ResourceTask[]
}

interface VideoTaskPayload {
  p1Url: string
  bvId: string
  inputType: string
  targetType: 'group' | 'private'
  targetId: string
  requestedAt: string
  retryCount: number
  traceId: string
}

interface EnqueueVideoTaskInput extends VideoTaskPayload {
  taskId: string
  channelKey: string
  userId: string
}

type EnqueueVideoTaskResult =
  | { status: 'queued', task: ResourceTask, waiting: number, capacity: number }
  | { status: 'full', waiting: number, capacity: number }
  | { status: 'unavailable', reason: string }
  | { status: 'persist_failed', taskId: string }

type VideoTaskExecutionResult =
  | { status: 'done', result?: Record<string, unknown> }
  | { status: 'retry', reason: string }
  | { status: 'failed', reason: string, result?: Record<string, unknown>, notify?: boolean }

interface CreateVideoTaskQueueOptions {
  store?: VideoTaskStore | null
  execute(task: ResourceTask): Promise<VideoTaskExecutionResult>
  onTerminalFailure?(task: ResourceTask, reason: string): Promise<void>
  onTerminal?(task: ResourceTask, status: 'done' | 'failed' | 'cancelled', reason: string): void
  now?: () => number
  schedule?: (handler: () => void, delayMs: number) => NodeJS.Timeout
}

interface VideoTaskQueueController {
  initialize(): { available: boolean, cancelled: number, reason: string }
  enqueue(input: EnqueueVideoTaskInput): Promise<EnqueueVideoTaskResult>
  kick(): void
  dispose(): void
  status(): Record<string, unknown>
}

const EXTERNAL_VIDEO_TASK_KIND = 'external_video_download'
const VIDEO_QUEUE_CAPACITY = 10
const VIDEO_TASK_TTL_MS = 15 * 60 * 1000
const VIDEO_TASK_TIMEOUT_MS = 15 * 60 * 1000
const VIDEO_QUEUE_RETRY_MS = 1000
const VIDEO_QUEUE_WORKER_NAME = 'local-video-sender-main'
const ACTIVE_VIDEO_TASK_STATUSES = ['pending', 'deferred', 'claiming', 'running']
const WAITING_VIDEO_TASK_STATUSES = ['pending', 'deferred']
const ALL_VIDEO_TASK_STATUSES = ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
const REQUIRED_STORE_METHODS: Array<keyof VideoTaskStore> = [
  'submitResourceTask',
  'getResourceTaskById',
  'countResourceTasksByKind',
  'claimNextTask',
  'markTaskRunning',
  'completeTask',
  'failTask',
  'requeueTask',
  'cancelResourceTasksByKind',
]

// 计算 sibling AI 插件的运行产物路径，避免编译期加载其业务入口。
function getAiTaskStorePath(): string {
  return path.join(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', 'resource-workers', 'task-store')
}

// 验证 S2 提交、查询、领取和终态接口是否完整，缺一项即判定队列不可用。
function validateVideoTaskStore(candidate: unknown): candidate is VideoTaskStore {
  if (!candidate || typeof candidate !== 'object') return false
  return REQUIRED_STORE_METHODS.every(name => typeof (candidate as Record<string, unknown>)[name] === 'function')
}

// 运行时加载 S2 task-store；加载或接口校验失败时返回 null。
function loadVideoTaskStore(): VideoTaskStore | null {
  try {
    const candidate: unknown = require(getAiTaskStorePath())
    return validateVideoTaskStore(candidate) ? candidate : null
  } catch {
    return null
  }
}

// 从任务 payload 中只保留计划允许持久化的字段。
function buildSafeVideoTaskPayload(input: EnqueueVideoTaskInput): VideoTaskPayload {
  return {
    p1Url: String(input.p1Url || ''),
    bvId: String(input.bvId || ''),
    inputType: String(input.inputType || 'unknown'),
    targetType: input.targetType === 'private' ? 'private' : 'group',
    targetId: String(input.targetId || ''),
    requestedAt: String(input.requestedAt || ''),
    retryCount: Math.max(0, Math.floor(Number(input.retryCount || 0))),
    traceId: String(input.traceId || ''),
  }
}

// 判断持久任务是否已经超过固定 15 分钟有效期。
function isVideoTaskExpired(task: ResourceTask, now: number): boolean {
  const expiresAt = Date.parse(String(task.expiresAt || ''))
  return Number.isFinite(expiresAt) && now >= expiresAt
}

// 创建单执行者视频队列控制器，所有容量检查与写入共享同一串行临界区。
function createVideoTaskQueue(options: CreateVideoTaskQueueOptions): VideoTaskQueueController {
  const store = options.store === undefined ? loadVideoTaskStore() : options.store
  const now = options.now || Date.now
  const schedule = options.schedule || ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs))
  let available = validateVideoTaskStore(store)
  let unavailableReason = available ? '' : 'required_task_store_interfaces_missing'
  let disposed = false
  let running = false
  let retryTimer: NodeJS.Timeout | null = null
  let criticalTail: Promise<void> = Promise.resolve()

  // 串行执行等待数检查和任务写入，避免并发提交突破 10 个等待位。
  async function runCritical<T>(action: () => Promise<T> | T): Promise<T> {
    let release!: () => void
    const previous = criticalTail
    criticalTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }

  // 延时再次领取任务；同一时刻只保留一个重试定时器。
  function scheduleRetry(): void {
    if (disposed || retryTimer) return
    retryTimer = schedule(() => {
      retryTimer = null
      void runNext()
    }, VIDEO_QUEUE_RETRY_MS)
    retryTimer.unref?.()
  }

  // 将一个已领取任务标记失败，并尝试发送一次最终中文通知。
  async function finishFailedTask(task: ResourceTask, reason: string, result: Record<string, unknown> = {}, notify: boolean = true): Promise<void> {
    if (!store) return
    const failed = store.failTask(task, reason, result)
    options.onTerminal?.(failed, 'failed', reason)
    if (notify && options.onTerminalFailure) await options.onTerminalFailure(failed, reason)
  }

  // 领取并执行队首视频任务；资源仍忙时回到 pending，始终只运行一个执行者。
  async function runNext(): Promise<void> {
    if (!available || !store || disposed || running) return
    running = true
    try {
      const claimed = store.claimNextTask(EXTERNAL_VIDEO_TASK_KIND, VIDEO_QUEUE_WORKER_NAME)
      if (!claimed) return
      const task = store.markTaskRunning(claimed, VIDEO_QUEUE_WORKER_NAME, 'video_prepare')
      if (String(task.status) !== 'running') {
        await finishFailedTask(claimed, 'task_state_transition_failed')
        return
      }
      if (isVideoTaskExpired(task, now())) {
        await finishFailedTask(task, 'video_task_expired')
        return
      }
      let outcome: VideoTaskExecutionResult
      try {
        outcome = await options.execute(task)
      } catch (error) {
        outcome = { status: 'failed', reason: error instanceof Error ? error.message : String(error || 'video_task_execution_failed') }
      }
      if (outcome.status === 'done') {
        const completed = store.completeTask(task, outcome.result || {})
        options.onTerminal?.(completed, 'done', '')
      } else if (outcome.status === 'retry') {
        if (isVideoTaskExpired(task, now())) {
          await finishFailedTask(task, 'video_task_expired')
        } else {
          store.requeueTask(task, outcome.reason)
          scheduleRetry()
        }
      } else {
        await finishFailedTask(task, outcome.reason, outcome.result || {}, outcome.notify !== false)
      }
    } finally {
      running = false
      if (!disposed && available && store.countResourceTasksByKind({ kind: EXTERNAL_VIDEO_TASK_KIND, statuses: ['pending'], limit: 1 }) > 0) scheduleRetry()
    }
  }

  return {
    // 启动时只取消旧视频任务，其他 AI 任务保持原状态。
    initialize() {
      if (!available || !store) return { available: false, cancelled: 0, reason: unavailableReason }
      try {
        const cancelled = store.cancelResourceTasksByKind(EXTERNAL_VIDEO_TASK_KIND, ACTIVE_VIDEO_TASK_STATUSES, VIDEO_QUEUE_WORKER_NAME, 'restart_discarded')
        for (const task of cancelled) options.onTerminal?.(task, 'cancelled', 'restart_discarded')
        return { available: true, cancelled: cancelled.length, reason: '' }
      } catch (error) {
        available = false
        unavailableReason = error instanceof Error ? error.message : String(error || 'queue_startup_failed')
        return { available: false, cancelled: 0, reason: unavailableReason }
      }
    },

    // 在串行临界区内检查全局等待容量、持久化任务并按全状态确认真实存在。
    enqueue(input: EnqueueVideoTaskInput): Promise<EnqueueVideoTaskResult> {
      return runCritical(() => {
        if (!available || !store) return { status: 'unavailable', reason: unavailableReason || 'task_store_unavailable' }
        const waiting = store.countResourceTasksByKind({ kind: EXTERNAL_VIDEO_TASK_KIND, statuses: WAITING_VIDEO_TASK_STATUSES, limit: VIDEO_QUEUE_CAPACITY + 1 })
        if (waiting >= VIDEO_QUEUE_CAPACITY) return { status: 'full', waiting, capacity: VIDEO_QUEUE_CAPACITY }
        const expiresAt = new Date(now() + VIDEO_TASK_TTL_MS).toISOString()
        let task: ResourceTask | null = null
        try {
          task = store.submitResourceTask({
            id: input.taskId,
            kind: EXTERNAL_VIDEO_TASK_KIND,
            source: 'local-video-sender',
            channelKey: String(input.channelKey || ''),
            userId: String(input.userId || ''),
            priority: 75,
            expiresAt,
            timeoutMs: VIDEO_TASK_TIMEOUT_MS,
            payload: buildSafeVideoTaskPayload(input),
            notify: { target: input.targetType === 'private' ? 'qq-private' : 'qq-group', channelKey: String(input.targetId || ''), status: 'pending' },
          })
        } catch {
          task = store.getResourceTaskById(input.taskId)
          if (!task) return { status: 'persist_failed', taskId: input.taskId }
        }
        const confirmed = store.getResourceTaskById(input.taskId) || task
        if (!confirmed || !ALL_VIDEO_TASK_STATUSES.includes(String(confirmed.status))) return { status: 'persist_failed', taskId: input.taskId }
        const waitingAfter = store.countResourceTasksByKind({ kind: EXTERNAL_VIDEO_TASK_KIND, statuses: WAITING_VIDEO_TASK_STATUSES, limit: VIDEO_QUEUE_CAPACITY })
        return { status: 'queued', task: confirmed, waiting: Math.max(1, waitingAfter), capacity: VIDEO_QUEUE_CAPACITY }
      })
    },

    // 唤醒主进程内唯一执行者，不创建视频子进程。
    kick(): void {
      if (!disposed) void runNext()
    },

    // 停止后续领取和重试定时器；当前执行中的函数自行完成 finally。
    dispose(): void {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    },

    // 返回无任务正文的队列运行摘要，供测试和诊断使用。
    status(): Record<string, unknown> {
      const waiting = available && store
        ? store.countResourceTasksByKind({ kind: EXTERNAL_VIDEO_TASK_KIND, statuses: WAITING_VIDEO_TASK_STATUSES, limit: VIDEO_QUEUE_CAPACITY + 1 })
        : 0
      return { available, reason: unavailableReason, waiting, capacity: VIDEO_QUEUE_CAPACITY, running, disposed }
    },
  }
}

export = {
  EXTERNAL_VIDEO_TASK_KIND,
  VIDEO_QUEUE_CAPACITY,
  ACTIVE_VIDEO_TASK_STATUSES,
  WAITING_VIDEO_TASK_STATUSES,
  validateVideoTaskStore,
  loadVideoTaskStore,
  createVideoTaskQueue,
}
