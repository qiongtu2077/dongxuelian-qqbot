/** 同频道有界串行队列；外层超时绝不释放仍运行的所有者。 */
import { ChatTurnBudget, CHAT_TURN_LIMITS, runWithChatTurn } from './chat-turn-budget'
import type { ChatQueuePolicy } from './chat-turn-execution'

type QueueResult = 'completed' | 'failed' | 'queue_timeout' | 'queue_full' | 'run_timeout' | 'revoked' | 'disposed' | 'cleanup_failed'
interface QueueOptions {
  ctx?: unknown
  turn?: ChatTurnBudget
  isActive?: () => boolean
  monitor?: {
    readPolicy(): ChatQueuePolicy
    isActive(policy: ChatQueuePolicy): boolean
  }
  onSettled?: (reason: QueueResult) => void | Promise<void>
}
interface QueueItem {
  turn: ChatTurnBudget
  fn: () => Promise<unknown> | unknown
  options: QueueOptions
  state: 'waiting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'cleanup_failed'
  settled: boolean
  waitTimer?: ReturnType<typeof setTimeout>
  cleanupTimer?: ReturnType<typeof setTimeout>
  abort: () => void
  exited: Promise<void>
  resolveExit: () => void
}
interface ChannelState { running?: QueueItem; waiting: QueueItem[]; cleanupFailed: boolean }
const channels = new Map<string, ChannelState>()
const monitoredItems = new Set<QueueItem>()
let monitorTimer: ReturnType<typeof setInterval> | undefined

// --- 授权监视 --- //

// 同一轮共享持久配置，只把本轮结果传给各队列项的即时撤销判断。
function inspectQueuedTurns(): void {
  let policy: ChatQueuePolicy | undefined
  let policyFailed = false
  for (const item of [...monitoredItems]) {
    if (!monitoredItems.has(item)) continue
    const monitor = item.options.monitor
    if (monitor && !policy && !policyFailed) {
      try { policy = monitor.readPolicy() }
      catch { policyFailed = true }
    }
    try {
      item.turn.assertActive(monitor ? () => !!policy && monitor.isActive(policy) : undefined)
    } catch {
      // 根信号的监听器负责摘除等待项或观察现有运行项退出。
    }
  }
}

// 一个进程只维持一套授权检查，首个有资格的队列项负责启动。
function startMonitoring(item: QueueItem): void {
  monitoredItems.add(item)
  monitorTimer ??= setInterval(inspectQueuedTurns, 250)
}

// 取消或完成后马上退出监视，释放最后一个项目的周期计时器。
function stopMonitoring(item: QueueItem): void {
  monitoredItems.delete(item)
  if (monitoredItems.size || monitorTimer === undefined) return
  clearInterval(monitorTimer)
  monitorTimer = undefined
}

// --- 结算与真实退出 --- //

// 每个任务最多一次结算；提示故障不重新启动任务或污染频道所有权。
function settleQueueItem(item: QueueItem, reason: QueueResult): void {
  if (item.settled) return
  item.settled = true
  item.turn.event('settled', { result: reason })
  try { Promise.resolve(item.options.onSettled?.(reason)).catch(() => {}) } catch { /* 结算回调不能破坏清理。 */ }
}

// 取消等待项立即摘除闭包和计时器，不等当前运行项结束。
function removeWaiting(key: string, state: ChannelState, item: QueueItem, reason: QueueResult): void {
  const index = state.waiting.indexOf(item)
  if (index < 0) return
  state.waiting.splice(index, 1)
  clearTimeout(item.waitTimer)
  stopMonitoring(item)
  item.turn.signal.removeEventListener('abort', item.abort)
  item.state = 'cancelled'
  item.turn.cancel(reason)
  settleQueueItem(item, reason)
  item.turn.finish()
  item.resolveExit()
  if (!state.running && !state.waiting.length && channels.get(key) === state) channels.delete(key)
}

// 运行项只能进入取消观察；两秒未退出隔离该频道，不能假报已释放。
function cancelRunning(key: string, state: ChannelState, item: QueueItem): void {
  if (state.running !== item || item.state !== 'running') return
  stopMonitoring(item)
  item.state = 'cancelling'
  item.turn.event('cleanup_start')
  item.cleanupTimer = setTimeout(() => {
    if (state.running !== item) return
    state.cleanupFailed = true
    item.state = 'cleanup_failed'
    item.turn.event('cleanup_failed', { pendingSends: item.turn.pendingSends })
    settleQueueItem(item, 'cleanup_failed')
    // 保留已接纳的明确发问，等旧所有者实际退出后按原顺序继续。
    for (const waiting of [...state.waiting]) {
      if (waiting.turn.random) removeWaiting(key, state, waiting, 'cleanup_failed')
    }
  }, CHAT_TURN_LIMITS.cleanup)
}

