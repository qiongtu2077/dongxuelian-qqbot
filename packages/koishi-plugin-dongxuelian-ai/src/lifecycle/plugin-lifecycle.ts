/* ==========================================================================
 * MODULE: plugin-lifecycle
 * 职责: 注册插件 ready / dispose 生命周期、启动期缓存恢复与周期性敏感扫描。
 * 边界: 不注册消息 middleware、不发送消息、不处理聊天/随机/Agent 路由决策。
 * 状态: 仅持有 sensitiveTimer；其他定时器由 startup-schedulers / agent cron 自己持有。
 * ========================================================================== */
const fsSync = require('fs')
const path = require('path')
const {
  DATA_DIR,
  PLUGIN_VERSION,
  THINKING_MODE_FILE,
  POLITICAL_DETECT_FILE,
} = require('../core/constants') as typeof import('../core/constants')
const {
  readTextFile,
  readJsonFile,
  todayCst,
} = require('../core/utils') as typeof import('../core/utils')
const {
  loadConfig,
  setThinkingEnabled,
} = require('../core/runtime-config') as typeof import('../core/runtime-config')
const {
  loadRuntimeSettings,
} = require('../behavior/runtime-settings') as typeof import('../behavior/runtime-settings')
const {
  loadSkills,
  loadSkillsContentCache,
} = require('../persona/skills/skills-loader') as typeof import('../persona/skills/skills-loader')
const {
  loadStickerCache,
} = require('../reply/reply') as typeof import('../reply/reply')
const {
  loadPersonaGroups,
  loadPersonaUsers,
} = require('../persona/persona') as typeof import('../persona/persona')
const {
  loadRepeatConfig,
} = require('../behavior/repeat') as typeof import('../behavior/repeat')
const {
  loadRandomVoiceRateCache,
} = require('../behavior/random-voice-rate') as typeof import('../behavior/random-voice-rate')
const {
  channelTodayCache,
  trimChannelRuntimeCaches,
  cleanupDailyStatsFiles,
  analyzeChannelSensitive,
} = require('../conversation') as typeof import('../conversation')
const {
  scheduleDailyStatsCleanup,
  scheduleExpressionHarvest,
  scheduleDailyPrecomputePlanning,
  clearStartupSchedulers,
} = require('./startup-schedulers') as typeof import('./startup-schedulers')
const {
  clearChannelQueues,
} = require('./channel-task-queue') as typeof import('./channel-task-queue')
const {
  clearRandomPendingState,
} = require('../behavior/random-state') as typeof import('../behavior/random-state')
const agentConfig = require('../agent/config') as typeof import('../agent/config')
const agentCron = require('../agent/cron') as typeof import('../agent/cron')
const {
  notifyCompletedTasks,
  createResourceResultSender,
} = require('../resource-workers/result-notifier') as typeof import('../resource-workers/result-notifier')
const {
  runSupervisorOnce,
} = require('../resource-workers/worker-supervisor') as typeof import('../resource-workers/worker-supervisor')

interface TodayCacheSnapshot {
  date?: string
  messages?: Array<{
    time: string
    ts: number
    user: string
    userId: string
    content: string
    messageId: string
    mentionUserIds: string[]
  }>
}

interface LifecycleBotLike {
  selfId?: string
  userId?: string
  sendPrivateMessage?: (target: string, content: string) => Promise<unknown> | unknown
  sendMessage?: (target: string, content: unknown) => Promise<unknown> | unknown
  internal?: {
    sendPrivateMsg?: (target: string, segments: unknown) => Promise<unknown> | unknown
    sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown
  }
}

interface LifecycleLoggerLike {
  info(message: string): void
  warn(message: string): void
}

interface LifecycleContext {
  bots?: LifecycleBotLike[]
  bot?: LifecycleBotLike | null
  on(event: 'ready' | 'dispose', handler: () => unknown): void
  logger(name: string): LifecycleLoggerLike
}

interface LifecycleAgentEngine {
  run: typeof import('../agent/engine').run
}

interface PluginLifecycleOptions {
  agentEngine?: LifecycleAgentEngine | null
  configureAgentQueue?: (queueConfig: unknown) => void
}

const RESULT_NOTIFIER_INTERVAL_MS = Math.max(5000, Math.min(120000, Number(process.env.RESOURCE_RESULT_NOTIFIER_INTERVAL_MS || 15000)))
const RESOURCE_SUPERVISOR_INTERVAL_MS = Math.max(10000, Math.min(300000, Number(process.env.RESOURCE_WORKER_SUPERVISOR_INTERVAL_MS || 30000)))

function getLifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveLifecycleBot(ctx: LifecycleContext): LifecycleBotLike | null {
  const bot = Array.isArray(ctx.bots) ? ctx.bots[0] : ctx.bot
  return bot || null
}

function isResourceWorkerSupervisorEnabled(): boolean {
  const raw = String(process.env.RESOURCE_WORKER_SUPERVISOR_ENABLED || '1').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(raw)
}

function restoreTodayCacheEntry(key: string, data: TodayCacheSnapshot | null | undefined): void {
  if (!data || !Array.isArray(data.messages) || data.messages.length <= 0) return
  const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000
  const kept = data.messages.filter(m => m.ts >= cutoff).slice(-5000)
  if (kept.length <= 0) return
  channelTodayCache.set(key, { date: todayCst(), messages: kept, updatedAt: Date.now() })
}

