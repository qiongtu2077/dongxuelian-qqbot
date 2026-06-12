/**
 * MODULE: 资源指令薄门面。
 * 职责: 统一组合资源快照、入口模式策略和任务准入结果，对上层暴露稳定 directive。
 * 边界: 不接管任务状态机，不获取 S0 锁，不复制 admission / mode-policy 判断树。
 */
const { decideModePolicy } = require('../bot-mode/mode-policy') as typeof import('../bot-mode/mode-policy')
const { decideAdmission, writeAdmissionEvent } = require('./admission') as typeof import('./admission')
const { readResourceSnapshot } = require('./resource-snapshot') as typeof import('./resource-snapshot')

type EntryCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event'
type EntryPolicyAction = 'pass' | 'queue_daily' | 'status_only' | 'silent_drop' | 'reject' | 'defer'
type TaskAdmissionAction = 'run_now' | 'queue' | 'downgrade' | 'defer' | 'reject' | 'silent_drop'
type ResourceDirectiveAction =
  | 'pass'
  | 'queue_daily'
  | 'status_only'
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

function readResourceContext(): ResourceSnapshotView {
  return readResourceSnapshot() as ResourceSnapshotView
}

function buildDirectiveBase(snapshot: ResourceSnapshotView): Pick<ResourceDirective, 'resourceState' | 'botMode'> {
  return {
    resourceState: String(snapshot.resourceState || 'yellow'),
    botMode: String(snapshot.botMode || 'normal'),
  }
}

function mapEntryPolicyAction(action: EntryPolicyAction): ResourceDirectiveAction {
  if (action === 'pass') return 'pass'
  if (action === 'queue_daily') return 'queue_daily'
  if (action === 'status_only') return 'status_only'
  if (action === 'silent_drop') return 'silent_drop'
  if (action === 'reject') return 'reject'
  return 'defer'
}

function mapAdmissionDecisionAction(decision: TaskAdmissionAction): ResourceDirectiveAction {
  if (decision === 'run_now') return 'pass'
  if (decision === 'queue') return 'queue'
  if (decision === 'downgrade') return 'downgrade'
  if (decision === 'defer') return 'defer'
  if (decision === 'reject') return 'reject'
  return 'silent_drop'
}

function directiveFromEntryPolicy(policy: EntryPolicyView, snapshot: ResourceSnapshotView): ResourceDirective {
  return {
    action: mapEntryPolicyAction(policy.action),
    reason: String(policy.reason || ''),
    ...buildDirectiveBase(snapshot),
  }
}

function directiveFromAdmission(admission: TaskAdmissionView, snapshot: ResourceSnapshotView): ResourceDirective {
  return {
    action: mapAdmissionDecisionAction(admission.decision),
    reason: String(admission.reason || ''),
    ...buildDirectiveBase(snapshot),
    fallback: admission.fallback || undefined,
  }
}

function decideEntryDirective(commandType: EntryCommandType, snapshot: ResourceSnapshotView = readResourceContext()): EntryDirectiveResult {
  const policy = decideModePolicy(commandType, snapshot) as EntryPolicyView
  return {
    directive: directiveFromEntryPolicy(policy, snapshot),
    policy,
    snapshot,
  }
}

function decideTaskDirective(input: TaskDirectiveInput, snapshot: ResourceSnapshotView = readResourceContext()): TaskDirectiveResult {
  const admission = decideAdmission(input, snapshot) as TaskAdmissionView
  return {
    directive: directiveFromAdmission(admission, snapshot),
    admission,
    snapshot,
  }
}

function admitTaskDirective(input: TaskDirectiveInput): TaskDirectiveResult {
  const result = decideTaskDirective(input, readResourceContext())
  writeAdmissionEvent(result.admission as unknown as ReturnType<typeof decideAdmission>)
  return result
}

function isDirectiveBlocking(action: ResourceDirectiveAction): boolean {
  return action === 'silent_drop' || action === 'reject' || action === 'defer'
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
