/**
 * MODULE: S2 任务类型。
 * 职责: 定义资源 worker 任务、结果和 worker 心跳结构。
 * 边界: 不包含执行逻辑。
 */

type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred'
type ResourceTaskKind = 'daily_report' | 'agent_task' | 'media_task' | string

interface ResourceTaskNotify {
  target?: 'qq-group' | 'dashboard' | 'none' | string
  channelKey?: string
  status?: 'pending' | 'sent' | 'failed' | string
  error?: string
}

interface ResourceTask {
  id: string
  kind: ResourceTaskKind
  status: ResourceTaskStatus
  source: string
  channelKey: string
  userId: string
  priority: number
  createdAt: string
  updatedAt?: string
  expiresAt?: string
  timeoutMs: number
  step?: string
  claimedBy?: string
  claimedAt?: string
  startedAt?: string
  finishedAt?: string
  payload: Record<string, unknown>
  notify?: ResourceTaskNotify
  error?: string
}

interface ResourceTaskResult {
  taskId: string
  kind: string
  ok: boolean
  level?: string
  mode?: string
  reason?: string
  textPath?: string | null
  imagePath?: string | null
  reply?: string
  warnings?: string[]
  createdAt: string
}

interface ResourceWorkerState {
  name: string
  pid: number
  kind: string
  taskId?: string
  step?: string
  startedAt: string
  heartbeatAt: string
  rssMb?: number | null
  alive?: boolean
}

export = {}
