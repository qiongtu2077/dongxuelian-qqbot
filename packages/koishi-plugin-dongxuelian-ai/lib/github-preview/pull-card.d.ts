/**
 * MODULE: GitHub PR 看板详情与正文长截图。
 * 职责: 首图离线渲染明暗看板详情，后续输出原工业风正文的连续切片。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫与官方字段合同。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext, GithubPullTheme } from './models';
export declare function buildGithubPullHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note?: string, theme?: GithubPullTheme): string;
export declare function renderGithubPullCard(metadata: GithubMetadata, context: GithubWorkContext, theme?: GithubPullTheme): Promise<GithubImageResult>;
