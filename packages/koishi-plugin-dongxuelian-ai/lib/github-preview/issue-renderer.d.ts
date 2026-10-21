/**
 * MODULE: 议题与合并请求本地卡片。
 * 职责: 官方正文工业风排版、共用渲染器调用与连续图片输出。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export declare function buildGithubIssueHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note?: string): string;
export declare function splitGithubImage(raw: Buffer, context: GithubWorkContext): Promise<Buffer[]>;
export declare function renderGithubIssue(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
