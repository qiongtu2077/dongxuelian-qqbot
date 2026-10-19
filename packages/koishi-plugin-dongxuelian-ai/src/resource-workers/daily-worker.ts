/**
 * MODULE: S2 daily-worker 执行器。
 * 职责: 在独立 worker 中生成日报结果文件，供 Koishi result-notifier 发送。
 * 边界: 不直接发送 QQ 消息，不管理 S2 任务状态迁移。
 */
const path = require('path') as typeof import('path')
const { getTaskResultDir } = require('./task-paths') as typeof import('./task-paths')
const { updateTaskStep, writeWorkerEvent } = require('./task-store') as typeof import('./task-store')
const { resolveReportPeriod } = require('../daily-precompute/report-period') as typeof import('../daily-precompute/report-period')
const { listActiveDailyReportTasks } = require('./task-store') as typeof import('./task-store')
const { getResourceGateStatus } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive') as typeof import('../resource-scheduler/background-directive')

interface WorkerTaskResult extends Record<string, unknown> {
  defer?: boolean
  reason?: string
  mode?: string
}

interface DailyWorkerTaskLike {
  id?: string
  kind?: string
  channelKey?: string
  createdAt?: string
  notify?: { target?: string }
  payload?: Record<string, unknown> & {
    renderImage?: unknown
    level?: unknown
    detail?: unknown
  }
}

interface DailyPipelineLike {
  generateDailyReportResult(options: {
    taskId?: string
    channelKey: unknown
    detail?: boolean
    outputDir: string
    renderImage?: boolean
    onStep?: (step: string) => unknown
    reportPeriod?: ReturnType<typeof resolveReportPeriod>
    periodBackfilled?: boolean
    deadlineMs?: number
    startedAtMs?: number
    signal?: AbortSignal
    assertActive?: () => void
  }): Promise<Record<string, unknown>>
}

interface RequireFailureLike {
  code?: unknown
  message?: unknown
}

function isMissingCandidateModule(error: unknown, candidate: string): boolean {
  if (!error || typeof error !== 'object') return false
  const failure = error as RequireFailureLike
  if (failure.code !== 'MODULE_NOT_FOUND' || typeof failure.message !== 'string') return false
  const normalizedCandidate = candidate.replace(/\\/g, '/')
  return (
    failure.message.includes(`'${candidate}'`) ||
    failure.message.includes(`'${normalizedCandidate}'`) ||
    failure.message.includes(`"${candidate}"`) ||
    failure.message.includes(`"${normalizedCandidate}"`)
  )
}

// 动态加载 sibling daily-report 包的 pipeline，兼容构建后 lib 和开发期 src。
function loadDailyReportPipeline(): DailyPipelineLike {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'koishi-plugin-daily-report', 'lib', 'report-pipeline'),
    path.join(__dirname, '..', '..', '..', 'koishi-plugin-daily-report', 'src', 'report-pipeline'),
  ]
  for (const candidate of candidates) {
    try {
      const mod = require(candidate) as DailyPipelineLike
      if (mod && typeof mod.generateDailyReportResult === 'function') return mod
    } catch (error) {
      if (isMissingCandidateModule(error, candidate)) continue
      throw error
    }
  }
  throw new Error('daily-report report-pipeline is unavailable; run daily-report build first')
}

// 将 worker 内部步骤同步给 S2 running 任务，供 Dashboard 资源中心显示。
function updateDailyWorkerStep(task: DailyWorkerTaskLike, step: string): void {
  try {
    updateTaskStep(String(task?.id || ''), String(task?.kind || 'daily_report'), step)
  } catch {
    /* status update failure must not break report generation */
  }
}

