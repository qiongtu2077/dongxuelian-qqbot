/**
 * MODULE: Agent 队列调度。
 * 职责: 管理 Agent 长任务的 per-user 串行、频道深度和全局并发。
 * 边界: 不调用模型、不发送 QQ 消息、不修改普通聊天队列。
 * 状态: activeCount / taskQueues / activeKeys / counters（模块级运行时状态）。
 */

interface QueueOptions {
  maxGlobal: number
  maxPerChannel: number
  maxPendingPerUser: number
  timeoutMs: number
}

interface QueueTask {
  key: string
  channelKey: string
  userId: string
  fn: () => Promise<unknown> | unknown
  timeoutMs: number
  createdAt: number
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface EnqueueAgentTaskOptions {
  channelKey?: unknown
  userId?: unknown
  fn?: () => Promise<unknown> | unknown
  timeoutMs?: unknown
  maxDepth?: unknown
}

type QueueOptionsInput = Partial<QueueOptions>

interface QueueError extends Error {
  code?: string
}

interface AgentQueueStats {
  options: QueueOptions
  activeCount: number
  waitingCount: number
  queuedCount: number
  completedCount: number
  rejectedCount: number
  timeoutCount: number
  lastError: string
  byChannel: Record<string, number>
  activeKeys: string[]
}

const DEFAULT_OPTIONS: QueueOptions = Object.freeze({
  maxGlobal: 3,
  maxPerChannel: 3,
  maxPendingPerUser: 1,
  timeoutMs: 90000,
}) as QueueOptions

let options: QueueOptions = { ...DEFAULT_OPTIONS }
let activeCount = 0
let completedCount = 0
let rejectedCount = 0
let timeoutCount = 0
let lastError = ''

const taskQueues: Map<string, QueueTask[]> = new Map()
const activeKeys: Set<string> = new Set()
const channelDepth: Map<string, number> = new Map()

function normalizeKey(value: unknown, fallback: string = 'unknown'): string {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || fallback
}

function getTaskKey(channelKey: unknown, userId: unknown): string {
  return `${normalizeKey(channelKey)}:${normalizeKey(userId)}`
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isQueueOptionsInput(value: unknown): value is QueueOptionsInput {
  return value !== null && typeof value === 'object'
}

function configureAgentQueue(nextOptions: unknown = {}): QueueOptions {
  const queueOptions = isQueueOptionsInput(nextOptions) ? nextOptions : {}
  const maxGlobal = parseInt(String(queueOptions.maxGlobal ?? ''), 10)
  const maxPerChannel = parseInt(String(queueOptions.maxPerChannel ?? ''), 10)
  const maxPendingPerUser = parseInt(String(queueOptions.maxPendingPerUser ?? ''), 10)
  const timeoutMs = parseInt(String(queueOptions.timeoutMs ?? ''), 10)
  options = {
    maxGlobal: Number.isFinite(maxGlobal) ? Math.max(1, Math.min(12, maxGlobal)) : options.maxGlobal,
    maxPerChannel: Number.isFinite(maxPerChannel) ? Math.max(1, Math.min(20, maxPerChannel)) : options.maxPerChannel,
    maxPendingPerUser: Number.isFinite(maxPendingPerUser) ? Math.max(0, Math.min(10, maxPendingPerUser)) : options.maxPendingPerUser,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(10 * 60 * 1000, timeoutMs)) : options.timeoutMs,
  }
  drainAgentQueues()
  return { ...options }
}

function getChannelDepth(channelKey: unknown): number {
  return channelDepth.get(normalizeKey(channelKey)) || 0
}

function incChannelDepth(channelKey: unknown): void {
  const key = normalizeKey(channelKey)
  channelDepth.set(key, getChannelDepth(key) + 1)
}

function decChannelDepth(channelKey: unknown): void {
  const key = normalizeKey(channelKey)
  const next = Math.max(0, getChannelDepth(key) - 1)
  if (next <= 0) channelDepth.delete(key)
  else channelDepth.set(key, next)
}

const { withTimeout } = require('../core/utils') as typeof import('../core/utils')

function rejectTask(task: QueueTask, reason: string): void {
  rejectedCount++
  task.reject(Object.assign(new Error(reason), { code: 'AGENT_QUEUE_REJECTED' }))
}

function startTask(task: QueueTask): void {
  activeCount++
  activeKeys.add(task.key)
  incChannelDepth(task.channelKey)
  withTimeout(task.fn, task.timeoutMs, { code: 'AGENT_QUEUE_TIMEOUT' })
    .then(result => {
      completedCount++
      task.resolve(result)
    })
    .catch((error: unknown) => {
      const queueError = error instanceof Error ? error as QueueError : null
      if (queueError && queueError.code === 'AGENT_QUEUE_TIMEOUT') timeoutCount++
      lastError = queueError && queueError.message ? queueError.message : String(error || '')
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

function drainAgentQueues(): void {
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

function enqueueAgentTask({ channelKey = 'unknown', userId = 'unknown', fn, timeoutMs, maxDepth }: EnqueueAgentTaskOptions = {}): Promise<unknown> {
  if (typeof fn !== 'function') return Promise.reject(new Error('Agent 任务缺少 fn'))
  const key = getTaskKey(channelKey, userId)
  const queue = taskQueues.get(key) || []
  const activeForUser = activeKeys.has(key) ? 1 : 0
  const pendingForUser = Math.max(0, queue.length - activeForUser)
  const maxPending = isFiniteNumber(maxDepth) ? Math.max(0, maxDepth) : options.maxPendingPerUser
  if (pendingForUser >= maxPending) {
    rejectedCount++
    return Promise.reject(Object.assign(new Error('Agent 正在处理上一个工具任务，稍后再试。'), { code: 'AGENT_QUEUE_FULL' }))
  }
  const task: QueueTask = {
    key,
    channelKey: normalizeKey(channelKey),
    userId: normalizeKey(userId),
    fn,
    timeoutMs: isFiniteNumber(timeoutMs) ? Math.max(5000, Math.min(10 * 60 * 1000, timeoutMs)) : options.timeoutMs,
    createdAt: Date.now(),
    resolve: null as unknown as (value: unknown) => void,
    reject: null as unknown as (error: unknown) => void,
  }
  const promise = new Promise<unknown>((resolve, reject) => {
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

function clearAgentQueue(channelKey: unknown = 'unknown', userId: unknown = 'unknown'): number {
  const key = getTaskKey(channelKey, userId)
  const queue = taskQueues.get(key)
  if (!queue) return 0
  let removed = 0
  const keep: QueueTask[] = []
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

function getAgentQueueStats(): AgentQueueStats {
  const queued = Array.from(taskQueues.values()).reduce((sum, queue) => sum + queue.length, 0)
  const waiting = Math.max(0, queued - activeCount)
  const byChannel: Record<string, number> = {}
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

function resetAgentQueueForTests(): void {
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

export = {
  enqueueAgentTask,
  getAgentQueueStats,
  clearAgentQueue,
  configureAgentQueue,
  withTimeout,
  resetAgentQueueForTests,
}
