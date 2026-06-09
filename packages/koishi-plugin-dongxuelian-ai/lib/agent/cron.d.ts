interface CronRuntime {
    bot: unknown;
}
interface CronFileData {
    crons: CronEntry[];
    history: CronHistoryEntry[];
}
interface CronHistoryEntry {
    at?: number;
    id?: string;
    mode?: string;
    ok?: boolean;
    result?: string;
    [key: string]: unknown;
}
interface CronEntry {
    id: string;
    title: string;
    description: string;
    taskKind: string;
    schedule: string;
    mode: 'once' | 'cron';
    type: 'text' | 'agent';
    prompt: string;
    targetChannel: string;
    targetUserId: string;
    createdFrom: string;
    enabled: boolean;
    status: string;
    timezone: string;
    scheduleText: string;
    visibility: 'private' | 'channel';
    delivery: {
        targetChannel: string;
        targetUserId: string;
        userRequested: boolean;
        quoteSource: boolean;
        silentOnNoResult: boolean;
    };
    contextPolicy: {
        allowReadGroupContext: boolean;
        allowExternalTools: boolean;
        anchorMessageIds: string[];
        fileAnchor: {
            messageId: string;
            fileName: string;
        } | null;
        allowedTools: string[];
    };
    runPolicy: {
        maxRuntimeMs: number;
        allowOverlap: boolean;
        misfirePolicy: string;
    };
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    lastRunAt: number;
    runAt: number;
    nextRunAt: number;
    stats: {
        runCount: number;
        failCount: number;
        lastError: string;
        lastResultPreview: string;
    };
    history: Array<{
        at: number;
        ok: boolean;
        result: string;
    }>;
}
interface CronRunResult {
    ok: boolean;
    cron?: CronEntry;
    result: string;
}
declare function saveCrons(next: unknown): Promise<CronFileData>;
declare function loadCrons(): Promise<CronFileData>;
declare function parseCronField(field: unknown, min: number, max: number): {
    step?: number;
    values?: number[];
} | null;
declare function validateCronSchedule(schedule: unknown): boolean;
declare function cronMatches(date: Date, schedule: string): boolean;
declare function getNextRunAt(schedule: string, from?: number): number;
declare function createCronId(prefix?: string): string;
declare function appendHistory(entry: CronHistoryEntry): Promise<CronFileData>;
declare function registerCron(cron: unknown): Promise<CronEntry | undefined>;
declare function getCron(id: string): Promise<CronEntry | null>;
declare function registerOnceTask(task?: Record<string, unknown>): Promise<CronEntry | undefined>;
declare function unregisterCron(id: string): Promise<number>;
declare function updateCron(id: string, patch?: Record<string, unknown>): Promise<CronEntry | null>;
declare function pauseCron(id: string): Promise<CronEntry | null>;
declare function resumeCron(id: string): Promise<CronEntry | null>;
declare function runCronNow(id: string): Promise<CronRunResult>;
declare function listCronHistory(limit?: unknown): Promise<CronHistoryEntry[]>;
declare function startCronScheduler(options?: Partial<CronRuntime>): Promise<number>;
declare function stopCronScheduler(): void;
declare const _default: {
    CRON_FILE: string;
    loadCrons: typeof loadCrons;
    saveCrons: typeof saveCrons;
    registerCron: typeof registerCron;
    getCron: typeof getCron;
    registerOnceTask: typeof registerOnceTask;
    unregisterCron: typeof unregisterCron;
    updateCron: typeof updateCron;
    pauseCron: typeof pauseCron;
    resumeCron: typeof resumeCron;
    runCronNow: typeof runCronNow;
    listCronHistory: typeof listCronHistory;
    startCronScheduler: typeof startCronScheduler;
    stopCronScheduler: typeof stopCronScheduler;
    getNextRunAt: typeof getNextRunAt;
    validateCronSchedule: typeof validateCronSchedule;
    parseCronField: typeof parseCronField;
    cronMatches: typeof cronMatches;
    appendHistory: typeof appendHistory;
    createCronId: typeof createCronId;
};
export = _default;
