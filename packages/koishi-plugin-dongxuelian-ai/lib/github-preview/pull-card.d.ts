/**
 * MODULE: GitHub PR 看板风格卡片。
 * 职责: 用进度看板详情视图的暗色版式离线渲染合并请求卡片（状态、统计、评审、检查、正文）。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫与官方字段合同。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export declare function buildGithubPullHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note?: string): string;
export declare function renderGithubPullCard(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
