/**
 * MODULE: Agent 主动推送。
 * 职责: 受配置和限频约束发送计划/cron/告警结果，并写审计日志。
 * 边界: 不创建计划、不调度 cron、不绕过 bot 发送接口权限。
 * 状态: quotaCache（按天/频道的运行时计数，日志落盘）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { truncateText: coreTruncateText } = require('../core/utils') as typeof import('../core/utils')
const { getAgentConfig } = require('./config') as typeof import('./config')

const PUSH_LOG_FILE: string = path.join(DATA_DIR, 'agent-push-log.jsonl')
const MAX_PUSH_LOG_READ_BYTES = 512 * 1024
const MAX_PUSH_LOG_FILE_BYTES = 2 * 1024 * 1024
const quotaCache: Map<string, number> = new Map()
let pushLogWriteChain: Promise<unknown> = Promise.resolve()
const quotaOperationChains: Map<string, Promise<unknown>> = new Map()

interface PushLogEntry {
  at: number
  channelKey: string
  reason: string
  length: number
  preview: string
  bypassEnabled: boolean
  ok: boolean
  error: string
}

interface PushQuota {
  key: string
  used: number
  limit: number
  remaining: number
}

interface PushResult {
  ok: boolean
  message?: string
  quota?: PushQuota
  personalized?: boolean
}

interface SendOptions {
  channelKey?: unknown
  text?: unknown
  bot?: BotLike | null
  personalize?: boolean
  reason?: unknown
  bypassEnabled?: boolean
}

interface SendToAdminOptions {
  text?: unknown
  bot?: BotLike | null
  reason?: unknown
}

interface TaskCompleteOptions {
  planId?: unknown
  channelKey?: unknown
  summary?: unknown
  bot?: BotLike | null
}

interface CronResultOptions {
  cronId?: unknown
  channelKey?: unknown
  text?: unknown
  bot?: BotLike | null
  bypassEnabled?: boolean
}

interface BotLike {
  sendPrivateMessage?: (userId: string, content: string) => Promise<unknown> | unknown
  sendMessage?: (target: string, content: string) => Promise<unknown> | unknown
  internal?: {
    sendPrivateMsg?: (userId: string, segments: unknown[]) => Promise<unknown> | unknown
    sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown
  }
}

interface PushLogLine {
  ok?: boolean
  bypassEnabled?: boolean
  channelKey?: unknown
  at?: unknown
  [key: string]: unknown
}

function getPushErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (message) return String(message)
  }
  return String(error)
}

function todayKey(now: number = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function quotaKey(channelKey: unknown, now: number = Date.now()): string {
  return `${todayKey(now)}:${String(channelKey || 'unknown')}`
}

function cleanupStaleQuotaCache(day: string): void {
  for (const [k] of quotaCache) { if (!k.startsWith(day + ':')) quotaCache.delete(k) }
}

function ignorePushQueueFailure(error: unknown): void {
  void error
}

function enqueueQuotaOperation<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = quotaOperationChains.get(key) || Promise.resolve()
  const run = previous.catch(ignorePushQueueFailure).then(fn) as Promise<T>
  quotaOperationChains.set(key, run)
  run.finally(() => {
    if (quotaOperationChains.get(key) === run) quotaOperationChains.delete(key)
  }).catch(ignorePushQueueFailure)
  return run
}

function parsePushLogLine(line: string): PushLogLine | null {
  try { return JSON.parse(line) } catch { /* non-critical: corrupt push log line is ignored during quota scan */ return null }
}

