interface LocalTask {
    label: string;
    logFile: string;
    state: string;
    running: boolean;
    startedAt: number;
    finishedAt: number;
    exitCode: number | null;
    error: string;
    pid: number;
    command: string;
    cwd: string;
    process: {
        killed?: boolean;
    } | null;
    diagnostics?: unknown;
}
interface SpawnLocalTaskOptions {
    diagnostics?: unknown;
    cwd?: string;
    env?: Record<string, string>;
    shell?: boolean;
}
declare function getRebuildStatus(): {
    state: string;
    message: string;
    detail: string;
    startedAt: number;
    finishedAt: number;
};
declare function setRebuildStatus(s: any): void;
declare function getNpmDiagnosticsCache(): {
    at: number;
    data: any;
};
declare function setNpmDiagnosticsCache(c: any): void;
declare function appendLocalTaskLog(task: any, chunk: any): void;
declare function getTaskPublicStatus(key: any, extra?: Record<string, unknown>): {
    state: string;
    running: boolean;
    startedAt: number;
    finishedAt: number;
    exitCode: number;
    error: string;
    pid: number;
    command: string;
    cwd: string;
    logFile: string;
    logLines: any;
};
declare function spawnLocalTask(key: any, command: any, args?: any[], options?: SpawnLocalTaskOptions): {
    alreadyRunning: boolean;
    status: {
        state: string;
        running: boolean;
        startedAt: number;
        finishedAt: number;
        exitCode: number;
        error: string;
        pid: number;
        command: string;
        cwd: string;
        logFile: string;
        logLines: any;
    };
};
declare function waitKoishiPortFree(): void;
declare const _default: {
    localTasks: Record<string, LocalTask>;
    getRebuildStatus: typeof getRebuildStatus;
    setRebuildStatus: typeof setRebuildStatus;
    getNpmDiagnosticsCache: typeof getNpmDiagnosticsCache;
    setNpmDiagnosticsCache: typeof setNpmDiagnosticsCache;
    appendLocalTaskLog: typeof appendLocalTaskLog;
    getTaskPublicStatus: typeof getTaskPublicStatus;
    spawnLocalTask: typeof spawnLocalTask;
    waitKoishiPortFree: typeof waitKoishiPortFree;
};
export = _default;
