/**
 * MODULE: 后台循环统一指令薄门面。
 * 职责: 基于现有资源快照与任务准入结果，为后台循环输出 run / park 与退避时长。
 * 边界: 不接管 worker 状态机，不创建新的资源中心，不复制 admission 判断树。
 */
const {
  decideTaskDirective,
  readResourceContext,
} = require('./resource-directive') as typeof import('./resource-directive')

type ResourceDirectiveAction =
  | 'pass'
  | 'queue_daily'
  | 'status_only'
  | 'silent_drop'
  | 'reject'
  | 'defer'
  | 'queue'
  | 'downgrade'

type BackgroundDirectiveAction = 'run' | 'park'

interface TaskDirectiveInput extends Record<string, unknown> {}

interface BackgroundDirective {
  action: BackgroundDirectiveAction
  reason: string
  resourceState: string
  botMode: string
  sleepMs: number
  taskAction: string
  fallback?: string
}

interface ResourceSnapshotView extends Record<string, unknown> {
  resourceState?: unknown
  botMode?: unknown
  maintenance?: unknown
  memAvailableMb?: unknown
  memTotalMb?: unknown
  memSource?: unknown
  locked?: unknown
  running?: unknown
  createdAt?: unknown
}

interface TaskDirectiveResultView {
  directive: {
    action?: string
    reason?: string
    fallback?: string
  }
  admission: Record<string, unknown>
  snapshot: Record<string, unknown>
}

interface BackgroundDirectiveResult {
  directive: BackgroundDirective
  task: TaskDirectiveResultView
  snapshot: ResourceSnapshotView
}

function normalizeResourceState(snapshot: ResourceSnapshotView | null | undefined): string {
  return String(snapshot?.resourceState || 'yellow')
}

function normalizeBotMode(snapshot: ResourceSnapshotView | null | undefined): string {
  return String(snapshot?.botMode || 'normal')
}

function getBackgroundDirectiveSleepMs(snapshot: ResourceSnapshotView | null | undefined, taskAction: string): number {
  const resourceState = normalizeResourceState(snapshot)
  const botMode = normalizeBotMode(snapshot)
  if (botMode === 'maintenance') return 30000
  if (resourceState === 'black') return 30000
  if (resourceState === 'red') return 15000
  if (taskAction === 'queue') return 5000
  if (resourceState === 'yellow') return 5000
  return 2000
}

function shouldParkBackgroundDirective(action: string): boolean {
  return action === 'defer' || action === 'reject' || action === 'silent_drop' || action === 'queue'
}

function decideBackgroundDirective(input: TaskDirectiveInput, snapshot: ResourceSnapshotView = readResourceContext() as unknown as ResourceSnapshotView): BackgroundDirectiveResult {
  const task = decideTaskDirective(
    input,
    snapshot as unknown as Parameters<typeof decideTaskDirective>[1],
  ) as unknown as TaskDirectiveResultView
  const taskAction = String(task.directive?.action || '')
  const parked = shouldParkBackgroundDirective(taskAction)
  return {
    directive: {
      action: parked ? 'park' : 'run',
      reason: String(task.directive?.reason || taskAction || 'background directive'),
      resourceState: normalizeResourceState(snapshot),
      botMode: normalizeBotMode(snapshot),
      sleepMs: parked ? getBackgroundDirectiveSleepMs(snapshot, taskAction) : 0,
      taskAction,
      fallback: task.directive?.fallback || undefined,
    },
    task,
    snapshot,
  }
}

export = {
  getBackgroundDirectiveSleepMs,
  shouldParkBackgroundDirective,
  decideBackgroundDirective,
}
