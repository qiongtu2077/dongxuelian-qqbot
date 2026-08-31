export declare const VIDEO_TRACE_EVENTS: readonly ["input_detected", "input_normalized", "input_rejected", "cookie_health_checked", "shortlink_hop", "shortlink_failed", "admission_decided", "queue_write_started", "queue_persisted", "queue_persist_failed", "gate_acquired", "gate_released", "gate_storage_failed", "gate_admin_alert_sent", "gate_admin_alert_suppressed", "gate_admin_alert_summary", "probe_started", "probe_finished", "download_started", "download_finished", "preview_send_finished", "video_send_finished", "terminal_status"];
export type VideoTraceEvent = typeof VIDEO_TRACE_EVENTS[number];
export type VideoTerminalStatus = 'done' | 'failed' | 'cancelled';
export interface VideoTraceContext {
    traceId: string;
    taskId: string;
    inputType: string;
    videoKeyHash: string;
    startedAt: number;
}
export interface VideoTraceFields {
    stage?: string;
    durationMs?: number;
    errorId?: string;
    reason?: string;
    status?: VideoTerminalStatus;
    shortCodeHash?: string;
    hop?: number;
    statusCode?: number;
    finalHost?: string;
    finalPath?: string;
    decision?: string;
    waiting?: number;
    capacity?: number;
    ok?: boolean;
    code?: string;
}
interface VideoTraceLogger {
    warn(...args: unknown[]): void;
}
export declare function createVideoTraceId(): string;
export declare function hashVideoTraceValue(value: unknown): string;
export declare function createVideoTrace(input?: {
    traceId?: string;
    taskId?: string;
    inputType?: string;
    videoKey?: unknown;
    startedAt?: number;
}): VideoTraceContext;
export declare function withVideoTraceTask(trace: VideoTraceContext, taskId: unknown): VideoTraceContext;
export declare function withVideoTraceKey(trace: VideoTraceContext, videoKey: unknown): VideoTraceContext;
export declare function writeVideoTrace(logger: VideoTraceLogger, trace: VideoTraceContext, event: VideoTraceEvent, fields?: VideoTraceFields): boolean;
export declare function clearVideoTraceState(): void;
export declare function getVideoTerminalTraceCount(): number;
export {};
