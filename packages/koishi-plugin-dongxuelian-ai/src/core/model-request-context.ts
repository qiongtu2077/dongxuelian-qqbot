/** 类型化模型请求上下文；底层 API 只依赖此契约，不反向加载聊天生命周期。 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ModelTimeBudget { deadline: number; primaryMs: number; fallbackMs: number; fallbackReserveMs: number }
export interface ModelRequestContext {
  signal: AbortSignal
  deadline: number
  assertActive(): void
  sendWindow(): number
  modelBudget(): ModelTimeBudget
  own<T>(promise: Promise<T>): Promise<T>
  event(name: string, detail?: Record<string, string | number | boolean | null | undefined>): void
}
const modelRequestScope = new AsyncLocalStorage<ModelRequestContext | undefined>()

// 业务入口显式提供预算与所有权；协议层无需知道队列和会话结构。
export function runWithModelRequestContext<T>(context: ModelRequestContext, fn: () => T): T { return modelRequestScope.run(context, fn) }

// 独立后台任务和既有故障通知退出前台请求预算。
export function outsideModelRequestContext<T>(fn: () => T): T { return modelRequestScope.run(undefined, fn) }

// 不处于聊天轮次的调用继续使用自身原有预算。
export function currentModelRequestContext(): ModelRequestContext | undefined { return modelRequestScope.getStore() }
