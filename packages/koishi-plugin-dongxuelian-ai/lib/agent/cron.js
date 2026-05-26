/**
 * MODULE: Agent 定时自动化。
 * 职责: 持久化 cron 配置、计算下一次触发、执行 text/agent 两类任务。
 * 边界: 不绕过 Agent 队列、不直接改 Dashboard 配置、不支持秒级高频任务。
 * 状态: timers / runtime（模块级定时器，配置落盘）。
 */
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../core/constants')
const { getAgentConfig } = require('./config')

const CRON_FILE = path.join(DATA_DIR, 'agent-crons.json')
const MAX_CRON_FILE_BYTES = 512 * 1024
const MAX_HISTORY_ITEMS = 200
const MAX_TASK_HISTORY_ITEMS = 20
const DEFAULT_CRON_MAX_RUNTIME_MS = 90 * 1000
const timers = new Map()
let runtime = { bot: null, engine: null }
let cronWriteChain = Promise.resolve()
const runningCrons = new Set()

async function readCronFile() {
  try {
    const stat = await fsp.stat(CRON_FILE)
    if (!stat.isFile() || stat.size > MAX_CRON_FILE_BYTES) return { crons: [], history: [] }
    const data = JSON.parse((await fsp.readFile(CRON_FILE, 'utf8')).replace(/^\uFEFF/, ''))
    return { crons: Array.isArray(data.crons) ? data.crons : [], history: Array.isArray(data.history) ? data.history : [] }
  } catch {
    return { crons: [], history: [] }
  }
}

function normalizeCronFileData(next) {
  const crons = []
  for (const c of (Array.isArray(next.crons) ? next.crons : [])) {
    try { const n = normalizeCron(c); if (n) crons.push(n) } catch {}
  }
  return { crons, history: Array.isArray(next.history) ? next.history.slice(-MAX_HISTORY_ITEMS) : [] }
}

function enqueueCronFileUpdate(fn) {
  const task = cronWriteChain.catch(() => {}).then(fn)
  cronWriteChain = task.catch(() => {})
  return task
}

async function writeCronFile(next) {
  const data = normalizeCronFileData(next)
  await fsp.mkdir(path.dirname(CRON_FILE), { recursive: true })
  const tmp = CRON_FILE + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tmp, CRON_FILE)
  return data
}

async function saveCrons(next) {
  return enqueueCronFileUpdate(() => writeCronFile(next))
}

async function loadCrons() {
  return enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    return writeCronFile(data)
  })
}

