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
  runExpressionHarvestForAllChannels,
  formatExpressionHarvestDiagnostic,
} = require('../behavior/expression/expression-abstractor') as typeof import('../behavior/expression/expression-abstractor')

interface StartupSchedulerContext {
  bots?: Array<{ selfId?: string; userId?: string }>
  logger(name: string): { info?: (message: string) => void; warn(message: string): void }
}

type StartupTimer = ReturnType<typeof setTimeout> | null

let dailyCleanupTimer: StartupTimer = null
let expressionHarvestTimer: StartupTimer = null

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
      const result = await runExpressionHarvestForAllChannels(ctx)
      logDebug(ctx, 'expression-pool', formatExpressionHarvestDiagnostic(result))
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

function clearStartupSchedulers(): void {
  if (dailyCleanupTimer) {
    clearTimeout(dailyCleanupTimer)
    dailyCleanupTimer = null
  }
  if (expressionHarvestTimer) {
    clearTimeout(expressionHarvestTimer)
    expressionHarvestTimer = null
  }
}

export = {
  getNextShanghaiMidnightDelayMs,
  scheduleDailyStatsCleanup,
  getExpressionHarvestDelayMs,
  scheduleExpressionHarvest,
  clearStartupSchedulers,
}
