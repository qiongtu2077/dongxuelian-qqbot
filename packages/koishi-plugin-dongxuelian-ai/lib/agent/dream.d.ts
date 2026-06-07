type DreamResult = {
    success: false;
    reason: string;
    taskId?: string;
} | {
    success: true;
    queued: true;
    taskId: string;
    status: string;
};
declare function runDream(userId: unknown): Promise<DreamResult>;
declare function runDreamIfNeeded(userId: unknown): Promise<DreamResult | null>;
declare function getDreamStatus(userId: unknown): Promise<Record<string, unknown>>;
declare const _default: {
    DASHBOARD_MEMORY_DIR: string;
    DAILY_DIR: string;
    runDream: typeof runDream;
    runDreamIfNeeded: typeof runDreamIfNeeded;
    getDreamStatus: typeof getDreamStatus;
    getLongTermFile: (userId: unknown) => string;
    readLongTermFile: (userId: unknown) => Promise<string>;
    safeUserId: (value?: string) => string;
};
export = _default;