function normalizeCron(cron = {}) {
  const id = String(cron.id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  if (!id) return null
  const mode = cron.mode === 'once' ? 'once' : 'cron'
  const schedule = String(cron.schedule || '').trim()
  const runAt = Number(cron.runAt || cron.dueAt || cron.nextRunAt || 0)
  if (mode === 'cron') validateCronSchedule(schedule)
  else if (!Number.isFinite(runAt) || runAt <= 0) throw new Error('once 任务需要 runAt')
  const status = ['pending', 'running', 'done', 'failed', 'cancelled', 'paused'].includes(cron.status) ? cron.status : (mode === 'once' ? 'pending' : 'active')
  const paused = status === 'paused' || cron.paused === true || cron.enabled === false && mode === 'cron'
  const taskKind = ['reminder', 'scheduled_text', 'scheduled_agent', 'file_agent'].includes(cron.taskKind)
    ? cron.taskKind
    : mode === 'once' && cron.type === 'text'
    ? 'reminder'
    : cron.type === 'text'
    ? 'scheduled_text'
    : 'scheduled_agent'
  const delivery = cron.delivery && typeof cron.delivery === 'object' && !Array.isArray(cron.delivery) ? cron.delivery : {}
  const contextPolicy = cron.contextPolicy && typeof cron.contextPolicy === 'object' && !Array.isArray(cron.contextPolicy) ? cron.contextPolicy : {}
  const runPolicy = cron.runPolicy && typeof cron.runPolicy === 'object' && !Array.isArray(cron.runPolicy) ? cron.runPolicy : {}
  const stats = cron.stats && typeof cron.stats === 'object' && !Array.isArray(cron.stats) ? cron.stats : {}
  const history = Array.isArray(cron.history) ? cron.history.slice(-MAX_TASK_HISTORY_ITEMS).map(item => ({
    at: Number(item?.at || 0),
    ok: !!item?.ok,
    result: String(item?.result || '').slice(0, 1000),
  })) : []
  return {
    id,
    title: String(cron.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    description: String(cron.description || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    taskKind,
    schedule,
    mode,
    type: cron.type === 'text' ? 'text' : 'agent',
    prompt: String(cron.prompt || '').slice(0, 4000),
    targetChannel: String(cron.targetChannel || '').slice(0, 120),
    targetUserId: String(cron.targetUserId || '').slice(0, 120),
    createdFrom: String(cron.createdFrom || '').slice(0, 40),
    enabled: !paused && cron.enabled !== false && status !== 'done' && status !== 'cancelled',
    status: paused ? 'paused' : status === 'running' ? 'pending' : status,
    timezone: String(cron.timezone || 'Asia/Shanghai').slice(0, 80),
    scheduleText: String(cron.scheduleText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    visibility: cron.visibility === 'private' ? 'private' : 'channel',
    delivery: {
      targetChannel: String(delivery.targetChannel || cron.targetChannel || '').slice(0, 120),
      targetUserId: String(delivery.targetUserId || cron.targetUserId || '').slice(0, 120),
      userRequested: delivery.userRequested !== false,
      quoteSource: false,
      silentOnNoResult: !!delivery.silentOnNoResult,
    },
    contextPolicy: {
      allowReadGroupContext: contextPolicy.allowReadGroupContext !== false,
      allowExternalTools: !!contextPolicy.allowExternalTools,
      anchorMessageIds: Array.isArray(contextPolicy.anchorMessageIds) ? contextPolicy.anchorMessageIds.map(item => String(item || '').slice(0, 120)).filter(Boolean).slice(0, 10) : [],
      fileAnchor: contextPolicy.fileAnchor && typeof contextPolicy.fileAnchor === 'object' && !Array.isArray(contextPolicy.fileAnchor) ? {
        messageId: String(contextPolicy.fileAnchor.messageId || '').slice(0, 120),
        fileName: String(contextPolicy.fileAnchor.fileName || '').slice(0, 240),
      } : null,
      allowedTools: Array.isArray(contextPolicy.allowedTools) ? contextPolicy.allowedTools.map(item => String(item || '').trim()).filter(Boolean).slice(0, 20) : [],
    },
    runPolicy: {
      maxRuntimeMs: Math.max(1000, Math.min(parseInt(runPolicy.maxRuntimeMs, 10) || DEFAULT_CRON_MAX_RUNTIME_MS, 10 * 60 * 1000)),
      allowOverlap: false,
      misfirePolicy: ['skip', 'run_once', 'reschedule'].includes(runPolicy.misfirePolicy) ? runPolicy.misfirePolicy : 'reschedule',
    },
    createdBy: String(cron.createdBy || '').slice(0, 120),
    createdAt: Number(cron.createdAt || Date.now()),
    updatedAt: Date.now(),
    lastRunAt: Number(cron.lastRunAt || 0),
    runAt: mode === 'once' ? runAt : 0,
    nextRunAt: mode === 'once' ? runAt : Number(cron.nextRunAt || 0),
    stats: {
      runCount: Math.max(0, parseInt(stats.runCount, 10) || 0),
      failCount: Math.max(0, parseInt(stats.failCount, 10) || 0),
      lastError: String(stats.lastError || '').slice(0, 500),
      lastResultPreview: String(stats.lastResultPreview || '').slice(0, 500),
    },
    history,
  }
}

function parseCronField(field, min, max) {
  const value = String(field || '').trim()
  if (value === '*') return null
  if (value.includes('-')) throw new Error('cron 暂不支持范围语法')
  if (/^\*\/\d+$/.test(value)) {
    const step = parseInt(value.slice(2), 10)
    if (!Number.isFinite(step) || step < 10 && max === 59) throw new Error('cron 最小间隔为 10 分钟')
    return { step }
  }
  const values = value.split(',').map(item => item.trim()).filter(Boolean)
  if (!values.length) throw new Error('cron 字段不能为空')
  const parsed = []
  for (const item of values) {
    if (!/^\d+$/.test(item)) throw new Error('cron 字段仅支持数字、逗号列表、* 和 */步长')
    const number = parseInt(item, 10)
    if (!Number.isFinite(number) || number < min || number > max) throw new Error('cron 字段超出范围')
    const normalized = max === 7 && number === 7 ? 0 : number
    if (!parsed.includes(normalized)) parsed.push(normalized)
  }
  return { values: parsed }
}

function validateCronSchedule(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/)
  if (parts[0] === '*') throw new Error('cron minimum interval is 10 minutes')
  if (parts.length !== 5) throw new Error('cron 仅支持五字段格式：分 时 日 月 周')
  parseCronField(parts[0], 0, 59)
  parseCronField(parts[1], 0, 23)
  parseCronField(parts[2], 1, 31)
  parseCronField(parts[3], 1, 12)
  parseCronField(parts[4], 0, 7)
  return true
}

function cronMatches(date, schedule) {
  const parts = schedule.split(/\s+/)
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  return parts.every((field, index) => {
    const rule = parseCronField(field, index === 0 ? 0 : index === 1 ? 0 : index === 4 ? 0 : 1, index === 0 ? 59 : index === 1 ? 23 : index === 2 ? 31 : index === 3 ? 12 : 7)
    if (!rule) return true
    if (rule.step) return values[index] % rule.step === 0
    return rule.values.includes(values[index])
  })
}

function getNextRunAt(schedule, from = Date.now()) {
  validateCronSchedule(schedule)
  const start = Math.ceil((from + 60000) / 60000) * 60000
  const max = start + 370 * 24 * 60 * 60 * 1000
  for (let ts = start; ts <= max; ts += 60000) {
    const date = new Date(ts)
    if (cronMatches(date, schedule)) return ts
  }
  throw new Error('无法计算下一次 cron 触发时间')
}

function createCronId(prefix = 'task') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function appendHistory(entry) {
  return enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    data.history.push({ at: Date.now(), ...entry })
    data.history = data.history.slice(-MAX_HISTORY_ITEMS)
    return writeCronFile(data)
  })
}

async function registerCron(cron) {
  const normalized = normalizeCron(cron)
  const saved = await enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    data.crons = data.crons.filter(item => item.id !== normalized.id)
    normalized.nextRunAt = normalized.mode === 'once' ? normalized.runAt : getNextRunAt(normalized.schedule)
    data.crons.push(normalized)
    return writeCronFile(data)
  })
  scheduleCron(normalized)
  return saved.crons.find(item => item.id === normalized.id)
}

