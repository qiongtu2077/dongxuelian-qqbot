/**
 * MODULE: GitHub 共用卡片模板与仓库、用户渲染。
 * 职责: 统一工业风框架、转义官方字段、读取有界头像并复用现有模板渲染器。
 * 边界: 不获取或清理 Issue/PR 正文、不调用模型；仅拥有有界头像缓存。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
export declare function escapeGithubText(value: string): string;
export declare function loadGithubAvatar(raw: string, context: GithubWorkContext, transport?: typeof fetch): Promise<Buffer | null>;
export declare function buildGithubCardFrame(metadata: GithubMetadata, kind: 'ISSUE' | 'PULL REQUEST' | 'REPOSITORY' | 'USER', content: string, note?: string): string;
export declare function buildGithubCardHtml(metadata: GithubMetadata, avatar: Buffer | null, note?: string): string;
export declare function splitGithubImage(raw: Buffer, context: GithubWorkContext): Promise<Buffer[]>;
export declare function renderGithubCard(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
export declare function githubTextFallback(metadata: GithubMetadata): string;
