/**
 * MODULE: S2 worker 主入口。
 * 职责: 提供独立 worker 循环、S1 准入、S0 独占锁和任务状态迁移。
 * 边界: 不注册 Koishi middleware，不直接处理用户消息入口。
 */
const { admitTask } = require('../resource-scheduler/admission') as typeof import('../resource-scheduler/admission')
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')
const { acquireResourceGate } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const {
  collectProcessMetrics,
  checkWorkerMemoryLimit,
  writeProcessCleanupEvent,
  terminateRecordedProcessPids,
} = require('../resource-system/system-protection') as typeof import('../resource-system/system-protection')
const {
  claimNextTask,
  markTaskRunning,
  completeTask,
  failTask,
  deferTask,
  requeueTask,
  updateTaskStep,
  writeWorkerHeartbeat,
} = require('./task-store') as typeof import('./task-store')
const { runDailyWorkerTask } = require('./daily-worker') as typeof import('./daily-worker')
const { runAgentWorkerTask } = require('./agent-worker') as typeof import('./agent-worker')
const { drainOneMediaTask } = require('./media-worker') as typeof import('./media-worker')
const { runEmotionRenderWorkerTask } = require('./emotion-worker') as typeof import('./emotion-worker')
const { runMemoryWorkerTask } = require('./memory-worker') as typeof import('./memory-worker')
const { runBackgroundLlmWorkerTask } = require('./background-llm-worker') as typeof import('./background-llm-worker')
const { runDailySlotTask } = require('../daily-precompute/daily-slot-worker') as typeof import('../daily-precompute/daily-slot-worker')

interface WorkerMainOptions {
  type?: string
  workerName?: string
  once?: boolean
  pollMs?: number
  gateWaitMs?: number
}

interface WorkerHeartbeatHandle {
  setStep(step: string, patch?: Record<string, unknown>): void
  stop(step?: string): void
}

type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred'

