import type { GithubTarget, GithubMetadata, GithubWorkContext } from './models';
export declare class GithubGroupRepositories {
    private readonly save;
    private readonly warn;
    private bindings;
    private updates;
    private listeners;
    readonly file: string;
    constructor(directory?: string, save?: (file: string, value: unknown) => Promise<void>, warn?: (message: string) => void);
    get(group: string): GithubTarget | null;
    onChanged(listener: (group: string) => void): () => void;
    update(group: string, repository: GithubTarget | null): Promise<boolean>;
}
export declare function handleGithubRepositoryCommand(group: string | undefined, isDirect: boolean | undefined, plain: string, repositories: GithubGroupRepositories, lookup: (target: GithubTarget, context: GithubWorkContext) => Promise<GithubMetadata>, signal: AbortSignal): Promise<string>;