async function countLoggedQuota(channelKey: unknown, now: number = Date.now()): Promise<number> {
  const day = todayKey(now)
  const target = String(channelKey || 'unknown')
  cleanupStaleQuotaCache(day)
  try {
    const stat = await fsp.stat(PUSH_LOG_FILE)
    if (!stat.isFile()) return 0
    const readBytes = Math.min(stat.size, MAX_PUSH_LOG_READ_BYTES)
    const buffer = Buffer.alloc(readBytes)
    const fd = await fsp.open(PUSH_LOG_FILE, 'r')
    let bytesRead = 0
    try {
      const result = await fd.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes))
      bytesRead = result.bytesRead || 0
    } finally {
      await fd.close()
    }
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter(Boolean)
    let count = 0
    for (const line of lines) {
      const entry = parsePushLogLine(line)
      if (!entry || !entry.ok || entry.bypassEnabled || String(entry.channelKey || '') !== target) continue
      if (todayKey(Number(entry.at || 0)) === day) count++
    }
    return count
  } catch { /* non-critical: unreadable push log treats used quota as 0 and future sends still audit */
    return 0
  }
}

function truncateText(text: unknown = '', max: number = 800): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : coreTruncateText(value, max - 3) + '...'
}

async function appendLog(entry: PushLogEntry): Promise<unknown> {
  const run = pushLogWriteChain.catch(ignorePushQueueFailure).then(async () => {
    await fsp.mkdir(path.dirname(PUSH_LOG_FILE), { recursive: true })
    await fsp.appendFile(PUSH_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
    try {
      const stat = await fsp.stat(PUSH_LOG_FILE)
      if (stat.isFile() && stat.size > MAX_PUSH_LOG_FILE_BYTES) {
        const fd = await fsp.open(PUSH_LOG_FILE, 'r')
        const keepBytes = Math.min(stat.size, MAX_PUSH_LOG_READ_BYTES)
        const buffer = Buffer.alloc(keepBytes)
        let bytesRead = 0
        try {
          const result = await fd.read(buffer, 0, keepBytes, Math.max(0, stat.size - keepBytes))
          bytesRead = result.bytesRead || 0
        } finally {
          await fd.close()
        }
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const firstNewline = text.indexOf('\n')
        const trimmed = firstNewline >= 0 ? text.slice(firstNewline + 1) : text
        await fsp.writeFile(PUSH_LOG_FILE, trimmed || text, 'utf8')
      }
    } catch (error) {
      console.warn(`[agent-push] push_log_compaction_failed detail=${error instanceof Error ? error.message : String(error || 'unknown error')}`)
    }
  })
  pushLogWriteChain = run.catch(ignorePushQueueFailure)
  return run
}

async function getQuota(channelKey: unknown, now: number = Date.now()): Promise<PushQuota> {
  const config = getAgentConfig()
  const limit = Math.max(0, parseInt(String(config.push?.dailyLimit), 10) || 0)
  const key = quotaKey(channelKey, now)
  cleanupStaleQuotaCache(todayKey(now))
  if (!quotaCache.has(key)) quotaCache.set(key, await countLoggedQuota(channelKey, now))
  const used = quotaCache.get(key) || 0
  return { key, used, limit, remaining: Math.max(0, limit - used) }
}

async function sendBotMessage(bot: BotLike | null | undefined, target: unknown, content: string): Promise<unknown> {
  const targetText = String(target || '')
  if (!bot) throw new Error('bot sendMessage 不可用')
  if (/^private:/.test(targetText)) {
    const userId = targetText.slice('private:'.length)
    if (typeof bot.sendPrivateMessage === 'function') return bot.sendPrivateMessage(userId, content)
    if (bot.internal && typeof bot.internal.sendPrivateMsg === 'function') {
      return bot.internal.sendPrivateMsg(userId, [{ type: 'text', data: { text: content } }])
    }
    throw new Error('bot private send 不可用')
  }
  if (typeof bot.sendMessage === 'function') return bot.sendMessage(targetText, content)
  if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    return bot.internal.sendGroupMsg(targetText, [{ type: 'text', data: { text: content } }])
  }
  throw new Error('bot sendMessage 不可用')
}

