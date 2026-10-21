/**
 * MODULE: GitHub 仓库和用户卡片。
 * 职责: 转义官方字段、读取有界头像并复用现有模板渲染器。
 * 边界: 不制作 Issue/PR 正文卡片、不调用模型；仅拥有有界头像缓存。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export declare function escapeGithubText(value: string): string;
export declare function loadGithubAvatar(raw: string, context: GithubWorkContext, transport?: typeof fetch): Promise<Buffer | null>;
export declare function buildGithubCardHtml(metadata: GithubMetadata, avatar: Buffer | null): string;
export declare function renderGithubCard(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
export declare function githubTextFallback(metadata: GithubMetadata): string;
