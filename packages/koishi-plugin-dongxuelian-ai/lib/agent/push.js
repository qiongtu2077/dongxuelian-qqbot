/**
 * MODULE: Agent 主动推送。
 * 职责: 受配置和限频约束发送计划/cron/告警结果，并写审计日志。
 * 边界: 不创建计划、不调度 cron、不绕过 bot 发送接口权限。
 * 状态: quotaCache（按天/频道的运行时计数，日志落盘）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../constants')
const { getAgentConfig } = require('./config')

const PUSH_LOG_FILE = path.join(DATA_DIR, 'agent-push-log.jsonl')
const MAX_PUSH_LOG_READ_BYTES = 512 * 1024
const MAX_PUSH_LOG_FILE_BYTES = 2 * 1024 * 1024
const quotaCache = new Map()
let pushLogWriteChain = Promise.resolve()
const quotaOperationChains = new Map()

function todayKey(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function quotaKey(channelKey, now = Date.now()) {
  return `${todayKey(now)}:${String(channelKey || 'unknown')}`
}

function cleanupStaleQuotaCache(day) {
  for (const [k] of quotaCache) { if (!k.startsWith(day + ':')) quotaCache.delete(k) }
}

function enqueueQuotaOperation(key, fn) {
  const previous = quotaOperationChains.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  quotaOperationChains.set(key, run)
  run.finally(() => {
    if (quotaOperationChains.get(key) === run) quotaOperationChains.delete(key)
  }).catch(() => {})
  return run
}

async function countLoggedQuota(channelKey, now = Date.now()) {
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
      let entry = null
      try { entry = JSON.parse(line) } catch {}
      if (!entry || !entry.ok || entry.bypassEnabled || String(entry.channelKey || '') !== target) continue
      if (todayKey(Number(entry.at || 0)) === day) count++
    }
    return count
  } catch {
    return 0
  }
}

function truncateText(text = '', max = 800) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : value.slice(0, max - 3) + '...'
}

async function appendLog(entry) {
  const run = pushLogWriteChain.catch(() => {}).then(async () => {
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
    } catch {}
  })
  pushLogWriteChain = run.catch(() => {})
  return run
}

async function getQuota(channelKey, now = Date.now()) {
  const config = getAgentConfig()
  const limit = Math.max(0, parseInt(config.push?.dailyLimit, 10) || 0)
  const key = quotaKey(channelKey, now)
  cleanupStaleQuotaCache(todayKey(now))
  if (!quotaCache.has(key)) quotaCache.set(key, await countLoggedQuota(channelKey, now))
  const used = quotaCache.get(key) || 0
  return { key, used, limit, remaining: Math.max(0, limit - used) }
}

async function sendBotMessage(bot, target, content) {
  if (!bot) throw new Error('bot sendMessage 不可用')
  if (typeof bot.sendMessage === 'function') return bot.sendMessage(target, content)
  if (/^private:/.test(target)) {
    const userId = target.slice('private:'.length)
    if (typeof bot.sendPrivateMessage === 'function') return bot.sendPrivateMessage(userId, content)
    if (bot.internal && typeof bot.internal.sendPrivateMsg === 'function') {
      return bot.internal.sendPrivateMsg(userId, [{ type: 'text', data: { text: content } }])
    }
  } else if (bot.internal && typeof bot.internal.sendGroupMsg === 'function') {
    return bot.internal.sendGroupMsg(target, [{ type: 'text', data: { text: content } }])
  }
  throw new Error('bot sendMessage 不可用')
}

async function send({ channelKey, text, bot, personalize = true, reason = 'manual', bypassEnabled = false } = {}) {
  const config = getAgentConfig()
  const target = String(channelKey || '').trim()
  const content = String(text || '').trim()
  const logEntry = {
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
      logEntry.error = String(error.message || error).slice(0, 300)
      await appendLog(logEntry)
      return { ok: false, message: logEntry.error, quota }
    }
  })
}

async function sendToAdmin({ text, bot, reason = 'admin' } = {}) {
  const { getAdminUserIds } = require('../runtime-config')
  const admins = Array.from(getAdminUserIds(true))
  const results = []
  for (const id of admins) {
    if (bot && typeof bot.sendPrivateMessage === 'function') {
      try {
        await bot.sendPrivateMessage(id, String(text || ''))
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, message: error.message })
      }
    } else {
      results.push(await send({ channelKey: `private:${id}`, text, bot, reason }))
    }
  }
  return results
}

function buildTaskCompleteText(planId, summary) {
  return String(summary || `计划 ${planId} 已完成。`).slice(0, 3000)
}

async function taskComplete({ planId, channelKey, summary, bot } = {}) {
  return send({ channelKey, text: buildTaskCompleteText(planId, summary), bot, reason: 'plan_complete' })
}

async function cronResult({ cronId, channelKey, text, bot, bypassEnabled = false } = {}) {
  return send({ channelKey, text: String(text || `定时任务 ${cronId} 已执行。`), bot, reason: 'cron_result', bypassEnabled })
}

function listPushLog(limit = 50) {
  try {
    const stat = fs.statSync(PUSH_LOG_FILE)
    if (!stat.isFile()) return []
    const fd = fs.openSync(PUSH_LOG_FILE, 'r')
    const readBytes = Math.min(stat.size, MAX_PUSH_LOG_READ_BYTES)
    const buffer = Buffer.alloc(readBytes)
    try { fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes)) }
    finally { fs.closeSync(fd) }
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(200, parseInt(limit, 10) || 50))).reverse().map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  } catch {
    return []
  }
}

module.exports = {
  PUSH_LOG_FILE,
  sendBotMessage,
  send,
  sendToAdmin,
  taskComplete,
  cronResult,
  getQuota,
  listPushLog,
}
