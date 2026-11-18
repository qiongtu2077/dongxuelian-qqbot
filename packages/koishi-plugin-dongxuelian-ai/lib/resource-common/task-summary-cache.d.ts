export interface TaskSummaryDirectory {
    path: string;
    recursive?: boolean;
}
export interface TaskFileSummary<T> {
    file: string;
    directory: string;
    value: T;
}
export declare function indexTaskFileAliases<T extends {
    id: string;
}>(files: readonly TaskFileSummary<T>[]): Map<string, Set<string>>;
export declare function findDiagnosticTaskFiles(root: TaskSummaryDirectory, target: string, aliases?: ReadonlySet<string>): string[];
export declare function createTaskSummaryCache<T>(directories: readonly TaskSummaryDirectory[], maxBytes: number, summarize: (record: unknown) => T | null): () => Promise<readonly TaskFileSummary<T>[]>;
