/**
 * MODULE: Agent 队列调度。
 * 职责: 管理 Agent 长任务的 per-user 串行、频道深度和全局并发。
 * 边界: 不调用模型、不发送 QQ 消息、不修改普通聊天队列。
 * 状态: activeCount / taskQueues / activeKeys / counters（模块级运行时状态）。
 */

const DEFAULT_OPTIONS = Object.freeze({
  maxGlobal: 3,
  maxPerChannel: 3,
  maxPendingPerUser: 1,
  timeoutMs: 90000,
})

let options = { ...DEFAULT_OPTIONS }
let activeCount = 0
let completedCount = 0
let rejectedCount = 0
let timeoutCount = 0
let lastError = ''

const taskQueues = new Map()
const activeKeys = new Set()
const channelDepth = new Map()

function normalizeKey(value, fallback = 'unknown') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || fallback
}

function getTaskKey(channelKey, userId) {
  return `${normalizeKey(channelKey)}:${normalizeKey(userId)}`
}

function configureAgentQueue(nextOptions = {}) {
  const maxGlobal = parseInt(nextOptions.maxGlobal, 10)
  const maxPerChannel = parseInt(nextOptions.maxPerChannel, 10)
  const maxPendingPerUser = parseInt(nextOptions.maxPendingPerUser, 10)
  const timeoutMs = parseInt(nextOptions.timeoutMs, 10)
  options = {
    maxGlobal: Number.isFinite(maxGlobal) ? Math.max(1, Math.min(12, maxGlobal)) : options.maxGlobal,
    maxPerChannel: Number.isFinite(maxPerChannel) ? Math.max(1, Math.min(20, maxPerChannel)) : options.maxPerChannel,
    maxPendingPerUser: Number.isFinite(maxPendingPerUser) ? Math.max(0, Math.min(10, maxPendingPerUser)) : options.maxPendingPerUser,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(10 * 60 * 1000, timeoutMs)) : options.timeoutMs,
  }
  drainAgentQueues()
  return { ...options }
}

function getChannelDepth(channelKey) {
  return channelDepth.get(normalizeKey(channelKey)) || 0
}

function incChannelDepth(channelKey) {
  const key = normalizeKey(channelKey)
  channelDepth.set(key, getChannelDepth(key) + 1)
}

function decChannelDepth(channelKey) {
  const key = normalizeKey(channelKey)
  const next = Math.max(0, getChannelDepth(key) - 1)
  if (next <= 0) channelDepth.delete(key)
  else channelDepth.set(key, next)
}

function withTimeout(fn, timeoutMs) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`agent task timeout (${timeoutMs}ms)`)
      error.code = 'AGENT_QUEUE_TIMEOUT'
      reject(error)
    }, timeoutMs)
    if (timeoutId.unref) timeoutId.unref()
  })
  return Promise.race([Promise.resolve().then(fn), timeoutPromise])
    .finally(() => { if (timeoutId) clearTimeout(timeoutId) })
}

function rejectTask(task, reason) {
  rejectedCount++
  task.reject(Object.assign(new Error(reason), { code: 'AGENT_QUEUE_REJECTED' }))
}

function startTask(task) {
  activeCount++
  activeKeys.add(task.key)
  incChannelDepth(task.channelKey)
  withTimeout(task.fn, task.timeoutMs)
    .then(result => {
      completedCount++
      task.resolve(result)
    })
    .catch(error => {
      if (error && error.code === 'AGENT_QUEUE_TIMEOUT') timeoutCount++
      lastError = error && error.message ? error.message : String(error || '')
      task.reject(error)
    })
    .finally(() => {
      activeCount = Math.max(0, activeCount - 1)
      decChannelDepth(task.channelKey)
      const queue = taskQueues.get(task.key)
      if (queue && queue[0] === task) queue.shift()
      if (queue && queue.length === 0) taskQueues.delete(task.key)
      activeKeys.delete(task.key)
      drainAgentQueues()
    })
}

