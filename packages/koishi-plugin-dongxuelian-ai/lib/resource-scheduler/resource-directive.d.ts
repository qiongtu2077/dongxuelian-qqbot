type EntryCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event';
type EntryPolicyAction = 'pass' | 'queue_daily' | 'status_only' | 'silent_drop' | 'reject' | 'defer';
type TaskAdmissionAction = 'run_now' | 'queue' | 'downgrade' | 'defer' | 'reject' | 'silent_drop';
type ResourceDirectiveAction = 'pass' | 'queue_daily' | 'status_only' | 'silent_drop' | 'reject' | 'defer' | 'queue' | 'downgrade';
interface ResourceSnapshotView {
    resourceState: string;
    botMode: string;
    memAvailableMb: number | null;
    memTotalMb: number | null;
    memSource: string;
    locked: boolean;
    running: unknown | null;
    maintenance: boolean;
    createdAt: string;
}
interface EntryPolicyView {
    action: EntryPolicyAction;
    reason: string;
}
interface TaskAdmissionView {
    decision: TaskAdmissionAction;
    reason: string;
    resourceState: string;
    botMode: string;
    memAvailableMb: number | null;
    fallback?: string;
}
interface ResourceDirective {
    action: ResourceDirectiveAction;
    reason: string;
    resourceState: string;
    botMode: string;
    fallback?: string;
}
interface TaskDirectiveInput extends Record<string, unknown> {
}
interface EntryDirectiveResult {
    directive: ResourceDirective;
    policy: EntryPolicyView;
    snapshot: ResourceSnapshotView;
}
interface TaskDirectiveResult {
    directive: ResourceDirective;
    admission: TaskAdmissionView;
    snapshot: ResourceSnapshotView;
}
declare function readResourceContext(): ResourceSnapshotView;
declare function directiveFromEntryPolicy(policy: EntryPolicyView, snapshot: ResourceSnapshotView): ResourceDirective;
declare function directiveFromAdmission(admission: TaskAdmissionView, snapshot: ResourceSnapshotView): ResourceDirective;
declare function decideEntryDirective(commandType: EntryCommandType, snapshot?: ResourceSnapshotView): EntryDirectiveResult;
declare function decideTaskDirective(input: TaskDirectiveInput, snapshot?: ResourceSnapshotView): TaskDirectiveResult;
declare function admitTaskDirective(input: TaskDirectiveInput): TaskDirectiveResult;
declare function isDirectiveBlocking(action: ResourceDirectiveAction): boolean;
declare const _default: {
    readResourceContext: typeof readResourceContext;
    directiveFromEntryPolicy: typeof directiveFromEntryPolicy;
    directiveFromAdmission: typeof directiveFromAdmission;
    decideEntryDirective: typeof decideEntryDirective;
    decideTaskDirective: typeof decideTaskDirective;
    admitTaskDirective: typeof admitTaskDirective;
    isDirectiveBlocking: typeof isDirectiveBlocking;
};
export = _default;
