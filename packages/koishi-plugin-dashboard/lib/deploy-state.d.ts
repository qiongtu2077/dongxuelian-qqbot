import type { ChildProcessWithoutNullStreams } from 'child_process';
type LocalTaskKey = 'npmInstall' | 'napcat' | 'koishi';
type LocalTaskState = 'idle' | 'running' | 'success' | 'failed';
interface LocalTask {
    label: string;
    logFile: string;
    state: LocalTaskState;
    running: boolean;
    startedAt: number;
    finishedAt: number;
    exitCode: number | null;
    error: string;
    pid: number;
    command: string;
    cwd: string;
    process: ChildProcessWithoutNullStreams | null;
    warnings: string[];
    diagnostics?: unknown;
}
interface SpawnLocalTaskOptions {
    diagnostics?: unknown;
    cwd?: string;
    env?: Record<string, string | undefined>;
    shell?: boolean;
}
interface RebuildStatus {
    state: string;
    message: string;
    detail: string;
    startedAt: number;
    finishedAt: number;
}
interface NpmDiagnosticsCache {
    at: number;
    data: unknown | null;
}
interface LocalTaskPublicStatus {
    state: LocalTaskState;
    running: boolean;
    startedAt: number;
    finishedAt: number;
    exitCode: number | null;
    error: string;
    pid: number;
    command: string;
    cwd: string;
    logFile: string;
    logLines: string[];
    warnings: string[];
    [key: string]: unknown;
}
interface SpawnLocalTaskResult {
    alreadyRunning: boolean;
    status: LocalTaskPublicStatus;
}
declare function getRebuildStatus(): RebuildStatus;
declare function setRebuildStatus(s: RebuildStatus): void;
declare function getNpmDiagnosticsCache(): NpmDiagnosticsCache;
declare function setNpmDiagnosticsCache(c: NpmDiagnosticsCache): void;
declare function appendLocalTaskLog(task: LocalTask, chunk: Buffer | string): void;
declare function getTaskPublicStatus(key: LocalTaskKey, extra?: Record<string, unknown>): LocalTaskPublicStatus;
declare function spawnLocalTask(key: LocalTaskKey, command: string, args?: string[], options?: SpawnLocalTaskOptions): SpawnLocalTaskResult;
declare function waitKoishiPortFree(): void;
declare const _default: {
    localTasks: Record<LocalTaskKey, LocalTask>;
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
