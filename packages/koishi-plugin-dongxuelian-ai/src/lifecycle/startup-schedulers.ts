/* ==========================================================================
 * MODULE: startup-schedulers
 * 职责：管理插件启动后的周期性维护任务定时器。
 * 边界：不注册 middleware、不发送消息、不修改聊天/随机策略；只调度清理和表达学习 harvest。
 * 状态：持有 dailyCleanupTimer 与 expressionHarvestTimer，dispose 时由调用方显式清理。
 * ========================================================================== */
const {
  trimChannelRuntimeCaches,
  cleanupDailyStatsFiles,
} = require('../conversation') as typeof import('../conversation')
const { todayCst } = require('../core/utils') as typeof import('../core/utils')
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')
const {
  submitExpressionHarvestTask,
} = require('../resource-workers/background-llm-submission') as typeof import('../resource-workers/background-llm-submission')
const { planDailySlotTasks } = require('../daily-precompute/daily-slot-planner') as typeof import('../daily-precompute/daily-slot-planner')
const { listDailyCoverage } = require('../daily-precompute/precompute-status') as typeof import('../daily-precompute/precompute-status')

interface StartupSchedulerContext {
  bots?: Array<{ selfId?: string; userId?: string }>
  logger(name: string): { info?: (message: string) => void; warn(message: string): void }
}

type StartupTimer = ReturnType<typeof setTimeout> | null

let dailyCleanupTimer: StartupTimer = null
let expressionHarvestTimer: StartupTimer = null
let dailyPrecomputeTimer: StartupTimer = null

function getStartupSchedulerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

function getNextShanghaiMidnightDelayMs(now: number = Date.now()): number {
  const [year, month, day] = todayCst(new Date(now)).split('-').map(Number)
  const nextMidnightUtc = Date.UTC(year, month - 1, day, 16, 0, 0, 0)
  return Math.max(1000, nextMidnightUtc - now)
}

function scheduleDailyStatsCleanup(ctx: StartupSchedulerContext): void {
  const runDailyStatsCleanup = async () => {
    try {
      const result = await cleanupDailyStatsFiles()
      trimChannelRuntimeCaches()
      logDebug(ctx, 'cleanup', `daily stats cleanup removed=${result.removed} compacted=${result.compacted}`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${getStartupSchedulerErrorMessage(error)}`)
    } finally {
      dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs())
      if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function') dailyCleanupTimer.unref()
    }
  }
  dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs())
  if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function') dailyCleanupTimer.unref()
}

function getExpressionHarvestDelayMs(now: number = Date.now()): number {
  const fiveMinutesMs = 5 * 60 * 1000
  const delayUntilNextMidnight = getNextShanghaiMidnightDelayMs(now)
  if (delayUntilNextMidnight > fiveMinutesMs) return delayUntilNextMidnight - fiveMinutesMs
  return delayUntilNextMidnight + (24 * 60 * 60 * 1000) - fiveMinutesMs
}

function scheduleExpressionHarvest(ctx: StartupSchedulerContext): void {
  const runExpressionHarvestTick = async () => {
    try {
      const firstBot = ctx && Array.isArray(ctx.bots) ? ctx.bots[0] : null
      const result = submitExpressionHarvestTask({
        source: 'expression-harvest-scheduler',
        selfUserId: String(firstBot?.selfId || firstBot?.userId || ''),
      })
      logDebug(ctx, 'expression-pool', `expression_harvest status=${result.status} taskId=${result.taskId || ''}`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`expression harvest failed: ${getStartupSchedulerErrorMessage(error)}`)
    } finally {
      expressionHarvestTimer = setTimeout(runExpressionHarvestTick, getExpressionHarvestDelayMs())
      if (expressionHarvestTimer && typeof expressionHarvestTimer.unref === 'function') expressionHarvestTimer.unref()
    }
  }
  expressionHarvestTimer = setTimeout(runExpressionHarvestTick, getExpressionHarvestDelayMs())
  if (expressionHarvestTimer && typeof expressionHarvestTimer.unref === 'function') expressionHarvestTimer.unref()
}

// 按 coverage 中出现过的频道低频规划 S3 分片任务，真正执行仍交给 daily-worker。
function scheduleDailyPrecomputePlanning(ctx: StartupSchedulerContext): void {
  const intervalMs = Math.max(5 * 60 * 1000, Math.min(6 * 60 * 60 * 1000, Number(process.env.DAILY_PRECOMPUTE_PLAN_INTERVAL_MS || 30 * 60 * 1000)))
  const runDailyPrecomputeTick = async () => {
    try {
      const today = todayCst()
      const coverages = listDailyCoverage(200)
        .filter(item => String(item.date || '') === today)
        .slice(0, 80)
      let planned = 0
      for (const item of coverages) {
        const channelKey = String(item.channelKey || '')
        if (!channelKey) continue
        const tasks = planDailySlotTasks(today, channelKey, {
          source: 'daily-precompute-scheduler',
          maxSlots: 4,
        })
        planned += tasks.length
      }
      logDebug(ctx, 'daily-precompute', `planned slot tasks=${planned} channels=${coverages.length}`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`daily precompute planning failed: ${getStartupSchedulerErrorMessage(error)}`)
    } finally {
      dailyPrecomputeTimer = setTimeout(runDailyPrecomputeTick, intervalMs)
      if (dailyPrecomputeTimer && typeof dailyPrecomputeTimer.unref === 'function') dailyPrecomputeTimer.unref()
    }
  }
  dailyPrecomputeTimer = setTimeout(runDailyPrecomputeTick, Math.min(2 * 60 * 1000, intervalMs))
  if (dailyPrecomputeTimer && typeof dailyPrecomputeTimer.unref === 'function') dailyPrecomputeTimer.unref()
}


function clearStartupSchedulers(): void {
  if (dailyCleanupTimer) {
    clearTimeout(dailyCleanupTimer)
    dailyCleanupTimer = null
  }
  if (expressionHarvestTimer) {
    clearTimeout(expressionHarvestTimer)
    expressionHarvestTimer = null
  }
  if (dailyPrecomputeTimer) {
    clearTimeout(dailyPrecomputeTimer)
    dailyPrecomputeTimer = null
  }
}

export = {
  getNextShanghaiMidnightDelayMs,
  scheduleDailyStatsCleanup,
  getExpressionHarvestDelayMs,
  scheduleExpressionHarvest,
  scheduleDailyPrecomputePlanning,
  clearStartupSchedulers,
}