async function getCron(id) {
  const data = await loadCrons()
  return data.crons.find(item => item.id === id) || null
}

async function registerOnceTask(task = {}) {
  const runAt = Number(task.runAt || task.dueAt || 0)
  if (!Number.isFinite(runAt) || runAt <= Date.now() - 1000) throw new Error('提醒时间无效')
  const rawId = task.id || `once_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return registerCron({
    ...task,
    id: rawId,
    mode: 'once',
    type: task.type || 'text',
    runAt,
    nextRunAt: runAt,
    status: 'pending',
    enabled: true,
  })
}

async function unregisterCron(id) {
  const removed = await enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    const before = data.crons.length
    data.crons = data.crons.filter(item => item.id !== id)
    await writeCronFile(data)
    return before - data.crons.length
  })
  if (removed) clearCronTimer(id)
  return removed
}

async function updateCron(id, patch = {}) {
  const saved = await enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    const index = data.crons.findIndex(item => item.id === id)
    if (index < 0) return writeCronFile(data)
    const current = normalizeCron(data.crons[index])
    const next = normalizeCron({ ...current, ...patch, id: current.id, updatedAt: Date.now() })
    if (next.mode === 'cron' && (!next.nextRunAt || patch.schedule)) next.nextRunAt = getNextRunAt(next.schedule)
    data.crons[index] = next
    return writeCronFile(data)
  })
  const cron = saved.crons.find(item => item.id === id) || null
  if (cron) scheduleCron(cron)
  return cron
}

async function pauseCron(id) {
  const cron = await updateCron(id, { enabled: false, status: 'paused' })
  if (cron) clearCronTimer(id)
  return cron
}

async function resumeCron(id) {
  const current = await getCron(id)
  if (!current) return null
  const patch = { enabled: true, status: current.mode === 'once' ? 'pending' : 'active' }
  if (current.mode === 'cron') patch.nextRunAt = getNextRunAt(current.schedule)
  const cron = await updateCron(id, patch)
  if (cron) scheduleCron(cron)
  return cron
}

function clearCronTimer(id) {
  const timer = timers.get(String(id || ''))
  if (timer) clearTimeout(timer)
  timers.delete(String(id || ''))
}

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

function scheduleCron(cron) {
  clearCronTimer(cron.id)
  if (!cron.enabled) return
  const config = getAgentConfig()
  if (cron.mode === 'once') {
    if (config.cron?.onceEnabled === false) return
  } else if (!config.cron?.enabled) return
  const nextRunAt = cron.mode === 'once' ? (cron.runAt || cron.nextRunAt) : (cron.nextRunAt || getNextRunAt(cron.schedule))
  const now = Date.now()
  const delay = nextRunAt - now

  if (delay < -5000) {
    const policy = cron.runPolicy?.misfirePolicy || 'reschedule'
    if (policy === 'skip') {
      if (cron.mode !== 'once' && cron.schedule) {
        cron.nextRunAt = getNextRunAt(cron.schedule)
        scheduleCron(cron)
      }
      return
    }
    if (policy === 'reschedule' && cron.mode !== 'once' && cron.schedule) {
      cron.nextRunAt = getNextRunAt(cron.schedule)
      scheduleCron(cron)
      return
    }
  }

  const effectiveDelay = Math.max(1000, delay)
  if (effectiveDelay > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => scheduleCron(cron), MAX_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    timers.set(cron.id, timer)
    return
  }
  const timer = setTimeout(() => runCronNow(cron.id).catch(() => {}), effectiveDelay)
  if (timer.unref) timer.unref()
  timers.set(cron.id, timer)
}

async function runCronNow(id) {
  if (runningCrons.has(id)) return { ok: false, result: '定时任务正在运行，已跳过重入。' }
  runningCrons.add(id)
  const data = await readCronFile()
  const cron = data.crons.find(item => item.id === id)
  if (!cron) {
    runningCrons.delete(id)
    throw new Error('定时任务不存在')
  }
  let ok = false
  let result = ''
  try {
    await enqueueCronFileUpdate(async () => {
      const fresh = await readCronFile()
      const current = fresh.crons.find(item => item.id === cron.id)
      if (current) {
        current.status = 'running'
        current.updatedAt = Date.now()
      }
      return writeCronFile(fresh)
    })
    if (cron.type === 'text') {
      const push = require('./push')
      const sent = await push.cronResult({ cronId: cron.id, channelKey: cron.targetChannel, text: cron.prompt, bot: runtime.bot, bypassEnabled: cron.mode === 'once' })
      ok = !!sent.ok
      result = sent.message || 'text sent'
    } else {
      const queue = require('./queue')
      const engine = runtime.engine || require('./engine')
      const agentResult = await queue.enqueueAgentTask({
        channelKey: cron.targetChannel || 'cron',
        userId: cron.createdBy || cron.id,
        timeoutMs: cron.runPolicy?.maxRuntimeMs,
        fn: () => engine.run({
          userMessage: cron.prompt,
          userName: 'Cron',
          userId: cron.createdBy || cron.id,
          channelKey: cron.targetChannel || 'cron',
          channel: cron.targetChannel === 'dashboard' ? 'dashboard' : 'qq',
          scheduledTask: {
            id: cron.id,
            title: cron.title || cron.taskKind || 'scheduled task',
            mode: cron.mode,
            taskKind: cron.taskKind,
            contextPolicy: cron.contextPolicy || {},
          },
        }),
      })
      const push = require('./push')
      const sent = await push.cronResult({ cronId: cron.id, channelKey: cron.targetChannel, text: agentResult.reply, bot: runtime.bot, bypassEnabled: cron.mode === 'once' })
      ok = !!sent.ok
      result = agentResult.reply || sent.message || ''
    }
  } catch (error) {
    result = error.message || String(error)
  }
  const finishedAt = Date.now()
  let nextCron = cron.mode === 'once'
    ? { ...cron, lastRunAt: finishedAt, enabled: false, status: ok ? 'done' : 'failed' }
    : { ...cron, lastRunAt: finishedAt, nextRunAt: getNextRunAt(cron.schedule, finishedAt) }
  let shouldSchedule = true
  try {
    const savedCron = await enqueueCronFileUpdate(async () => {
      const fresh = await readCronFile()
      const current = fresh.crons.find(item => item.id === cron.id)
        if (current) {
          current.lastRunAt = finishedAt
          current.stats = current.stats || {}
          current.stats.runCount = Math.max(0, parseInt(current.stats.runCount, 10) || 0) + 1
          current.stats.failCount = Math.max(0, parseInt(current.stats.failCount, 10) || 0) + (ok ? 0 : 1)
          current.stats.lastError = ok ? '' : String(result || '').slice(0, 500)
          current.stats.lastResultPreview = String(result || '').slice(0, 500)
          current.history = Array.isArray(current.history) ? current.history : []
          current.history.push({ at: finishedAt, ok, result: String(result || '').slice(0, 1000) })
          current.history = current.history.slice(-MAX_TASK_HISTORY_ITEMS)
          if (current.mode === 'once') {
            current.enabled = false
            current.status = ok ? 'done' : 'failed'
            current.updatedAt = finishedAt
          } else {
            current.status = current.enabled === false ? 'paused' : 'active'
            current.nextRunAt = getNextRunAt(current.schedule, finishedAt)
          }
          nextCron = current
      } else {
        shouldSchedule = false
      }
      fresh.history.push({ at: finishedAt, id: cron.id, mode: cron.mode || 'cron', ok, result: String(result || '').slice(0, 1000) })
      fresh.history = fresh.history.slice(-MAX_HISTORY_ITEMS)
      await writeCronFile(fresh)
      return current || null
    })
    if (!savedCron) shouldSchedule = false
  } catch {
    shouldSchedule = true
  } finally {
    if (shouldSchedule && nextCron.mode !== 'once') scheduleCron(nextCron)
    else clearCronTimer(cron.id)
    runningCrons.delete(id)
  }
  return { ok, cron: nextCron, result }
}

async function listCronHistory(limit = 50) {
  const data = await readCronFile()
  return data.history.slice(-Math.max(1, Math.min(100, parseInt(limit, 10) || 50))).reverse()
}

async function startCronScheduler(options = {}) {
  runtime = { ...runtime, ...options }
  stopCronScheduler()
  const data = await loadCrons()
  for (const cron of data.crons) scheduleCron(cron)
  return data.crons.length
}

function stopCronScheduler() {
  for (const id of Array.from(timers.keys())) clearCronTimer(id)
}

module.exports = {
  CRON_FILE,
  loadCrons,
  saveCrons,
  registerCron,
  getCron,
  registerOnceTask,
  unregisterCron,
  updateCron,
  pauseCron,
  resumeCron,
  runCronNow,
  listCronHistory,
  startCronScheduler,
  stopCronScheduler,
  getNextRunAt,
  validateCronSchedule,
  parseCronField,
  cronMatches,
  appendHistory,
  createCronId,
}
