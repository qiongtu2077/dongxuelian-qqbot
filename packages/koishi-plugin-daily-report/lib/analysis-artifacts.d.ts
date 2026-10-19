import type { AnalysisRuntime } from './complete-input';
interface TaskArtifactOptions {
    taskId: string;
    channelKey: string;
    deadlineMs: number;
    assertActive(): void;
    assertLease(): void;
    now?: () => number;
}
export declare function createTaskArtifactStore(options: TaskArtifactOptions): Pick<AnalysisRuntime, 'onUnitCompleted' | 'onUnitFailed'>;
export {};
