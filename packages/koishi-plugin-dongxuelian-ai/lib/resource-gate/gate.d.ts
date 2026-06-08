type ResourceTaskKind = 'daily_report' | 'agent_task' | 'dashboard_agent' | 'browser_action' | 'voice_tts_generation' | 'diagnostic_probe' | 'mcp_local_check' | 'external_video_download' | 'pet_bridge_chat' | 'media_image_analysis' | 'media_file_analysis' | string;
interface ResourceGateTicketInput {
    taskId: string;
    kind: ResourceTaskKind;
    owner?: string;
    channelKey?: string;
    userId?: string;
    priority?: number;
    timeoutMs?: number;
}
interface ResourceGateTicket extends ResourceGateTicketInput {
    ticketId: string;
    pid: number;
    createdAt: string;
}
interface ResourceGateLockMeta {
    taskId: string;
    kind: ResourceTaskKind;
    owner: string;
    pid: number;
    channelKey: string;
    userId: string;
    startedAt: string;
    heartbeatAt: string;
    step: string;
    memAvailableMb: number | null;
    timeoutMs: number;
    ticketId: string;
}
interface AcquireGateOptions extends ResourceGateTicketInput {
    staleMs?: number;
    waitTimeoutMs?: number;
    pollMs?: number;
    memAvailableMb?: number | null;
    step?: string;
}
interface ResourceGateHandle {
    ticketId: string;
    meta: ResourceGateLockMeta;
    updateStep(step: string, memAvailableMb?: number | null): void;
    release(reason?: string): void;
}
interface ResourceGateStatus {
    locked: boolean;
    meta: ResourceGateLockMeta | null;
    tickets: ResourceGateTicket[];
    suspectedBlocked: boolean;
}
declare function writeGateEvent(event: string, data?: Record<string, unknown>): void;
declare function createTicket(input: ResourceGateTicketInput): ResourceGateTicket;
declare function listTickets(): ResourceGateTicket[];
declare function readLockMeta(): ResourceGateLockMeta | null;
declare function reclaimStaleLock(staleMs?: number, actor?: string): boolean;
declare function acquireResourceGate(input: AcquireGateOptions): Promise<ResourceGateHandle>;
declare function releaseResourceGate(ticketId: string, reason?: string): void;
declare function getResourceGateStatus(staleMs?: number): ResourceGateStatus;
declare function isDailyReportRunning(): boolean;
declare const _default: {
    GATE_ROOT: string;
    LOCK_DIR: string;
    LOCK_META_FILE: string;
    TICKETS_DIR: string;
    createTicket: typeof createTicket;
    listTickets: typeof listTickets;
    readLockMeta: typeof readLockMeta;
    acquireResourceGate: typeof acquireResourceGate;
    releaseResourceGate: typeof releaseResourceGate;
    reclaimStaleLock: typeof reclaimStaleLock;
    getResourceGateStatus: typeof getResourceGateStatus;
    isDailyReportRunning: typeof isDailyReportRunning;
    writeGateEvent: typeof writeGateEvent;
};
export = _default;
