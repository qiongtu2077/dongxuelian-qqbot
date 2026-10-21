import type { Page } from 'puppeteer-core';
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export interface GithubRegion {
    x: number;
    y: number;
    width: number;
    height: number;
    ready: boolean;
    imageCount: number;
    title: string;
}
export declare function allowGithubPageRequest(raw: string, type: string, mainNavigation: boolean): boolean;
export declare function inspectGithubRegion(kind: 'issue' | 'pull', author: string): GithubRegion | null;
export declare function waitForGithubRegion(page: Pick<Page, 'evaluate'>, metadata: GithubMetadata, context: GithubWorkContext, loadDeadline: number): Promise<boolean>;
export declare function findGithubBrowser(): string;
export declare function encodeGithubClips(page: Page, region: GithubRegion, deadline: number): Promise<Buffer[]>;
export declare function screenshotGithubPage(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
