type ResourceTask = import('./task-types').ResourceTask;
interface AutoMemoryMessage {
    role?: unknown;
    content?: unknown;
}
type DreamResult = {
    success: false;
    reason: string;
} | {
    success: true;
    beforeSize: number;
    afterSize: number;
    deletedFiles: number;
};
interface MemorySubmissionOptions {
    userId: unknown;
    recentMessages?: AutoMemoryMessage[];
    source?: string;
}
interface MemorySubmissionResult {
    accepted: boolean;
    task?: ResourceTaskLike;
    admission?: AdmissionDecisionLike;
    taskId?: string;
    status: string;
    message: string;
}
type ResourceTaskLike = Partial<Pick<ResourceTask, 'id' | 'kind' | 'userId' | 'payload'>>;
interface AdmissionDecisionLike {
    decision?: string;
    reason?: unknown;
}
interface MemoryWorkerTaskLike extends ResourceTaskLike {
    payload?: {
        userId?: unknown;
        recentMessages?: unknown;
    };
}
declare function getLongTermFile(userId: unknown): string;
declare function getDailyTotalSize(userId: unknown): Promise<number>;
declare function readLongTermFile(userId: unknown): Promise<string>;
declare function extractMemoryDirect(recentMessages: AutoMemoryMessage[], userId: unknown): Promise<string | null>;
declare function runDreamDirect(userId: unknown): Promise<DreamResult>;
declare function submitAgentMemoryTask(options: MemorySubmissionOptions): MemorySubmissionResult;
declare function submitAgentMemoryCompactionTask(userId: unknown, source?: string): MemorySubmissionResult;
declare function runMemoryWorkerTask(task: MemoryWorkerTaskLike): Promise<Record<string, unknown>>;
declare function getDreamStatus(userId: unknown): Promise<Record<string, unknown>>;
declare const _default: {
    DASHBOARD_MEMORY_DIR: string;
    DAILY_DIR: string;
    AUTO_MEMORY_INTERVAL: number;
    AUTO_MEMORY_WINDOW: number;
    DREAM_SIZE_THRESHOLD: number;
    submitAgentMemoryTask: typeof submitAgentMemoryTask;
    submitAgentMemoryCompactionTask: typeof submitAgentMemoryCompactionTask;
    runMemoryWorkerTask: typeof runMemoryWorkerTask;
    extractMemoryDirect: typeof extractMemoryDirect;
    runDreamDirect: typeof runDreamDirect;
    getDailyTotalSize: typeof getDailyTotalSize;
    getDreamStatus: typeof getDreamStatus;
    getLongTermFile: typeof getLongTermFile;
    readLongTermFile: typeof readLongTermFile;
    safeUserId: (value?: string) => string;
};
export = _default;