interface ResourceTaskLike extends Record<string, unknown> {
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

interface AdmissionDecisionLike {
  decision: string
  reason?: unknown
  fallback?: unknown
}

// 等待指定毫秒，用于 worker 空转和退避。
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 解析任务运行超时；避免异常配置让 worker 永久等待。
function resolveTaskTimeoutMs(task: ResourceTaskLike, fallbackMs = 300000): number {
  const timeout = Number(task?.timeoutMs || task?.payload?.timeoutMs || fallbackMs)
  if (!Number.isFinite(timeout)) return fallbackMs
  return Math.max(10000, Math.min(30 * 60 * 1000, timeout))
}

// 给单个 worker 任务加 S8 运行超时兜底；超时后由调用方标记失败并退出进程。
async function runTaskWithTimeout(task: ResourceTaskLike): Promise<Record<string, unknown>> {
  const timeoutMs = resolveTaskTimeoutMs(task)
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      executeWorkerTask(task),
      new Promise<Record<string, unknown>>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`resource worker task timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 判断错误是否为 S8 任务超时。
function isTaskTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /resource worker task timed out/i.test(message)
}

// 记录任务超时并让独立 worker 进程退出，由 supervisor 拉起干净进程。
function handleTaskTimeoutExit(workerName: string, task: ResourceTaskLike, error: unknown): void {
  const taskId = String(task?.id || '')
  const kind = String(task?.kind || '')
  writeProcessCleanupEvent({
    event: 'task_timed_out',
    workerName,
    taskId,
    kind,
    timeoutMs: resolveTaskTimeoutMs(task),
    error: error instanceof Error ? error.message : String(error || 'task timeout'),
  })
  terminateRecordedProcessPids({
    taskId,
    kind,
    owner: workerName,
    source: 'resource_worker_timeout',
    reason: 'task_timed_out',
  })
  process.exitCode = process.exitCode || 76
}

// 启动 worker 周期心跳，避免长任务执行期间被 supervisor 误判为死亡。
function startWorkerHeartbeat(workerName: string, type: string, initialStep: string): WorkerHeartbeatHandle {
  let step = initialStep
  let extra: Record<string, unknown> = {}
  const startedAt = new Date().toISOString()
  const write = (): void => {
    writeWorkerHeartbeat(workerName, { kind: type, startedAt, step, ...extra })
  }
  const timer = setInterval(write, 2000)
  if (timer.unref) timer.unref()
  write()
  return {
    setStep(nextStep: string, patch: Record<string, unknown> = {}) {
      step = nextStep || step
      extra = patch
      write()
    },
    stop(finalStep = 'stopped') {
      clearInterval(timer)
      step = finalStep
      extra = {}
      write()
    },
  }
}

// 将 worker 类型映射为 S2 任务 kind 列表。
function getWorkerTaskKinds(type: string): string[] {
  if (type === 'daily') return [RESOURCE_TASK_KIND.DAILY_REPORT, RESOURCE_TASK_KIND.DAILY_SUMMARY, RESOURCE_TASK_KIND.EMOTION_RENDER]
  if (type === 'agent') {
    return [
      RESOURCE_TASK_KIND.AGENT_TASK,
      RESOURCE_TASK_KIND.DASHBOARD_AGENT,
      RESOURCE_TASK_KIND.AGENT_MEMORY,
      RESOURCE_TASK_KIND.AGENT_MEMORY_COMPACTION,
      RESOURCE_TASK_KIND.EXPRESSION_HARVEST,
      RESOURCE_TASK_KIND.CONVERSATION_SUMMARY,
      RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS,
    ]
  }
  return [String(type || '')].filter(Boolean)
}

// 生成 worker 名称。
function getWorkerName(type: string, explicit = ''): string {
  return explicit || `${type || 'resource'}-worker`
}

// 根据任务类型调用对应执行器。
async function executeWorkerTask(task: ResourceTaskLike): Promise<Record<string, unknown>> {
  if (task.kind === RESOURCE_TASK_KIND.DAILY_REPORT) return await runDailyWorkerTask(task)
  if (task.kind === RESOURCE_TASK_KIND.DAILY_SUMMARY) return runDailySlotTask(task)
  if (task.kind === RESOURCE_TASK_KIND.EMOTION_RENDER) return await runEmotionRenderWorkerTask(task)
  if (task.kind === RESOURCE_TASK_KIND.AGENT_TASK || task.kind === RESOURCE_TASK_KIND.DASHBOARD_AGENT) return await runAgentWorkerTask(task)
  if (task.kind === RESOURCE_TASK_KIND.AGENT_MEMORY || task.kind === RESOURCE_TASK_KIND.AGENT_MEMORY_COMPACTION) return await runMemoryWorkerTask(task)
  if (task.kind === RESOURCE_TASK_KIND.EXPRESSION_HARVEST || task.kind === RESOURCE_TASK_KIND.CONVERSATION_SUMMARY || task.kind === RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS) return await runBackgroundLlmWorkerTask(task)
  throw new Error(`unsupported S2 worker task kind: ${String(task.kind || '')}`)
}

// 判断任务是否需要 S0 独占锁；daily_summary 是非 AI 预计算统计，不占高风险运行槽。
function requiresExclusiveGate(task: ResourceTaskLike): boolean {
  return task.kind !== RESOURCE_TASK_KIND.DAILY_SUMMARY
}

// 按 S1 降级决策调整任务 payload，避免 worker 继续执行被禁止的高成本阶段。
function applyAdmissionDecisionToTask(task: ResourceTaskLike, admission: AdmissionDecisionLike): ResourceTaskLike {
  if (!admission || admission.decision !== 'downgrade') return task
  if (task.kind !== RESOURCE_TASK_KIND.DAILY_REPORT) return task
  return {
    ...task,
    payload: {
      ...(task.payload || {}),
      renderImage: false,
      level: 'text',
      downgradeReason: String(admission.reason || 'resource downgrade'),
      fallback: String(admission.fallback || 'daily_report_text'),
    },
  }
}

// 执行不需要 S0 独占锁的低风险任务，同时保留 S2 状态迁移和结果落盘。
async function runTaskWithoutGate(task: ResourceTaskLike, workerName: string, heartbeat?: WorkerHeartbeatHandle | null): Promise<boolean> {
  if (heartbeat) heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind })
  const runningTask = markTaskRunning(task, workerName, 'running')
  try {
    const result = await runTaskWithTimeout(runningTask)
    if (result && result.defer) {
      deferTask(runningTask, String(result.reason || 'worker deferred'))
    } else {
      completeTask(runningTask, result || { mode: 'worker', reason: 'completed' })
    }
  } catch (error) {
    failTask(runningTask, error, { reason: error instanceof Error ? error.message : String(error || '') })
    if (isTaskTimeoutError(error)) handleTaskTimeoutExit(workerName, runningTask, error)
  } finally {
    if (heartbeat) heartbeat.setStep('tick')
  }
  return true
}

// 处理一个 S2 pending 任务；没有任务时返回 false。
async function runOneQueuedTask(options: WorkerMainOptions = {}, heartbeat?: WorkerHeartbeatHandle | null): Promise<boolean> {
  const type = String(options.type || 'daily')
  const workerName = getWorkerName(type, options.workerName || '')
  const kinds = getWorkerTaskKinds(type)
  const task = claimNextTask(kinds, workerName)
  if (!task) return false
  const exclusive = requiresExclusiveGate(task)

  const admission = admitTask({
    taskId: task.id,
    kind: task.kind,
    source: workerName,
    channelKey: task.channelKey,
    userId: task.userId,
    exclusive,
    priority: task.priority,
    queueTimeoutMs: task.timeoutMs,
    runTimeoutMs: task.timeoutMs,
  })
  if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
    failTask(task, new Error(String(admission.reason || admission.decision)), { reason: admission.reason || admission.decision })
    return true
  }
  if (admission.decision === 'defer') {
    deferTask(task, String(admission.reason || admission.decision))
    return true
  }
  if (admission.decision === 'queue') {
    requeueTask(task, String(admission.reason || admission.decision))
    return true
  }
  const admittedTask = applyAdmissionDecisionToTask(task, admission)
  if (!exclusive) return runTaskWithoutGate(admittedTask, workerName, heartbeat)

  let runningTask = markTaskRunning(admittedTask, workerName, 'waiting_lock')
  let gateHandle: { updateStep(step: string, memAvailableMb?: number | null): void; release(reason?: string): void } | null = null
  try {
    if (heartbeat) heartbeat.setStep('waiting_lock', { taskId: task.id, taskKind: task.kind })
    gateHandle = await acquireResourceGate({
      taskId: task.id,
      kind: task.kind,
      owner: workerName,
      channelKey: task.channelKey,
      userId: task.userId,
      priority: task.priority,
      timeoutMs: task.timeoutMs,
      waitTimeoutMs: Number.isFinite(Number(options.gateWaitMs)) ? Number(options.gateWaitMs) : 15000,
      step: 'running',
    })
    gateHandle.updateStep('running')
    if (heartbeat) heartbeat.setStep('running', { taskId: task.id, taskKind: task.kind })
    runningTask = markTaskRunning(runningTask, workerName, 'running')
    const result = await runTaskWithTimeout(runningTask)
    if (result && result.defer) {
      deferTask(runningTask, String(result.reason || 'worker deferred'))
    } else {
      completeTask(runningTask, result || { mode: 'worker', reason: 'completed' })
    }
    return true
  } catch (error) {
    if (!gateHandle) requeueTask(runningTask, error instanceof Error ? error.message : String(error || 'lock_wait_failed'))
    else {
      failTask(runningTask, error, { reason: error instanceof Error ? error.message : String(error || '') })
      if (isTaskTimeoutError(error)) handleTaskTimeoutExit(workerName, runningTask, error)
    }
    return true
  } finally {
    if (gateHandle) gateHandle.release('worker-finally')
    if (heartbeat) heartbeat.setStep('tick')
  }
}

// 执行一次 worker tick，media 类型走 S6 队列，其余类型走 S2 队列。
async function runWorkerTick(options: WorkerMainOptions = {}, heartbeat?: WorkerHeartbeatHandle | null): Promise<boolean> {
  const type = String(options.type || 'daily')
  const workerName = getWorkerName(type, options.workerName || '')
  if (heartbeat) heartbeat.setStep('tick')
  else writeWorkerHeartbeat(workerName, { kind: type, step: 'tick' })
  collectProcessMetrics({ workerName, workerType: type })
  const memory = checkWorkerMemoryLimit(workerName)
  if (memory.exceeded) {
    if (heartbeat) heartbeat.setStep('memory_limit_exceeded', { rssMb: memory.rssMb })
    else writeWorkerHeartbeat(workerName, { kind: type, step: 'memory_limit_exceeded', rssMb: memory.rssMb })
    process.exitCode = 75
    return false
  }
  if (type === 'media') return drainOneMediaTask({ workerName, gateWaitMs: options.gateWaitMs })
  return runOneQueuedTask(options, heartbeat)
}

// 运行 worker 主循环；once=true 时只执行一轮，便于运维手动验证。
async function runWorkerLoop(options: WorkerMainOptions = {}): Promise<void> {
  const type = String(options.type || 'daily')
  const workerName = getWorkerName(type, options.workerName || '')
  const pollMs = Math.max(500, Math.min(30000, Number(options.pollMs || 2000)))
  const heartbeat = startWorkerHeartbeat(workerName, type, 'started')
  try {
    heartbeat.setStep('started', { startedAt: new Date().toISOString() })
    do {
      const worked = await runWorkerTick({ ...options, type, workerName }, heartbeat)
      if (options.once) break
      await sleep(worked ? 200 : pollMs)
    } while (!process.exitCode)
  } finally {
    heartbeat.stop('stopped')
  }
}

// 解析命令行参数，支持 node worker-main.js --type media --once。
function parseWorkerCliArgs(argv: string[] = process.argv.slice(2)): WorkerMainOptions {
  const options: WorkerMainOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--type') options.type = argv[++i]
    else if (arg === '--name') options.workerName = argv[++i]
    else if (arg === '--once') options.once = true
    else if (arg === '--poll-ms') options.pollMs = Number(argv[++i])
    else if (arg === '--gate-wait-ms') options.gateWaitMs = Number(argv[++i])
  }
  return options
}

if (require.main === module) {
  runWorkerLoop(parseWorkerCliArgs()).catch(error => {
    console.error('[resource-worker] failed:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export = {
  runWorkerLoop,
  runWorkerTick,
  runOneQueuedTask,
  runTaskWithTimeout,
  parseWorkerCliArgs,
}
