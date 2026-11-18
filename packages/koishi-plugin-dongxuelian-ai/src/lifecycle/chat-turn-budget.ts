/**
 * 单轮聊天时限与取消所有权。普通明确交互从开始执行计时，随机和记录图片扣除前处理。
 * 不发送消息、不修改历史、不读取模型配置。独立后台任务必须显式退出本轮作用域。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { runWithModelRequestContext, outsideModelRequestContext } from '../core/model-request-context'
import type { ModelTimeBudget } from '../core/model-request-context'

export const CHAT_TURN_LIMITS = Object.freeze({ normal: 60000, record: 180000, randomQueue: 20000,
  forward: 10000, topic: 8000, vision: 90000, visionPrimary: 60000, visionFallback: 30000,
  textPrimary: 40000, textFallback: 30000, textFallbackExtension: 40000, normalFallbackReserve: 10000, recordFallbackReserve: 30000,
  normalSend: 3000, recordSend: 5000, cleanup: 2000 })

export interface TurnIdentity { channelKey: string; messageId?: string; random?: boolean }
export type TurnEvent = Record<string, string | number | boolean | null | undefined>
export interface TurnStage { signal: AbortSignal; deadline: number; close(): void }
const turnScope = new AsyncLocalStorage<ChatTurnBudget | undefined>()
const activeStages = new Map<TurnStage, { turn: ChatTurnBudget; exited: Promise<void> }>()

// --- 预算所有权 --- //

export class ChatTurnBudget {
  readonly id = randomUUID()
  readonly controller = new AbortController()
  readonly createdAt = Date.now()
  readonly signal = this.controller.signal
  random: boolean
  recordImages = false
  preprocessMs = 0
  queuedAt: number | null = null
  startedAt: number | null = null
  deadline = Infinity
  reason = ''
  stage = 'preprocess'
  finished = false
  imagesRead = 0
  forwardUnavailable = false
  imagesTotal = 0
  submittedSends = 0
  pendingSends = 0
  private timer?: ReturnType<typeof setTimeout>
  private textFallbackExtended = false
  private validity?: () => boolean
  private work = new Set<Promise<unknown>>()

  // 建立唯一身份；不在无须聊天的入口留下计时器或全局记录。
  constructor(readonly identity: TurnIdentity, private readonly log?: (event: TurnEvent) => void, validity?: () => boolean) {
    this.random = identity.random === true
    this.validity = validity
  }

  // 档位只在正式执行前选定，随机回复永不获得记录图片预算。
  select(recordImages: boolean, random = this.random): void {
    if (this.startedAt !== null) throw new Error('chat_turn_already_started')
    this.random = random
    this.recordImages = recordImages && !random
  }

  // 入队时记录前处理耗时；等待期间不会消耗执行时间或启动执行计时器。
  enqueue(validity?: () => boolean): void {
    if (this.queuedAt !== null) throw new Error('chat_turn_already_queued')
    this.queuedAt = Date.now()
    this.preprocessMs = this.queuedAt - this.createdAt
    if (validity) this.validity = validity
    this.event('queued')
  }

  // 正式开始只允许一次，所有后继阶段共享这一个绝对截止时间。
  start(validity?: () => boolean): void {
    if (this.startedAt !== null) throw new Error('chat_turn_already_started')
    const runBudget = this.remaining()
    this.startedAt = Date.now()
    if (validity) this.validity = validity
    this.deadline = this.startedAt + runBudget
    this.stage = 'running'
    this.assertActive()
    this.resetRunTimer()
    this.event('started')
  }

  // 入队前限制前处理；入队后普通明确交互保留完整执行预算。
  remaining(): number {
    if (this.startedAt !== null) return Math.max(0, this.deadline - Date.now())
    const limit = this.recordImages ? CHAT_TURN_LIMITS.record : CHAT_TURN_LIMITS.normal
    if (this.queuedAt === null) return Math.max(0, limit - (Date.now() - this.createdAt))
    return this.random || this.recordImages ? Math.max(0, limit - this.preprocessMs) : limit
  }

  // 首次切换普通文字备用模型时延长整轮期限，工具续轮共用这一次延期。
  extendTextFallback(): void {
    if (this.startedAt === null || this.random || this.recordImages || this.textFallbackExtended) return
    this.assertActive()
    this.textFallbackExtended = true
    this.deadline += CHAT_TURN_LIMITS.textFallbackExtension
    this.resetRunTimer()
    this.event('text_fallback_extended', { deadline: this.deadline, addedMs: CHAT_TURN_LIMITS.textFallbackExtension })
  }

  // 更新根计时器，确保旧截止时间不会取消获准延期的轮次。
  private resetRunTimer(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.cancel('run_timeout'), this.remaining())
  }

  // 在模型、工具、保存和发送前复检；计时器尚未被调度时也不能越过截止边界。
  assertActive(validity: (() => boolean) | undefined = this.validity): void {
    if (!this.reason && this.remaining() <= 0) this.cancel('run_timeout')
    if (!this.reason && validity) {
      try { if (!validity()) this.cancel('revoked') }
      catch { this.cancel('revoked') }
    }
    if (this.signal.aborted) throw this.signal.reason
    if (this.finished) throw new Error('chat_turn_finished')
  }

  // 根据是否实际存在备用节点计算预留，不读取或猜测供应商能力。
  modelBudget(): ModelTimeBudget {
    return { deadline: this.deadline - this.sendWindow(), primaryMs: CHAT_TURN_LIMITS.textPrimary,
      fallbackMs: CHAT_TURN_LIMITS.textFallback,
      fallbackReserveMs: this.recordImages ? CHAT_TURN_LIMITS.recordFallbackReserve : CHAT_TURN_LIMITS.normalFallbackReserve }
  }

  // 最终发送窗口属于业务总预算，不额外赠送运行时间。
  sendWindow(): number { return this.recordImages ? CHAT_TURN_LIMITS.recordSend : CHAT_TURN_LIMITS.normalSend }

  // 阶段超时只取消子信号；根轮次取消同时终止阶段，关闭时清除监听器和计时器。
  openStage(name: string, maximumMs: number, reserveMs = 0): TurnStage {
    this.assertActive()
    this.stage = name
    const deadline = Date.now() + Math.max(0, Math.min(maximumMs, this.remaining() - reserveMs))
    const controller = new AbortController()
    const cancelTurnStage = (): void => controller.abort(this.signal.reason)
    this.signal.addEventListener('abort', cancelTurnStage, { once: true })
    const expire = (): void => controller.abort(new Error(`${name}_deadline`))
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()))
    // 入队前也观察关群和维护；运行后的有效性监视由频道队列负责。
    const monitor = this.startedAt === null && this.validity ? setInterval(() => {
      try { this.assertActive() } catch { /* 根信号已通知实际阶段。 */ }
    }, 250) : undefined
    if (deadline <= Date.now()) expire()
    this.event('stage_start', { deadline, remainingMs: deadline - Date.now() })
    let resolveExit!: () => void
    const exited = new Promise<void>(resolve => { resolveExit = resolve })
    const stage: TurnStage = { signal: controller.signal, deadline, close: () => {
      if (!activeStages.delete(stage)) return
      clearTimeout(timer)
      clearInterval(monitor)
      this.signal.removeEventListener('abort', cancelTurnStage)
      controller.abort(new Error(`${name}_closed`))
      this.event('stage_end', { stage: name })
      resolveExit()
    } }
    activeStages.set(stage, { turn: this, exited })
    return stage
  }

  // 登记当前轮次真实启动的请求，防止异步摘要或工具的外层等待先退出。
  own<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise)
    const releaseTurnWork = (): void => { this.work.delete(promise) }
    void promise.then(releaseTurnWork, releaseTurnWork)
    return promise
  }

  // 清理必须等待所有已登记请求退出；不协作项由频道队列保持隔离。
  async drain(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work])
  }

  // 撤销正常发送资格先于通知监听器；重复取消保持第一次原因。
  cancel(reason: string): void {
    if (this.reason || this.finished) return
    this.reason = reason
    if (this.timer) clearTimeout(this.timer)
    this.event('cancel')
    if (this.pendingSends) this.event('send_result_unknown', { pendingSends: this.pendingSends })
    this.controller.abort(new Error(`chat_turn_${reason}`))
  }

  // 只有实际业务退出后调用，清理失败时保留活所有者直到其真实退出。
  finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.timer) clearTimeout(this.timer)
    this.validity = undefined
    this.event('finished')
  }

  // 只记录身份和时间摘要；日志故障不得影响取消与资源释放。
  event(event: string, detail: TurnEvent = {}): void {
    try { this.log?.({ event, turnId: this.id, channelKey: this.identity.channelKey, messageId: this.identity.messageId || '',
      tier: this.recordImages ? 'record_images' : 'normal', random: this.random, stage: this.stage, reason: this.reason,
      preprocessMs: this.preprocessMs, queueMs: this.queuedAt === null ? 0 : (this.startedAt ?? Date.now()) - this.queuedAt,
      runMs: this.startedAt === null ? 0 : Date.now() - this.startedAt, remainingMs: this.remaining(), ...detail }) } catch { /* 诊断不干预所有权。 */ }
  }
}

