/**
 * MODULE: GitHub 官方公开元数据。
 * 职责: 公开性校验、类型分流、固定字段读取、限流与条件请求。
 * 边界: 不总结正文、不调用模型；实例拥有有界元数据缓存和串行请求链。
 */
import type { GithubTarget, GithubMetadata, GithubWorkContext } from './models';
export declare class GithubQueryError extends Error {
    readonly status: number;
    readonly transient: boolean;
    constructor(message: string, status?: number, transient?: boolean);
}
export declare class GithubPreviewClient {
    private readonly transport;
    private readonly token;
    private cache;
    private serial;
    private blockedUntil;
    constructor(transport?: typeof fetch, token?: string);
    private request;
    private requestSerial;
    private remember;
    lookup(target: GithubTarget, context: GithubWorkContext): Promise<GithubMetadata>;
}
