type ResourceActivityLeaseKind = 'tool_active' | 'render_active' | string;
interface ResourceActivityLeaseMeta {
    leaseId: string;
    kind: ResourceActivityLeaseKind;
    owner: string;
    taskId: string;
    pid: number;
    createdAt: string;
    heartbeatAt: string;
    expiresAt: string;
    ttlMs: number;
}
interface AcquireResourceActivityLeaseOptions {
    owner?: string;
    taskId?: string;
    ttlMs?: number;
}
declare function readResourceActivityLease(kind: ResourceActivityLeaseKind): ResourceActivityLeaseMeta | null;
declare function hasActiveResourceActivityLease(kind: ResourceActivityLeaseKind): boolean;
declare function findBlockingResourceActivityLease(kind: ResourceActivityLeaseKind): ResourceActivityLeaseMeta | null;
declare function buildResourceActivityLeaseBlockReason(kind: ResourceActivityLeaseKind, blocking: ResourceActivityLeaseMeta | null | undefined): string;
declare function acquireResourceActivityLease(kind: ResourceActivityLeaseKind, options?: AcquireResourceActivityLeaseOptions): (reason?: string) => void;
declare function discardResourceActivityLeases(): number;
declare const _default: {
    ACTIVITY_ROOT: string;
    readResourceActivityLease: typeof readResourceActivityLease;
    hasActiveResourceActivityLease: typeof hasActiveResourceActivityLease;
    findBlockingResourceActivityLease: typeof findBlockingResourceActivityLease;
    buildResourceActivityLeaseBlockReason: typeof buildResourceActivityLeaseBlockReason;
    acquireResourceActivityLease: typeof acquireResourceActivityLease;
    discardResourceActivityLeases: typeof discardResourceActivityLeases;
};
export = _default;
