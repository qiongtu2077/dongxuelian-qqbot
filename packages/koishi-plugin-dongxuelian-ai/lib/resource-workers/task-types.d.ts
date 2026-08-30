/**
 * MODULE: S2 任务类型。
 * 职责: 定义资源 worker 任务、结果和 worker 心跳结构。
 * 边界: 不包含执行逻辑。
 */
import type resourceTaskKinds = require('../resource-common/resource-task-kinds');
export type ResourceTaskStatus = 'pending' | 'claiming' | 'running' | 'done' | 'failed' | 'cancelled' | 'deferred';
export type KnownResourceTaskKind = typeof resourceTaskKinds.RESOURCE_TASK_KIND[keyof typeof resourceTaskKinds.RESOURCE_TASK_KIND];
export type ResourceTaskKind = KnownResourceTaskKind | string;
export interface ResourceTaskNotify {
    target?: 'qq-group' | 'dashboard' | 'none' | string;
    channelKey?: string;
    status?: 'pending' | 'sent' | 'failed' | string;
    error?: string;
    updatedAt?: string;
}
export interface ResourceTask {
    id: string;
    kind: ResourceTaskKind;
    status: ResourceTaskStatus;
    source: string;
    channelKey: string;
    userId: string;
    priority: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    timeoutMs: number;
    step?: string;
    claimedBy?: string;
    claimedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    payload: Record<string, unknown>;
    notify: ResourceTaskNotify;
    error?: string;
    retryAfter?: string;
    requeueReason?: string;
}
export interface ResourceTaskResult {
    taskId: string;
    kind: string;
    ok: boolean;
    level?: string;
    mode?: string;
    reason?: string;
    textPath?: string | null;
    imagePath?: string | null;
    reply?: string;
    warnings?: string[];
    createdAt: string;
}
export interface ResourceWorkerState {
    name: string;
    pid: number;
    kind?: string;
    taskId?: string;
    step?: string;
    startedAt: string;
    heartbeatAt: string;
    rssMb?: number | null;
    alive: boolean;
    heartbeatLagMs?: number | null;
    loopIterations?: number;
    loopChangedAt?: string;
    lastClaimAttemptAt?: string;
    lastTaskFinishedAt?: string;
    currentTaskId?: string;
    currentTaskStartedAt?: string;
    parked?: boolean;
    parkSleepMs?: number;
    ownerGeneration?: string;
    startToken?: string;
}
