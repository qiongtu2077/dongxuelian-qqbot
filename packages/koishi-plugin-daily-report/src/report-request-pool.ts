/**
 * MODULE: 单任务实际模型请求槽位。
 * 职责: 限制在途请求，取消等待者，等待实际上游清理再释放资源。
 * 边界: 不领取资源任务、不改变全局准入、不建立持久队列。
 */
interface WaitingRequest {
  resolve(): void; reject(reason: unknown): void; signal: AbortSignal; onAbort(): void
}
export interface ReportUpstreamFailure { code: string; status: number; retryable: boolean }

// 已知请求边界错误必须停止相应调用，不能被当成模型格式问题再消耗恢复。
export class ReportRequestBoundaryError extends Error {
  readonly upstreamFailure: Readonly<ReportUpstreamFailure> | null
  // 明确区分上游不可用、额度和执行契约；保留原始原因文字。
  constructor(readonly kind: 'upstream' | 'budget' | 'contract', message: string, upstreamFailure: ReportUpstreamFailure | null = null) {
    super(message); this.name = 'ReportRequestBoundaryError'
    this.upstreamFailure = upstreamFailure ? Object.freeze({ ...upstreamFailure }) : null
  }
}

export class ReportRequestPool {
  private active = 0
  private readonly waiting: WaitingRequest[] = []
  private readonly idle: Array<() => void> = []

  // 限制由调用方已核实的资源准入决定，只允许方案规定的一路或两路。
  constructor(private readonly limit: 1 | 2) {
    if (limit !== 1 && limit !== 2) throw new Error('日报实际请求并发只能一或二')
  }

  // 槽位包住实际请求Promise，不因外层超时竞速提前释放。
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      if (signal.aborted) throw signal.reason || new Error('日报请求已取消')
      return await action()
    } finally { this.release() }
  }

  // 所有真实请求完成清理后才允许上层释放任务资源。
  async drain(): Promise<void> {
    if (!this.active && !this.waiting.length) return
    await new Promise<void>(resolve => this.idle.push(resolve))
  }

  // 公平领取请求槽；未提交的等待请求被取消时直接移除。
  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason || new Error('日报请求已取消')
    if (this.active < this.limit && !this.waiting.length) { this.active++; return }
    await new Promise<void>((resolve, reject) => {
      const entry: WaitingRequest = { resolve, reject, signal, onAbort: () => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        signal.removeEventListener('abort', entry.onAbort)
        reject(signal.reason || new Error('日报等待请求已取消'))
        this.notifyIdle()
      } }
      this.waiting.push(entry)
      signal.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

  // 实际Promise结束后移交槽位；已取消等待者不获得执行机会。
  private release(): void {
    this.active--
    while (this.waiting.length && this.active < this.limit) {
      const entry = this.waiting.shift()!
      entry.signal.removeEventListener('abort', entry.onAbort)
      if (entry.signal.aborted) { entry.reject(entry.signal.reason || new Error('日报等待请求已取消')); continue }
      this.active++; entry.resolve()
    }
    this.notifyIdle()
  }

  // 清空实际请求及等待者后唤醒任务清理，不伪造上游已经结束。
  private notifyIdle(): void {
    if (!this.active && !this.waiting.length) this.idle.splice(0).forEach(resolve => resolve())
  }
}
