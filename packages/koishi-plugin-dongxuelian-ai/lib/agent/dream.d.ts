type DreamResult = {
    success: false;
    reason: string;
} | {
    success: true;
    beforeSize: number;
    afterSize: number;
    deletedFiles: number;
};
interface DreamStatus {
    userId: string;
    dailyTotalSize: number;
    threshold: number;
    needsDream: boolean;
}
declare function getLongTermFile(userId: unknown): string;
declare function readLongTermFile(userId: unknown): Promise<string>;
declare function runDream(userId: unknown): Promise<DreamResult>;
declare function runDreamIfNeeded(userId: unknown): Promise<DreamResult | null>;
declare function getDreamStatus(userId: unknown): Promise<DreamStatus>;
declare const _default: {
    DASHBOARD_MEMORY_DIR: string;
    DAILY_DIR: string;
    runDream: typeof runDream;
    runDreamIfNeeded: typeof runDreamIfNeeded;
    getDreamStatus: typeof getDreamStatus;
    getLongTermFile: typeof getLongTermFile;
    readLongTermFile: typeof readLongTermFile;
    safeUserId: (value?: string) => string;
};
export = _default;
