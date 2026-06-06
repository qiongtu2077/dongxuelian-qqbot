/* ==========================================================================
 * MODULE: channel-task-queue
 * 职责：按频道串行执行入口任务，并限制同频道排队/运行深度。
 * 边界：不注册 middleware、不发送消息、不读写 conversation；只接收调用方传入的任务函数。
 * 状态：持有频道队列 Promise 链、运行深度和等待深度 Map；dispose 时由调用方显式清理。
 * ========================================================================== */
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')

interface QueueOptions {
  ctx?: unknown
  maxQueueAgeMs?: number | string
}

const channelQueues: Map<string, Promise<void>> = new Map()
const channelQueueDepth: Map<string, number> = new Map()
const channelQueuedDepth: Map<string, number> = new Map()

function ignoreChannelQueueTaskFailure(error: unknown): void {
  void error
}

function enqueueForChannel(channelKey: string, fn: () => Promise<unknown> | unknown, maxDepth: number, options: QueueOptions = {}): boolean {
  const key = String(channelKey || '')
  const queuedDepth = channelQueuedDepth.get(key) || 0
  const runningDepth = channelQueueDepth.get(key) || 0
  if (queuedDepth + runningDepth >= maxDepth) {
    logDebug(options.ctx as Parameters<typeof logDebug>[0], 'queue', `reject queued task channel=${key} queued=${queuedDepth} running=${runningDepth} max=${maxDepth}`)
    return false
  }
  const enqueuedAt = Date.now()
  const maxQueueAgeMs = Math.max(1000, Number(options.maxQueueAgeMs || 45000))
  channelQueuedDepth.set(key, queuedDepth + 1)
  const existing = channelQueues.get(key) || Promise.resolve()
  const next = existing
    .then(() => {
      const qd = channelQueuedDepth.get(key) || 1
      if (qd <= 1) channelQueuedDepth.delete(key)
      else channelQueuedDepth.set(key, qd - 1)
      if (Date.now() - enqueuedAt > maxQueueAgeMs) {
        logDebug(options.ctx as Parameters<typeof logDebug>[0], 'queue', `drop stale queued task channel=${key} ageMs=${Date.now() - enqueuedAt}`)
        return
      }
      const depth = channelQueueDepth.get(key) || 0
      if (depth >= maxDepth) return
      channelQueueDepth.set(key, depth + 1)
      let timeoutHandle: NodeJS.Timeout
      const timeoutPromise = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('queue timeout (60s)')), 60000) })
      return Promise.race([fn(), timeoutPromise]).finally(() => {
        clearTimeout(timeoutHandle)
        const d = channelQueueDepth.get(key) || 1
        if (d <= 1) channelQueueDepth.delete(key)
        else channelQueueDepth.set(key, d - 1)
      })
    })
    .catch(ignoreChannelQueueTaskFailure)
    .then(() => {
      if (channelQueues.get(key) === next) channelQueues.delete(key)
    })
  channelQueues.set(key, next)
  return true
}

function clearChannelQueues(): void {
  channelQueues.clear()
  channelQueueDepth.clear()
  channelQueuedDepth.clear()
}

export = {
  enqueueForChannel,
  clearChannelQueues,
}
