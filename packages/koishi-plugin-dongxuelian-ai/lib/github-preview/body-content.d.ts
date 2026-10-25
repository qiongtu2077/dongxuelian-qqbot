import type { GithubWorkContext } from './models';
export interface GithubBodyImage {
    url: string;
    alt: string;
}
export interface GithubPreparedBody {
    html: string;
    missing: number;
    animations: number;
    images: Buffer[];
}
export declare function cleanGithubBody(raw: string, base: string): {
    html: string;
    images: GithubBodyImage[];
};
export declare function isGithubBodyImageUrl(raw: string): boolean;
export declare function prepareGithubBody(raw: string, base: string, context: GithubWorkContext, transport?: typeof fetch, resolve?: (url: string) => Promise<unknown>, options?: {
    separateImages?: boolean;
}): Promise<GithubPreparedBody>;
