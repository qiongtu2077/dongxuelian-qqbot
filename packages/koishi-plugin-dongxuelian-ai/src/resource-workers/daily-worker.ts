/**
 * MODULE: S2 daily-worker 执行器。
 * 职责: 在独立 worker 中生成日报结果文件，供 Koishi result-notifier 发送。
 * 边界: 不直接发送 QQ 消息，不管理 S2 任务状态迁移。
 */
const path = require('path') as typeof import('path')
const { getTaskResultDir } = require('./task-paths') as typeof import('./task-paths')
const { updateTaskStep, writeWorkerEvent } = require('./task-store') as typeof import('./task-store')

interface WorkerTaskResult extends Record<string, unknown> {
  defer?: boolean
  reason?: string
  mode?: string
}

interface DailyWorkerTaskLike {
  id?: string
  kind?: string
  channelKey?: string
  payload?: {
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
  }): Promise<Record<string, unknown>>
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
    } catch {
      /* try next candidate */
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
async function runDailyWorkerTask(task: DailyWorkerTaskLike): Promise<WorkerTaskResult> {
  const taskId = String(task?.id || '')
  const payload = task?.payload || {}
  const outputDir = getTaskResultDir(taskId)
  const renderImage = payload.renderImage !== false && payload.level !== 'text'
  const pipeline = loadDailyReportPipeline()
  writeWorkerEvent('daily_worker_pipeline_started', { taskId, channelKey: task?.channelKey || '', renderImage })
  const result = await pipeline.generateDailyReportResult({
    taskId,
    channelKey: task?.channelKey || '',
    detail: !!payload.detail,
    outputDir,
    renderImage,
    onStep: step => updateDailyWorkerStep(task, step),
  })
  writeWorkerEvent('daily_worker_pipeline_finished', { taskId, mode: result.mode || '', reason: result.reason || '' })
  return {
    ...result,
    mode: String(result.mode || 'daily_worker'),
    reason: String(result.reason || 'completed'),
  }
}

export = {
  runDailyWorkerTask,
}
