/**
 * MODULE: 资源指令薄门面。
 * 职责: 统一组合资源快照、入口模式策略和任务准入结果，对上层暴露稳定 directive。
 * 边界: 不接管任务状态机，不获取 S0 锁，不复制 admission / mode-policy 判断树。
 */
const { decideModePolicy } = require('../bot-mode/mode-policy') as typeof import('../bot-mode/mode-policy')
const { decideAdmission, writeAdmissionEvent } = require('./admission') as typeof import('./admission')
const { readResourceSnapshot } = require('./resource-snapshot') as typeof import('./resource-snapshot')

type EntryCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event'
type EntryPolicyAction = 'pass' | 'queue_daily' | 'status_only' | 'resource_notice' | 'silent_drop' | 'reject' | 'defer'
type TaskAdmissionAction = 'run_now' | 'queue' | 'downgrade' | 'defer' | 'reject' | 'silent_drop'
type ResourceDirectiveAction =
  | 'pass'
  | 'queue_daily'
  | 'status_only'
  | 'resource_notice'
  | 'silent_drop'
  | 'reject'
  | 'defer'
  | 'queue'
  | 'downgrade'

interface ResourceSnapshotView {
  resourceState: string
  botMode: string
  memAvailableMb: number | null
  memTotalMb: number | null
  memSource: string
  locked: boolean
  running: unknown | null
  maintenance: boolean
  createdAt: string
}

interface EntryPolicyView {
  action: EntryPolicyAction
  reason: string
}

interface TaskAdmissionView {
  decision: TaskAdmissionAction
  reason: string
  resourceState: string
  botMode: string
  memAvailableMb: number | null
  fallback?: string
}

interface ResourceDirective {
  action: ResourceDirectiveAction
  reason: string
  resourceState: string
  botMode: string
  fallback?: string
}

interface TaskDirectiveInput extends Record<string, unknown> {}

interface EntryDirectiveResult {
  directive: ResourceDirective
  policy: EntryPolicyView
  snapshot: ResourceSnapshotView
}

interface TaskDirectiveResult {
  directive: ResourceDirective
  admission: TaskAdmissionView
  snapshot: ResourceSnapshotView
}

// 读取当前资源快照并收敛为 directive 使用的只读视图。
function readResourceContext(): ResourceSnapshotView {
  return readResourceSnapshot() as ResourceSnapshotView
}

// 提取每条 directive 都必须携带的资源档位字段。
function buildDirectiveBase(snapshot: ResourceSnapshotView): Pick<ResourceDirective, 'resourceState' | 'botMode'> {
  return {
    resourceState: String(snapshot.resourceState || 'yellow'),
    botMode: String(snapshot.botMode || 'normal'),
  }
}

// 把入口策略动作映射到统一 directive 动作词汇。
function mapEntryPolicyAction(action: EntryPolicyAction): ResourceDirectiveAction {
  if (action === 'pass') return 'pass'
  if (action === 'queue_daily') return 'queue_daily'
  if (action === 'status_only') return 'status_only'
  if (action === 'resource_notice') return 'resource_notice'
  if (action === 'silent_drop') return 'silent_drop'
  if (action === 'reject') return 'reject'
  return 'defer'
}

// 把 S1 准入结果映射到统一 directive 动作词汇。
function mapAdmissionDecisionAction(decision: TaskAdmissionAction): ResourceDirectiveAction {
  if (decision === 'run_now') return 'pass'
  if (decision === 'queue') return 'queue'
  if (decision === 'downgrade') return 'downgrade'
  if (decision === 'defer') return 'defer'
  if (decision === 'reject') return 'reject'
  return 'silent_drop'
}

// 组合入口策略与资源快照，生成稳定 directive。
function directiveFromEntryPolicy(policy: EntryPolicyView, snapshot: ResourceSnapshotView): ResourceDirective {
  return {
    action: mapEntryPolicyAction(policy.action),
    reason: String(policy.reason || ''),
    ...buildDirectiveBase(snapshot),
  }
}

// 组合任务准入结果与资源快照，生成稳定 directive。
function directiveFromAdmission(admission: TaskAdmissionView, snapshot: ResourceSnapshotView): ResourceDirective {
  return {
    action: mapAdmissionDecisionAction(admission.decision),
    reason: String(admission.reason || ''),
    ...buildDirectiveBase(snapshot),
    fallback: admission.fallback || undefined,
  }
}

// 为一条入站命令生成入口 directive。
function decideEntryDirective(commandType: EntryCommandType, snapshot: ResourceSnapshotView = readResourceContext()): EntryDirectiveResult {
  const policy = decideModePolicy(commandType, snapshot) as EntryPolicyView
  return {
    directive: directiveFromEntryPolicy(policy, snapshot),
    policy,
    snapshot,
  }
}

// 为一个资源任务生成只读准入 directive。
function decideTaskDirective(input: TaskDirectiveInput, snapshot: ResourceSnapshotView = readResourceContext()): TaskDirectiveResult {
  const admission = decideAdmission(input, snapshot) as TaskAdmissionView
  return {
    directive: directiveFromAdmission(admission, snapshot),
    admission,
    snapshot,
  }
}

// 为资源任务执行准入并记录聚合事件。
function admitTaskDirective(input: TaskDirectiveInput): TaskDirectiveResult {
  const result = decideTaskDirective(input, readResourceContext())
  writeAdmissionEvent(result.admission as unknown as ReturnType<typeof decideAdmission>)
  return result
}

// 判断 directive 是否会阻止原业务链继续执行。
function isDirectiveBlocking(action: ResourceDirectiveAction): boolean {
  return action === 'resource_notice' || action === 'silent_drop' || action === 'reject' || action === 'defer'
}

export = {
  readResourceContext,
  directiveFromEntryPolicy,
  directiveFromAdmission,
  decideEntryDirective,
  decideTaskDirective,
  admitTaskDirective,
  isDirectiveBlocking,
}
