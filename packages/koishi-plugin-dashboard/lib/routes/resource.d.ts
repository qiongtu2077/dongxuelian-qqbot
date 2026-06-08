import type { IncomingMessage, ServerResponse } from 'http';
type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown;
interface ResourceSnapshotLike extends Record<string, unknown> {
    botMode?: unknown;
    resourceState?: unknown;
    memAvailableMb?: unknown;
    memTotalMb?: unknown;
    memSource?: unknown;
}
interface ResourceGateStatusLike extends Record<string, unknown> {
    meta?: ResourceGateMetaLike | null;
}
interface ResourceGateMetaLike extends Record<string, unknown> {
    taskId?: unknown;
    kind?: unknown;
    step?: unknown;
    owner?: unknown;
    channelKey?: unknown;
    userId?: unknown;
    startedAt?: unknown;
    heartbeatAt?: unknown;
    memAvailableMb?: unknown;
}
interface ResourceQueueSummaryLike extends Record<string, unknown> {
    pending?: unknown;
}
interface PrecomputeSummaryLike extends Record<string, unknown> {
    coverageCount?: unknown;
    slotCount?: unknown;
    coverage?: unknown;
}
interface ResourceTaskLike extends Record<string, unknown> {
    payload?: unknown;
}
interface ResourceModuleSet {
    gate: {
        GATE_ROOT: string;
        getResourceGateStatus(staleMs?: number): ResourceGateStatusLike;
        reclaimStaleLock(staleMs: number, source: string): unknown;
    };
    scheduler: {
        SCHEDULER_ROOT: string;
        readResourceSnapshot(): ResourceSnapshotLike;
    };
    tasks: {
        getTaskQueueSummary(): ResourceQueueSummaryLike;
        listWorkerStates(): unknown;
        listResourceTasks(options: {
            statuses?: string[];
            limit: number;
        }): ResourceTaskLike[];
        cancelTask(taskId: string, source: string, reason: string): boolean;
    };
    precompute: {
        PRECOMPUTE_ROOT: string;
        getPrecomputeSummary(): PrecomputeSummaryLike;
    };
    media: {
        MEDIA_ROOT: string;
        getMediaBackpressureStatus(): unknown;
    };
    system: {
        RESOURCE_SYSTEM_ROOT: string;
        getSystemProtectionStatus(): unknown;
    };
    files: {
        readRecentJsonlEvents(dir: string, prefix: string, limit?: number): unknown[];
    };
}
declare function sanitizeTask(task: ResourceTaskLike): {
    id: unknown;
    kind: unknown;
    status: unknown;
    source: unknown;
    channelKey: unknown;
    userId: unknown;
    priority: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    expiresAt: unknown;
    timeoutMs: unknown;
    step: unknown;
    claimedBy: unknown;
    claimedAt: unknown;
    startedAt: unknown;
    finishedAt: unknown;
    notify: unknown;
    error: unknown;
    payloadKeys: string[];
};
declare function buildResourceStatus(mods: ResourceModuleSet): Record<string, unknown>;
declare const _default: {
    routes: Record<string, RouteHandler>;
    buildResourceStatus: typeof buildResourceStatus;
    sanitizeTask: typeof sanitizeTask;
};
export = _default;
