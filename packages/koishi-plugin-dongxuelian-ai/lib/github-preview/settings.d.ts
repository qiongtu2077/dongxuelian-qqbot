export declare function normalizeGithubGroup(value: string): string | null;
export declare class GithubPreviewSettings {
    private readonly save;
    private readonly warn;
    private groups;
    private versions;
    private generation;
    private updates;
    private listeners;
    readonly file: string;
    constructor(directory?: string, save?: (file: string, value: unknown) => Promise<void>, warn?: (message: string) => void);
    list(): string[];
    enabled(group: string): boolean;
    version(group: string): number;
    onRemoved(listener: (group: string) => void): () => void;
    update(group: string, enabled: boolean): Promise<boolean>;
}