function restoreTodayCache(): void {
  try {
    const files = fsSync.readdirSync(DATA_DIR).filter((f: string) => f.startsWith('today-cache-') && f.endsWith('.json'))
    for (const fileName of files) {
      try {
      const raw = fsSync.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
      const data = JSON.parse(raw) as TodayCacheSnapshot
      if (data && Array.isArray(data.messages) && data.messages.length > 0) {
        const key = fileName.replace('today-cache-', '').replace('.json', '')
        restoreTodayCacheEntry(key, data)
      }
      } catch { /* non-critical: skip one unreadable today-cache file during best-effort startup restore */
      }
    }
  } catch { /* non-critical: missing data dir or cache listing failure only disables startup cache restore */
  }
}

function registerPluginLifecycle(ctx: LifecycleContext, options: PluginLifecycleOptions = {}): void {
  const { agentEngine, configureAgentQueue } = options
  let resultNotifierBusy = false
  let supervisorBusy = false

  const runResultNotifierOnce = async (): Promise<void> => {
    if (resultNotifierBusy) return
    const bot = resolveLifecycleBot(ctx)
    if (!bot) return
    resultNotifierBusy = true
    try {
      const logger = ctx.logger('dongxuelian-ai')
      await notifyCompletedTasks({
        limit: 50,
        sender: createResourceResultSender({ bot, logger }),
      })
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`result notifier failed: ${getLifecycleErrorMessage(error)}`)
    } finally {
      resultNotifierBusy = false
    }
  }

  const runResourceSupervisorOnce = async (): Promise<void> => {
    if (supervisorBusy || !isResourceWorkerSupervisorEnabled()) return
    supervisorBusy = true
    try {
      runSupervisorOnce({ start: true, once: true })
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`resource worker supervisor failed: ${getLifecycleErrorMessage(error)}`)
    } finally {
      supervisorBusy = false
    }
  }

  ctx.on('ready', async () => {
    await loadRuntimeSettings(true)
    await loadConfig(true)
    await loadSkills()
    await loadSkillsContentCache()
    setThinkingEnabled((await readTextFile(THINKING_MODE_FILE).catch(() => '')).trim() === 'on')
    loadStickerCache()
    loadPersonaGroups()
    loadRepeatConfig()
    loadPersonaUsers()
    await loadRandomVoiceRateCache()
    restoreTodayCache()
    trimChannelRuntimeCaches()
    cleanupDailyStatsFiles().catch(error => ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${getLifecycleErrorMessage(error)}`))
    scheduleDailyStatsCleanup(ctx)
    scheduleExpressionHarvest(ctx)
    scheduleDailyPrecomputePlanning(ctx)
    try {
      const config = agentConfig.getAgentConfig()
      if (typeof configureAgentQueue === 'function') configureAgentQueue(config.queue || {})
      const bot = resolveLifecycleBot(ctx)
      const count = await agentCron.startCronScheduler({ bot, engine: agentEngine })
      if (config.cron?.enabled) ctx.logger('dongxuelian-ai').info(`agent cron scheduler restored ${count} task(s)`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`agent cron scheduler restore failed: ${getLifecycleErrorMessage(error)}`)
    }
    await runResourceSupervisorOnce()
    await runResultNotifierOnce()
    ctx.logger('dongxuelian-ai').info(`dongxuelian-ai ${PLUGIN_VERSION} loaded`)
  })

  const sensitiveTimer = setInterval(async () => {
    try {
      const enabled = await readJsonFile(POLITICAL_DETECT_FILE, [])
      if (Array.isArray(enabled)) {
        for (const channelKey of enabled) {
          analyzeChannelSensitive(channelKey).catch(error => ctx.logger('dongxuelian-ai').warn(`sensitive scan failed: ${getLifecycleErrorMessage(error)}`))
        }
      }
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`sensitive scan scheduler failed: ${getLifecycleErrorMessage(error)}`)
    }
  }, 1800000)

  const resultNotifierTimer = setInterval(() => {
    runResultNotifierOnce().catch(error => ctx.logger('dongxuelian-ai').warn(`result notifier tick failed: ${getLifecycleErrorMessage(error)}`))
  }, RESULT_NOTIFIER_INTERVAL_MS)
  if (resultNotifierTimer.unref) resultNotifierTimer.unref()

  const supervisorTimer = setInterval(() => {
    runResourceSupervisorOnce().catch(error => ctx.logger('dongxuelian-ai').warn(`resource supervisor tick failed: ${getLifecycleErrorMessage(error)}`))
  }, RESOURCE_SUPERVISOR_INTERVAL_MS)
  if (supervisorTimer.unref) supervisorTimer.unref()

  ctx.on('dispose', () => {
    clearInterval(sensitiveTimer)
    clearInterval(resultNotifierTimer)
    clearInterval(supervisorTimer)
    try { agentCron.stopCronScheduler() } catch (error) { ctx.logger('dongxuelian-ai').warn(`agent cron scheduler stop failed: ${getLifecycleErrorMessage(error)}`) }
    clearChannelQueues()
    clearRandomPendingState()
    clearStartupSchedulers()
  })
}

export = {
  restoreTodayCacheEntry,
  restoreTodayCache,
  registerPluginLifecycle,
}
