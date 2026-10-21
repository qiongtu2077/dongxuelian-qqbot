/**
 * MODULE: GitHub 当前消息链接解析。
 * 职责: 识别四类固定公开路径并规范化身份。
 * 边界: 不请求网络、不读取历史、不调用模型；无可变缓存。
 */
import type { GithubTarget } from './models';
export declare function parseGithubTarget(raw: string): GithubTarget | null;
export declare function extractGithubTargets(text: string): GithubTarget[];
export declare function isGithubPreviewCommand(text: string): boolean;
