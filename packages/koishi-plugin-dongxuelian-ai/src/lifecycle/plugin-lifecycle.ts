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
  registerTaskCompletedCallback,
  unregisterTaskCompletedCallback,
} = require('../resource-workers/task-store') as typeof import('../resource-workers/task-store')
const {
  getTaskStatusDir,
} = require('../resource-workers/task-paths') as typeof import('../resource-workers/task-paths')
const {
  runSupervisorOnce,
  stopOwnedWorkerProcesses,
} = require('../resource-workers/worker-supervisor') as typeof import('../resource-workers/worker-supervisor')
const { collectProcessMetrics } = require('../resource-system/system-protection') as typeof import('../resource-system/system-protection')

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
  chat?: unknown
  retellAgentResult?: unknown
}

const RESULT_NOTIFIER_INTERVAL_MS = Math.max(5000, Math.min(120000, Number(process.env.RESOURCE_RESULT_NOTIFIER_INTERVAL_MS || 60000)))
const RESOURCE_SUPERVISOR_INTERVAL_MS = Math.max(10000, Math.min(300000, Number(process.env.RESOURCE_WORKER_SUPERVISOR_INTERVAL_MS || 30000)))
const RESOURCE_HOST_SAMPLE_INTERVAL_MS = Math.max(30000, Math.min(10 * 60 * 1000, Number(process.env.RESOURCE_HOST_SAMPLE_INTERVAL_MS || 30000)))
// fs.watch 去抖：worker 子进程写入 done 文件触发多次事件，合并到一次结果通知。
const DONE_WATCH_DEBOUNCE_MS = Math.max(50, Math.min(5000, Number(process.env.RESOURCE_DONE_WATCH_DEBOUNCE_MS || 300)))

interface FsWatcherLike {
  close(): void
  on?(event: 'error', handler: (error: unknown) => void): void
}

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
  const { configureAgentQueue, chat, retellAgentResult } = options
  const supervisorGeneration = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
        sender: createResourceResultSender({ bot, logger, ctx, chat, retellAgentResult }),
      })
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`result notifier failed: ${getLifecycleErrorMessage(error)}`)
    } finally {
      resultNotifierBusy = false
    }
  }

  // 任务完成事件驱动回调 - 立刻触发结果通知（同进程；worker 子进程内的完成不会经此路径）
  const onTaskCompleted = (_taskId: string): void => {
    runResultNotifierOnce().catch(error => ctx.logger('dongxuelian-ai').warn(`event-driven result notifier failed: ${getLifecycleErrorMessage(error)}`))
  }

  // 跨进程事件驱动：worker 子进程把任务文件写入 tasks/done/，主进程用 fs.watch 监听该目录，
  // 文件出现即触发结果通知。这是主路径（Linux 下走 inotify），轮询仅作纯兜底。
  let doneWatcher: FsWatcherLike | null = null
  let doneWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleWatchedNotify = (): void => {
    if (doneWatchDebounceTimer) return
    doneWatchDebounceTimer = setTimeout(() => {
      doneWatchDebounceTimer = null
      runResultNotifierOnce().catch(error => ctx.logger('dongxuelian-ai').warn(`watch-driven result notifier failed: ${getLifecycleErrorMessage(error)}`))
    }, DONE_WATCH_DEBOUNCE_MS)
    if (doneWatchDebounceTimer.unref) doneWatchDebounceTimer.unref()
  }

  const startDoneWatcher = (): void => {
    if (doneWatcher) return
    try {
      const doneDir = getTaskStatusDir('done')
      fsSync.mkdirSync(doneDir, { recursive: true })
      const watcher: FsWatcherLike = fsSync.watch(doneDir, { persistent: false }, (_eventType: string, fileName: string | null) => {
        // 只关心 .json 任务文件的出现/改动，忽略其它噪声事件。
        if (fileName && !String(fileName).endsWith('.json')) return
        scheduleWatchedNotify()
      })
      watcher.on?.('error', (error: unknown) => {
        ctx.logger('dongxuelian-ai').warn(`done watcher error, falling back to polling: ${getLifecycleErrorMessage(error)}`)
      })
      doneWatcher = watcher
      ctx.logger('dongxuelian-ai').info(`done dir watcher started: ${doneDir}`)
    } catch (error) {
      doneWatcher = null
      ctx.logger('dongxuelian-ai').warn(`failed to start done dir watcher, relying on polling fallback: ${getLifecycleErrorMessage(error)}`)
    }
  }

  const stopDoneWatcher = (): void => {
    if (doneWatchDebounceTimer) { clearTimeout(doneWatchDebounceTimer); doneWatchDebounceTimer = null }
    if (doneWatcher) { try { doneWatcher.close() } catch { /* watcher 已关闭 */ } doneWatcher = null }
  }

  const runResourceSupervisorOnce = async (): Promise<void> => {
    if (supervisorBusy || !isResourceWorkerSupervisorEnabled()) return
    supervisorBusy = true
    try {
      runSupervisorOnce({ start: true, once: true, generation: supervisorGeneration })
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
      const count = await agentCron.startCronScheduler({ bot })
      if (config.cron?.enabled) ctx.logger('dongxuelian-ai').info(`agent cron scheduler restored ${count} task(s)`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`agent cron scheduler restore failed: ${getLifecycleErrorMessage(error)}`)
    }
    await runResourceSupervisorOnce()
    collectProcessMetrics({ sampler: 'koishi-main', supervisorGeneration })
    await runResultNotifierOnce()
    registerTaskCompletedCallback(onTaskCompleted)
    startDoneWatcher()
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

  const hostSampleTimer = setInterval(() => {
    collectProcessMetrics({ sampler: 'koishi-main', supervisorGeneration })
  }, RESOURCE_HOST_SAMPLE_INTERVAL_MS)
  if (hostSampleTimer.unref) hostSampleTimer.unref()

  ctx.on('dispose', async () => {
    unregisterTaskCompletedCallback(onTaskCompleted)
    stopDoneWatcher()
    clearInterval(sensitiveTimer)
    clearInterval(resultNotifierTimer)
    clearInterval(supervisorTimer)
    clearInterval(hostSampleTimer)
    try { agentCron.stopCronScheduler() } catch (error) { ctx.logger('dongxuelian-ai').warn(`agent cron scheduler stop failed: ${getLifecycleErrorMessage(error)}`) }
    clearChannelQueues()
    clearRandomPendingState()
    clearStartupSchedulers()
    try {
      await stopOwnedWorkerProcesses()
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`resource worker dispose failed: ${getLifecycleErrorMessage(error)}`)
    }
  })
}

export = {
  restoreTodayCacheEntry,
  restoreTodayCache,
  registerPluginLifecycle,
}