// --- 调用链上下文与可取消等待 --- //

// 卸载也取消入队前阶段；观察真实退出，超出宽限仅记录，不伪造阶段已释放。
export async function cancelChatTurnStages(): Promise<void> {
  const stages = [...activeStages.entries()]
  for (const [, { turn }] of stages) turn.cancel('disposed')
  if (!stages.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all(stages.map(([, state]) => state.exited)),
      new Promise(resolve => { timer = setTimeout(resolve, CHAT_TURN_LIMITS.cleanup) })])
    for (const [stage, { turn }] of stages) if (activeStages.has(stage)) turn.event('stage_cleanup_failed')
  } finally { clearTimeout(timer) }
}

// 运行明确绑定的聊天任务，使辅助模型、工具和发送共用同一身份。
export function runWithChatTurn<T>(turn: ChatTurnBudget, fn: () => T): T { return turnScope.run(turn, () => runWithModelRequestContext(turn, fn)) }

// 正式接受的独立后台任务使用自身预算；调用前必须完成本轮有效性检查。
export function outsideChatTurn<T>(fn: () => T): T { return turnScope.run(undefined, () => outsideModelRequestContext(fn)) }

// 读取当前显式任务作用域；未进入频道聊天的业务不受聊天预算影响。
export function currentChatTurn(): ChatTurnBudget | undefined { return turnScope.getStore() }