// 真实业务退出后核对所有者再放行，迟到退出不能删除其他代的频道状态。
function finishRunning(key: string, state: ChannelState, item: QueueItem, failed: boolean): void {
  clearTimeout(item.cleanupTimer)
  stopMonitoring(item)
  item.turn.signal.removeEventListener('abort', item.abort)
  item.state = item.turn.reason ? 'cancelled' : failed ? 'failed' : 'completed'
  const reason = item.turn.reason as QueueResult
  settleQueueItem(item, reason || (failed ? 'failed' : 'completed'))
  item.turn.event('request_exit')
  item.turn.finish()
  item.resolveExit()
  if (channels.get(key) !== state || state.running !== item) return
  state.running = undefined
  state.cleanupFailed = false
  item.turn.event('queue_release')
  drainChannel(key, state)
}

// --- 队列公开入口 --- //

// 取出一项并保持其所有权直到 fn 真正结束；业务计时从此刻开始。
function drainChannel(key: string, state: ChannelState): void {
  if (state.running || state.cleanupFailed) return
  const item = state.waiting.shift()
  if (!item) { if (channels.get(key) === state) channels.delete(key); return }
  clearTimeout(item.waitTimer)
  state.running = item
  item.state = 'running'
  Promise.resolve().then(() => runWithChatTurn(item.turn, async () => {
    item.turn.start(item.options.isActive)
    try { return await item.fn() } finally { await item.turn.drain() }
  })).then(() => finishRunning(key, state, item, false), () => finishRunning(key, state, item, true))
}

// 返回原有接受/拒绝布尔值；失败原因同时通过确定的结算契约提供。
function enqueueForChannel(channelKey: string, fn: () => Promise<unknown> | unknown, maxDepth: number, options: QueueOptions = {}): boolean {
  const key = String(channelKey)
  const turn = options.turn || new ChatTurnBudget({ channelKey: key })
  const state: ChannelState = channels.get(key) || { waiting: [], cleanupFailed: false }
  let resolveExit!: () => void
  const item: QueueItem = { turn, fn, options, state: 'waiting', settled: false, abort: () => {},
    exited: new Promise(resolve => { resolveExit = resolve }), resolveExit: () => resolveExit() }
  const full = state.waiting.length + (state.running ? 1 : 0) >= maxDepth
  if (full || state.cleanupFailed) {
    const reason = full ? 'queue_full' : 'cleanup_failed'
    turn.cancel(reason); settleQueueItem(item, reason); turn.finish(); resolveExit()
    return false
  }
  turn.enqueue(options.isActive)
  channels.set(key, state)
  state.waiting.push(item)
  item.abort = () => {
    if (state.running === item) cancelRunning(key, state, item)
    else removeWaiting(key, state, item, turn.reason as QueueResult)
  }
  turn.signal.addEventListener('abort', item.abort, { once: true })
  // 等待期间也撤销失效授权，避免短暂关群再开启后复活旧任务。
  startMonitoring(item)
  if (turn.random) {
    item.waitTimer = setTimeout(() => removeWaiting(key, state, item, 'queue_timeout'), CHAT_TURN_LIMITS.randomQueue)
  }
  if (turn.signal.aborted) item.abort()
  else drainChannel(key, state)
  return true
}

// 卸载先取消全部真实所有者；最多观察清理宽限，未退出项继续隔离而非直接清 Map。
async function clearChannelQueues(): Promise<void> {
  const exits: Promise<void>[] = []
  for (const [key, state] of channels) {
    for (const item of [...state.waiting]) removeWaiting(key, state, item, 'disposed')
    if (state.running) { exits.push(state.running.exited); state.running.turn.cancel('disposed') }
  }
  if (!exits.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(exits), new Promise(resolve => { timer = setTimeout(resolve, CHAT_TURN_LIMITS.cleanup) })])
  clearTimeout(timer)
}

export = { enqueueForChannel, clearChannelQueues }