async function send({ channelKey, text, bot, personalize = true, reason = 'manual', bypassEnabled = false }: SendOptions = {}): Promise<PushResult> {
  const config = getAgentConfig()
  const target = String(channelKey || '').trim()
  const content = String(text || '').trim()
  const logEntry: PushLogEntry = {
    at: Date.now(),
    channelKey: target,
    reason: String(reason || 'manual').slice(0, 80),
    length: content.length,
    preview: truncateText(content, 300),
    bypassEnabled: !!bypassEnabled,
    ok: false,
    error: '',
  }
  if (!bypassEnabled && !config.push?.enabled) {
    logEntry.error = 'push disabled'
    await appendLog(logEntry)
    return { ok: false, message: 'Agent 主动推送未开启。' }
  }
  if (!target || !content) {
    logEntry.error = 'missing channel/text'
    await appendLog(logEntry)
    return { ok: false, message: '推送目标或内容为空。' }
  }
  return enqueueQuotaOperation(quotaKey(target), async () => {
    const quota = await getQuota(target)
    if (!bypassEnabled && (quota.limit <= 0 || quota.used >= quota.limit)) {
      logEntry.error = 'quota exceeded'
      await appendLog(logEntry)
      return { ok: false, message: '今日 Agent 主动推送额度已用完。', quota }
    }
    try {
      await sendBotMessage(bot, target, content)
      if (!bypassEnabled) quotaCache.set(quota.key, quota.used + 1)
      logEntry.ok = true
      await appendLog(logEntry)
      return { ok: true, quota: await getQuota(target), personalized: !!personalize }
    } catch (error) {
      logEntry.error = getPushErrorMessage(error).slice(0, 300)
      await appendLog(logEntry)
      return { ok: false, message: logEntry.error, quota }
    }
  })
}

async function sendToAdmin({ text, bot, reason = 'admin' }: SendToAdminOptions = {}): Promise<unknown[]> {
  const { getAdminUserIds } = require('../core/runtime-config') as typeof import('../core/runtime-config')
  const admins = Array.from(getAdminUserIds(true))
  const results: unknown[] = []
  for (const id of admins) {
    if (bot && typeof bot.sendPrivateMessage === 'function') {
      try {
        await bot.sendPrivateMessage(id, String(text || ''))
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, message: getPushErrorMessage(error) })
      }
    } else {
      results.push(await send({ channelKey: `private:${id}`, text, bot, reason }))
    }
  }
  return results
}

function buildTaskCompleteText(planId: unknown, summary: unknown): string {
  return String(summary || `计划 ${planId} 已完成。`).slice(0, 3000)
}

async function taskComplete({ planId, channelKey, summary, bot }: TaskCompleteOptions = {}): Promise<PushResult> {
  return send({ channelKey, text: buildTaskCompleteText(planId, summary), bot, reason: 'plan_complete' })
}

async function cronResult({ cronId, channelKey, text, bot, bypassEnabled = false }: CronResultOptions = {}): Promise<PushResult> {
  return send({ channelKey, text: String(text || `定时任务 ${cronId} 已执行。`), bot, reason: 'cron_result', bypassEnabled })
}

function listPushLog(limit: unknown = 50): unknown[] {
  try {
    const stat = fs.statSync(PUSH_LOG_FILE)
    if (!stat.isFile()) return []
    const fd = fs.openSync(PUSH_LOG_FILE, 'r')
    const readBytes = Math.min(stat.size, MAX_PUSH_LOG_READ_BYTES)
    const buffer = Buffer.alloc(readBytes)
    try { fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes)) }
    finally { fs.closeSync(fd) }
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(200, parseInt(String(limit), 10) || 50))).reverse().map(line => {
      try { return JSON.parse(line) } catch { /* non-critical: expose corrupt log line as raw text for diagnostics */ return { raw: line } }
    })
  } catch { /* non-critical: missing push log returns empty history */
    return []
  }
}

export = {
  PUSH_LOG_FILE,
  sendBotMessage,
  send,
  sendToAdmin,
  taskComplete,
  cronResult,
  getQuota,
  listPushLog,
}
