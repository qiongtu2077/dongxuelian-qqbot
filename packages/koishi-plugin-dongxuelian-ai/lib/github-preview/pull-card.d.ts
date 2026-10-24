/**
 * MODULE: GitHub PR 前后风格对比卡片。
 * 职责: 离线渲染「前风格工业风卡片」与「后风格看板详情卡片」，同一条消息按序发出两张图。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫与官方字段合同。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export declare function buildGithubPullHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note?: string): string;
export declare function renderGithubPullCard(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