// 独立日报 worker 只生成结果文件，发送由 Koishi result-notifier 完成。
async function runDailyWorkerTask(task: DailyWorkerTaskLike, runtime: { deadlineMs?: number; startedAtMs?: number; signal?: AbortSignal; assertActive?: () => void } = {}): Promise<WorkerTaskResult> {
  const taskId = String(task?.id || '')
  const payload = task?.payload || {}
  const outputDir = getTaskResultDir(taskId)
  const renderImage = payload.renderImage !== false && payload.level !== 'text'
  const reportPeriod = resolveReportPeriod(payload, String(task.createdAt || ''))
  const pipeline = loadDailyReportPipeline()
  writeWorkerEvent('daily_worker_pipeline_started', { taskId, channelKey: task?.channelKey || '', renderImage })
  const result = await pipeline.generateDailyReportResult({
    taskId,
    channelKey: task?.channelKey || '',
    detail: !!payload.detail,
    outputDir,
    renderImage,
    reportPeriod,
    periodBackfilled: reportPeriod.periodBackfilled,
    deadlineMs: runtime.deadlineMs,
    startedAtMs: runtime.startedAtMs,
    signal: runtime.signal,
    assertActive: runtime.assertActive,
    onStep: step => updateDailyWorkerStep(task, step),
  })
  writeWorkerEvent('daily_worker_pipeline_finished', { taskId, mode: result.mode || '', reason: result.reason || '' })
  return {
    ...result,
    mode: String(result.mode || 'daily_worker'),
    reason: String(result.reason || 'completed'),
  }
}

// 后台使用独立明确入口，任何缺省配置均关闭；不把重型模型请求交给统计工作器。
async function runDailyPreanalysisWorkerTask(task: DailyWorkerTaskLike, runtime?: {
  deadlineMs: number; startedAtMs: number; signal: AbortSignal; assertActive?: () => void
}): Promise<WorkerTaskResult> {
  if (process.env.DAILY_REPORT_PREANALYSIS_ENABLED !== '1') throw new Error('日报预分析尚未启用')
  if (task.notify?.target !== 'none') throw new Error('日报预分析任务禁止结果通知')
  if (!runtime?.assertActive || runtime.deadlineMs !== runtime.startedAtMs + 90000 || !task.id || !task.channelKey) {
    throw new Error('日报预分析任务身份、领取或原截止无效')
  }
  runtime.assertActive()
  const gate = getResourceGateStatus()
  if (!gate.locked || !gate.meta || gate.meta.taskId !== task.id || gate.meta.kind !== 'daily_report_preanalysis'
    || gate.meta.pid !== process.pid || !gate.meta.ticketId) throw new Error('日报预分析缺少本次S0独占租约')
  const ticketId = gate.meta.ticketId
  const assertLease = (): void => {
    const current = getResourceGateStatus()
    if (!current.locked || !current.meta || current.meta.taskId !== task.id || current.meta.kind !== task.kind
      || current.meta.pid !== process.pid || current.meta.ticketId !== ticketId) throw new Error('日报预分析S0独占租约已失效')
  }
  const hasForegroundPending = (): boolean => listActiveDailyReportTasks().some(value => value.kind === 'daily_report')
  const directive = decideBackgroundDirective({ taskId: task.id, kind: task.kind, source: 'daily-preanalysis-worker',
    channelKey: task.channelKey, exclusive: true, priority: 99, timeoutMs: 90000, runTimeoutMs: 90000, queueTimeoutMs: 90000 })
  if (directive.directive.action === 'park' || hasForegroundPending()) return { defer: true, reason: 'daily_preanalysis_foreground_or_resource_wait' }
  const pipeline = require(path.join(__dirname, '..', '..', '..', 'koishi-plugin-daily-report', 'lib', 'report-preanalysis')) as {
    runReportPreanalysisTask(options: { taskId: string; channelKey: string; period: Omit<ReturnType<typeof resolveReportPeriod>, 'periodBackfilled'>;
      deadlineMs: number; startedAtMs: number; signal: AbortSignal; assertActive(): void; assertLease(): void;
      hasForegroundPending(): boolean }): Promise<Record<string, unknown>>
  }
  const { periodBackfilled: _periodBackfilled, ...period } = resolveReportPeriod(task.payload || {}, String(task.createdAt || ''))
  return await pipeline.runReportPreanalysisTask({ taskId: task.id, channelKey: task.channelKey,
    period, ...runtime,
    assertActive: runtime.assertActive, assertLease, hasForegroundPending })
}

export = {
  runDailyWorkerTask,
  runDailyPreanalysisWorkerTask,
}
