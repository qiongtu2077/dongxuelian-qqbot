/**
 * MODULE: 后台循环统一指令薄门面。
 * 职责: 基于现有资源快照与任务准入结果，为后台循环输出 run / park 与退避时长。
 * 边界: 不接管 worker 状态机，不创建新的资源中心，不复制 admission 判断树。
 */
const {
  decideTaskDirective,
  readResourceContext,
} = require('./resource-directive') as typeof import('./resource-directive')
const {
  RESOURCE_TASK_KIND,
  shouldYieldToToolActiveKind,
} = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')
const {
  readResourceActivityLease,
} = require('./resource-activity-lease') as typeof import('./resource-activity-lease')

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
  serverMode?: unknown
  serverModeSource?: unknown
  toolActive?: unknown
  renderActive?: unknown
  backgroundAllowed?: unknown
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

function normalizeServerMode(snapshot: ResourceSnapshotView | null | undefined): string {
  const mode = String(snapshot?.serverMode || 'large').trim().toLowerCase()
  return mode === 'small' ? 'small' : 'large'
}

function normalizeBackgroundAllowed(snapshot: ResourceSnapshotView | null | undefined): boolean {
  if (snapshot && typeof snapshot.backgroundAllowed === 'boolean') return snapshot.backgroundAllowed
  const serverMode = normalizeServerMode(snapshot)
  const resourceState = normalizeResourceState(snapshot)
  const botMode = normalizeBotMode(snapshot)
  const toolActive = !!snapshot?.toolActive
  const renderActive = !!snapshot?.renderActive
  if (botMode === 'maintenance') return false
  if (resourceState === 'black' || resourceState === 'red') return false
  if (serverMode === 'small' && (toolActive || renderActive)) return false
  return true
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

function getBackgroundDirectiveKind(input: TaskDirectiveInput): string {
  return String(input.kind || '')
}

function decideBackgroundDirective(input: TaskDirectiveInput, snapshot: ResourceSnapshotView = readResourceContext() as unknown as ResourceSnapshotView): BackgroundDirectiveResult {
  const task = decideTaskDirective(
    input,
    snapshot as unknown as Parameters<typeof decideTaskDirective>[1],
  ) as unknown as TaskDirectiveResultView
  const taskAction = String(task.directive?.action || '')
  const kind = getBackgroundDirectiveKind(input)
  const backgroundAllowed = normalizeBackgroundAllowed(snapshot)
  const toolActiveLease = shouldYieldToToolActiveKind(kind)
    ? readResourceActivityLease('tool_active')
    : null
  if (!backgroundAllowed) {
    return {
      directive: {
        action: 'park',
        reason: `background not allowed in ${normalizeServerMode(snapshot)} mode`,
        resourceState: normalizeResourceState(snapshot),
        botMode: normalizeBotMode(snapshot),
        sleepMs: getBackgroundDirectiveSleepMs(snapshot, taskAction),
        taskAction,
      },
      task,
      snapshot,
    }
  }
  if (toolActiveLease) {
    return {
      directive: {
        action: 'park',
        reason: `foreground tool active (${String(toolActiveLease.owner || toolActiveLease.taskId || toolActiveLease.pid || 'unknown')})`,
        resourceState: normalizeResourceState(snapshot),
        botMode: normalizeBotMode(snapshot),
        sleepMs: getBackgroundDirectiveSleepMs(snapshot, 'queue'),
        taskAction,
      },
      task,
      snapshot,
    }
  }
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
