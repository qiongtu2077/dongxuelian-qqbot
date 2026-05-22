/**
 * MODULE: Agent 定时自动化。
 * 职责: 持久化 cron 配置、计算下一次触发、执行 text/agent 两类任务。
 * 边界: 不绕过 Agent 队列、不直接改 Dashboard 配置、不支持秒级高频任务。
 * 状态: timers / runtime（模块级定时器，配置落盘）。
 */
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../constants')
const { getAgentConfig } = require('./config')

const CRON_FILE = path.join(DATA_DIR, 'agent-crons.json')
const MAX_CRON_FILE_BYTES = 512 * 1024
const timers = new Map()
let runtime = { bot: null, engine: null }
let cronWriteChain = Promise.resolve()

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
  return { crons, history: Array.isArray(next.history) ? next.history.slice(-50) : [] }
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
  const schedule = String(cron.schedule || '').trim()
  validateCronSchedule(schedule)
  return {
    id,
    schedule,
    mode: 'cron',
    type: cron.type === 'text' ? 'text' : 'agent',
    prompt: String(cron.prompt || '').slice(0, 4000),
    targetChannel: String(cron.targetChannel || '').slice(0, 120),
    enabled: cron.enabled !== false,
    createdBy: String(cron.createdBy || '').slice(0, 120),
    createdAt: Number(cron.createdAt || Date.now()),
    updatedAt: Date.now(),
    lastRunAt: Number(cron.lastRunAt || 0),
    nextRunAt: Number(cron.nextRunAt || 0),
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

async function appendHistory(entry) {
  return enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    data.history.push({ at: Date.now(), ...entry })
    data.history = data.history.slice(-50)
    return writeCronFile(data)
  })
}

async function registerCron(cron) {
  const normalized = normalizeCron(cron)
  const saved = await enqueueCronFileUpdate(async () => {
    const data = await readCronFile()
    data.crons = data.crons.filter(item => item.id !== normalized.id)
    normalized.nextRunAt = getNextRunAt(normalized.schedule)
    data.crons.push(normalized)
    return writeCronFile(data)
  })
  scheduleCron(normalized)
  return saved.crons.find(item => item.id === normalized.id)
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
  if (!config.cron?.enabled) return
  const nextRunAt = cron.nextRunAt || getNextRunAt(cron.schedule)
  const delay = Math.max(1000, nextRunAt - Date.now())
  if (delay > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => scheduleCron(cron), MAX_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    timers.set(cron.id, timer)
    return
  }
  const timer = setTimeout(() => runCronNow(cron.id).catch(() => {}), delay)
  if (timer.unref) timer.unref()
  timers.set(cron.id, timer)
}

async function runCronNow(id) {
  const data = await readCronFile()
  const cron = data.crons.find(item => item.id === id)
  if (!cron) throw new Error('定时任务不存在')
  let ok = false
  let result = ''
  try {
    if (cron.type === 'text') {
      const push = require('./push')
      const sent = await push.cronResult({ cronId: cron.id, channelKey: cron.targetChannel, text: cron.prompt, bot: runtime.bot })
      ok = !!sent.ok
      result = sent.message || 'text sent'
    } else {
      const queue = require('./queue')
      const engine = runtime.engine || require('./engine')
      const agentResult = await queue.enqueueAgentTask({
        channelKey: cron.targetChannel || 'cron',
        userId: cron.createdBy || cron.id,
        fn: () => engine.run({
          userMessage: cron.prompt,
          userName: 'Cron',
          userId: cron.createdBy || cron.id,
          channelKey: cron.targetChannel || 'cron',
          channel: cron.targetChannel === 'dashboard' ? 'dashboard' : 'qq',
        }),
      })
      const push = require('./push')
      const sent = await push.cronResult({ cronId: cron.id, channelKey: cron.targetChannel, text: agentResult.reply, bot: runtime.bot })
      ok = !!sent.ok
      result = agentResult.reply || sent.message || ''
    }
  } catch (error) {
    result = error.message || String(error)
  }
  const finishedAt = Date.now()
  let nextCron = { ...cron, lastRunAt: finishedAt, nextRunAt: getNextRunAt(cron.schedule, finishedAt) }
  let shouldSchedule = true
  try {
    const savedCron = await enqueueCronFileUpdate(async () => {
      const fresh = await readCronFile()
      const current = fresh.crons.find(item => item.id === cron.id)
      if (current) {
        current.lastRunAt = finishedAt
        current.nextRunAt = getNextRunAt(current.schedule, finishedAt)
        nextCron = current
      } else {
        shouldSchedule = false
      }
      fresh.history.push({ at: finishedAt, id: cron.id, ok, result: String(result || '').slice(0, 1000) })
      fresh.history = fresh.history.slice(-50)
      await writeCronFile(fresh)
      return current || null
    })
    if (!savedCron) shouldSchedule = false
  } catch {
    shouldSchedule = true
  } finally {
    if (shouldSchedule) scheduleCron(nextCron)
    else clearCronTimer(cron.id)
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
  unregisterCron,
  runCronNow,
  listCronHistory,
  startCronScheduler,
  stopCronScheduler,
  getNextRunAt,
  validateCronSchedule,
  parseCronField,
  cronMatches,
  appendHistory,
}
