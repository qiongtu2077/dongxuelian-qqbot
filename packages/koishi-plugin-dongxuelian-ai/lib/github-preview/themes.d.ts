import type { GithubPullTheme } from './models';
export declare function normalizeGithubTheme(value: string): GithubPullTheme | null;
export declare class GithubPreviewThemes {
    private readonly save;
    private readonly warn;
    private themes;
    private updates;
    readonly file: string;
    constructor(directory?: string, save?: (file: string, value: unknown) => Promise<void>, warn?: (message: string) => void);
    theme(group: string): GithubPullTheme;
    update(group: string, theme: GithubPullTheme): Promise<boolean>;
}
export declare function handleGithubThemeCommand(group: string | undefined, isDirect: boolean | undefined, plain: string, themes: GithubPreviewThemes): Promise<string>;