// 向实际业务传播取消，禁止工具续轮或迟到结果重新提交。
export function assertChatTurnActive(): void { currentChatTurn()?.assertActive() }

// 提交前检查资格；已提交平台发送不可撤回，等待真实结果并记录取消后的未知状态。
export async function sendWithChatTurn<T>(send: () => T | Promise<T>): Promise<T> {
  const turn = currentChatTurn()
  turn?.assertActive()
  if (turn) { turn.stage = 'send'; turn.submittedSends++; turn.pendingSends++; turn.event('send_start') }
  try {
    const result = await send()
    turn?.event('send_result', { afterCancellation: !!turn.reason })
    return result
  } finally { if (turn) turn.pendingSends-- }
}

// 可取消的短等待在所有出口清除自身计时器和监听器。
export function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cancelTurnDelay = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancelTurnDelay); reject(signal?.reason) }
    if (signal?.aborted) { reject(signal.reason); return }
    signal?.addEventListener('abort', cancelTurnDelay, { once: true })
    timer = setTimeout(() => { signal?.removeEventListener('abort', cancelTurnDelay); resolve() }, ms)
  })
}

// 只用于锁等候与延迟，不把取消等待冒充底层运行任务已退出。
export function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelSignalWait = (): void => { signal.removeEventListener('abort', cancelSignalWait); reject(signal.reason) }
    if (signal.aborted) { promise.catch(() => {}); cancelSignalWait(); return }
    signal.addEventListener('abort', cancelSignalWait, { once: true })
    promise.then(value => { signal.removeEventListener('abort', cancelSignalWait); resolve(value) }, error => { signal.removeEventListener('abort', cancelSignalWait); reject(error) })
  })
}
