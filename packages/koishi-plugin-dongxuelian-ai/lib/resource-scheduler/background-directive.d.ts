type BackgroundDirectiveAction = 'run' | 'park';
interface TaskDirectiveInput extends Record<string, unknown> {
}
interface BackgroundDirective {
    action: BackgroundDirectiveAction;
    reason: string;
    resourceState: string;
    botMode: string;
    sleepMs: number;
    taskAction: string;
    fallback?: string;
}
interface ResourceSnapshotView extends Record<string, unknown> {
    resourceState?: unknown;
    botMode?: unknown;
    maintenance?: unknown;
    memAvailableMb?: unknown;
    memTotalMb?: unknown;
    memSource?: unknown;
    locked?: unknown;
    running?: unknown;
    createdAt?: unknown;
}
interface TaskDirectiveResultView {
    directive: {
        action?: string;
        reason?: string;
        fallback?: string;
    };
    admission: Record<string, unknown>;
    snapshot: Record<string, unknown>;
}
interface BackgroundDirectiveResult {
    directive: BackgroundDirective;
    task: TaskDirectiveResultView;
    snapshot: ResourceSnapshotView;
}
declare function getBackgroundDirectiveSleepMs(snapshot: ResourceSnapshotView | null | undefined, taskAction: string): number;
declare function shouldParkBackgroundDirective(action: string): boolean;
declare function decideBackgroundDirective(input: TaskDirectiveInput, snapshot?: ResourceSnapshotView): BackgroundDirectiveResult;
declare const _default: {
    getBackgroundDirectiveSleepMs: typeof getBackgroundDirectiveSleepMs;
    shouldParkBackgroundDirective: typeof shouldParkBackgroundDirective;
    decideBackgroundDirective: typeof decideBackgroundDirective;
};
export = _default;