function drainAgentQueues() {
  if (activeCount >= options.maxGlobal) return
  const queues = Array.from(taskQueues.values())
    .filter(queue => queue.length > 0 && !activeKeys.has(queue[0].key))
    .sort((a, b) => a[0].createdAt - b[0].createdAt)
  for (const queue of queues) {
    if (activeCount >= options.maxGlobal) return
    const task = queue[0]
    if (getChannelDepth(task.channelKey) >= options.maxPerChannel) continue
    startTask(task)
  }
}

function enqueueAgentTask({ channelKey = 'unknown', userId = 'unknown', fn, timeoutMs, maxDepth } = {}) {
  if (typeof fn !== 'function') return Promise.reject(new Error('Agent 任务缺少 fn'))
  const key = getTaskKey(channelKey, userId)
  const queue = taskQueues.get(key) || []
  const activeForUser = activeKeys.has(key) ? 1 : 0
  const pendingForUser = Math.max(0, queue.length - activeForUser)
  const maxPending = Number.isFinite(maxDepth) ? Math.max(0, maxDepth) : options.maxPendingPerUser
  if (pendingForUser >= maxPending) {
    rejectedCount++
    return Promise.reject(Object.assign(new Error('Agent 正在处理上一个工具任务，稍后再试。'), { code: 'AGENT_QUEUE_FULL' }))
  }
  const task = {
    key,
    channelKey: normalizeKey(channelKey),
    userId: normalizeKey(userId),
    fn,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(10 * 60 * 1000, timeoutMs)) : options.timeoutMs,
    createdAt: Date.now(),
    resolve: null,
    reject: null,
  }
  const promise = new Promise((resolve, reject) => {
    task.resolve = resolve
    task.reject = reject
  })
  queue.push(task)
  taskQueues.set(key, queue)

  if (getChannelDepth(task.channelKey) + queue.length > options.maxPerChannel + maxPending) {
    queue.pop()
    if (!queue.length) taskQueues.delete(key)
    rejectTask(task, '当前频道 Agent 队列已满，请稍后再试。')
    return promise
  }

  drainAgentQueues()
  return promise
}

function clearAgentQueue(channelKey = 'unknown', userId = 'unknown') {
  const key = getTaskKey(channelKey, userId)
  const queue = taskQueues.get(key)
  if (!queue) return 0
  let removed = 0
  const keep = []
  for (const task of queue) {
    if (activeKeys.has(task.key) && queue[0] === task) {
      keep.push(task)
      continue
    }
    removed++
    rejectTask(task, 'Agent 队列已清理。')
  }
  if (keep.length) taskQueues.set(key, keep)
  else taskQueues.delete(key)
  return removed
}

function getAgentQueueStats() {
  const queued = Array.from(taskQueues.values()).reduce((sum, queue) => sum + queue.length, 0)
  const waiting = Math.max(0, queued - activeCount)
  const byChannel = {}
  for (const queue of taskQueues.values()) {
    for (const task of queue) byChannel[task.channelKey] = (byChannel[task.channelKey] || 0) + 1
  }
  return {
    options: { ...options },
    activeCount,
    waitingCount: waiting,
    queuedCount: queued,
    completedCount,
    rejectedCount,
    timeoutCount,
    lastError,
    byChannel,
    activeKeys: Array.from(activeKeys),
  }
}

function resetAgentQueueForTests() {
  for (const queue of taskQueues.values()) {
    for (const task of queue) {
      if (!activeKeys.has(task.key)) rejectTask(task, 'Agent 队列已重置。')
    }
  }
  taskQueues.clear()
  activeKeys.clear()
  channelDepth.clear()
  activeCount = 0
  completedCount = 0
  rejectedCount = 0
  timeoutCount = 0
  lastError = ''
  options = { ...DEFAULT_OPTIONS }
}

module.exports = {
  enqueueAgentTask,
  getAgentQueueStats,
  clearAgentQueue,
  configureAgentQueue,
  resetAgentQueueForTests,
}
