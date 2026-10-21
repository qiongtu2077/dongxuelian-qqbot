/**
 * MODULE: GitHub 查询流程。
 * 职责: 管理群开关、串行任务、共享资源准入、图片缓存及发送前复核。
 * 边界: 不进入聊天模型；实例拥有有界队列、冷却、图片缓存和取消控制器。
 */
import type { GithubTarget, GithubMetadata, GithubImageResult, GithubWorkContext } from './models';
import { GithubPreviewSettings } from './settings';
export interface GithubSession {
    guildId?: string;
    channelId?: string;
    userId?: string;
    selfId?: string;
    isDirect?: boolean;
    messageId?: string;
    author?: {
        id?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
    };
    send(message: unknown): Promise<unknown>;
}
interface GithubRuntimeDependencies {
    lookup(target: GithubTarget, context: GithubWorkContext): Promise<GithubMetadata>;
    screenshot(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
    render(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>;
    acquire(context: GithubWorkContext, group: string): Promise<() => void>;
    log(message: string): void;
}
export declare function acquireGithubResources(context: GithubWorkContext, group: string): Promise<() => void>;
export declare class GithubPreviewRuntime {
    readonly settings: GithubPreviewSettings;
    private readonly deps;
    private queue;
    private active;
    private pumping;
    private disposed;
    private cooldowns;
    private messages;
    private images;
    private readonly unsubscribe;
    constructor(settings?: GithubPreviewSettings, dependencies?: Partial<GithubRuntimeDependencies>);
    accepts(session: GithubSession, plain: string): boolean;
    private command;
    handle(session: GithubSession, plain: string): Promise<string | undefined>;
    private valid;
    private cancelGroup;
    private pump;
    private cacheImage;
    private deliver;
    private run;
    dispose(): void;
}
export {};
