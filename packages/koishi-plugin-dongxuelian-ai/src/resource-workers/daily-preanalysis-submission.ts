/**
 * MODULE: 默认关闭的日报预分析低优先规划与提交。
 * 边界: 复用维护循环、S1/S0/S2；只规划一个封闭候选，不请求模型、不通知。
 */
const path = require('path') as typeof import('path')
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive') as typeof import('../resource-scheduler/background-directive')
const { acquireResourceGate, getResourceGateStatus, ResourceGateBusyTimeoutError } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const { createTaskId, listActiveDailyReportTasks } = require('./task-store') as typeof import('./task-store')
const { submitWorkerTaskWithAdmission } = require('./task-client') as typeof import('./task-client')
const { listDailyCoverage } = require('../daily-precompute/precompute-status') as typeof import('../daily-precompute/precompute-status')
const { createReportPeriod, getReportIndexDates } = require('../daily-precompute/report-period') as typeof import('../daily-precompute/report-period')

interface PlanningContext { logger(name: string): { warn(message: string): void } }
interface PlanningResult { planned: number; scanned: number; reason: string }
interface PlanningPipeline {
  planReportPreanalysisTask(options: {
    taskId: string; channelKey: string; period: ReturnType<typeof createReportPeriod>; startedAtMs: number; deadlineMs: number;
    signal: AbortSignal; assertActive(): void; assertLease(): void; hasForegroundPending(): boolean
  }): Promise<{ ready: boolean; reason: string; catalogId?: string }>
}
let planning = false
let lastChannel = ''

// 一个全局后台候选足够驱动daily工作器；扫描游标仅帮助公平，不证明已完成。
async function runDailyPreanalysisPlanningTick(ctx: PlanningContext, isActive: () => boolean = () => true): Promise<PlanningResult> {
  if (process.env.DAILY_REPORT_PREANALYSIS_ENABLED !== '1' || process.env.DAILY_REPORT_GROUNDED_ENABLED !== '1') return { planned: 0, scanned: 0, reason: 'disabled' }
  if (planning || !isActive()) return { planned: 0, scanned: 0, reason: 'inactive' }
  planning = true
  let gate: Awaited<ReturnType<typeof acquireResourceGate>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const startedAtMs = Date.now(), deadlineMs = startedAtMs + 90000
  const plannerId = createTaskId('daily_report_preanalysis', 'planning')
  const budget = { taskId: plannerId, kind: 'daily_report_preanalysis', source: 'daily-preanalysis-planner',
    channelKey: 'global', exclusive: true, priority: 99, timeoutMs: 90000, queueTimeoutMs: 90000, runTimeoutMs: 90000 }
  let scanned = 0
  // dispose、开关关闭、原截止及票据更换都立即阻止后续提交。
  const assertActive = (): void => {
    if (!isActive() || process.env.DAILY_REPORT_PREANALYSIS_ENABLED !== '1' || process.env.DAILY_REPORT_GROUNDED_ENABLED !== '1' || controller.signal.aborted || Date.now() >= deadlineMs) {
      throw new Error('日报预分析规划已取消或超过原九十秒')
    }
  }
  const assertLease = (): void => {
    const current = getResourceGateStatus()
    if (!gate || !current.locked || current.meta?.ticketId !== gate.ticketId || current.meta.taskId !== plannerId
      || current.meta.pid !== process.pid) throw new Error('日报预分析规划S0租约已失效')
  }
  const hasForegroundPending = (): boolean => listActiveDailyReportTasks().some(task => task.kind === 'daily_report')
  try {
    assertActive()
    if (listActiveDailyReportTasks().length) return { planned: 0, scanned, reason: 'active_report_task' }
    const directive = decideBackgroundDirective(budget)
    if (directive.directive.action === 'park') return { planned: 0, scanned, reason: directive.directive.reason }
    // 不等待重任务交还S0；下一个既有维护tick再检查。
    gate = await acquireResourceGate({ ...budget, owner: budget.source, waitTimeoutMs: 0 })
    assertActive(); assertLease()
    timer = setTimeout(() => controller.abort(new Error('日报预分析规划截止')), Math.max(0, deadlineMs - Date.now()))
    const period = createReportPeriod(startedAtMs), dates = new Set(getReportIndexDates(period))
    const channels = [...new Set(listDailyCoverage(1000).filter(item => dates.has(String(item.date || '')))
      .map(item => String(item.channelKey || '')).filter(Boolean))].sort()
    const ordered = [...channels.filter(channel => channel > lastChannel), ...channels.filter(channel => channel <= lastChannel)]
    const pipeline = require(path.join(__dirname, '..', '..', '..', 'koishi-plugin-daily-report', 'lib', 'report-preanalysis')) as PlanningPipeline
    for (const channelKey of ordered) {
      assertActive(); assertLease()
      if (listActiveDailyReportTasks().length || decideBackgroundDirective(budget).directive.action === 'park') {
        return { planned: 0, scanned, reason: 'foreground_or_resource_wait' }
      }
      const taskId = createTaskId('daily_report_preanalysis', channelKey)
      scanned++; lastChannel = channelKey
      let candidate: Awaited<ReturnType<PlanningPipeline['planReportPreanalysisTask']>>
      try {
        candidate = await pipeline.planReportPreanalysisTask({ taskId, channelKey, period, startedAtMs, deadlineMs,
          signal: controller.signal, assertActive, assertLease, hasForegroundPending })
      } catch (error) {
        assertActive(); assertLease()
        ctx.logger('dongxuelian-ai').warn('daily preanalysis planning stopped: ' + (error instanceof Error ? error.message : String(error)))
        // 缺账/损坏不是可用的零额度；本轮不把同一故障扩散为连续排队。
        return { planned: 0, scanned, reason: 'planning_failed' }
      }
      if (!candidate.ready) {
        if (candidate.reason === 'global_limit' || candidate.reason === 'foreground') return { planned: 0, scanned, reason: candidate.reason }
        continue
      }
      assertActive(); assertLease()
      if (listActiveDailyReportTasks().length) return { planned: 0, scanned, reason: 'foreground_or_background_arrived' }
      const result = submitWorkerTaskWithAdmission({ id: taskId, kind: budget.kind, channelKey, source: budget.source,
        priority: 99, timeoutMs: 90000, expiresAt: new Date(Date.now() + 300000).toISOString(),
        payload: { ...period }, notify: { target: 'none', status: 'pending' } }, { checkAdmission: true, exclusive: true })
      const accepted = ['pending', 'deferred'].includes(result.task.status)
      return { planned: accepted ? 1 : 0, scanned, reason: accepted ? 'submitted' : 'admission_rejected' }
    }
    return { planned: 0, scanned, reason: 'no_ready_candidate' }
  } catch (error) {
    if (error instanceof ResourceGateBusyTimeoutError) return { planned: 0, scanned, reason: 'gate_busy' }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort(new Error('日报预分析规划结束'))
    try { gate?.release('daily-preanalysis-planning-finished') } finally { planning = false }
  }
}

export = { runDailyPreanalysisPlanningTick }
