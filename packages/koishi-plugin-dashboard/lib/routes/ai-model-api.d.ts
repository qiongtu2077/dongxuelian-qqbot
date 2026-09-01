/**
 * MODULE: AI 模型与 API 统一配置路由。
 * 职责: 提供脱敏配置读取、模型发现即保存、单能力优先级保存和能力用量聚合。
 * 边界: 所有写入均走多文件原子事务；不接受自定义供应商、URL 或 Key 文件名。
 */
import type { IncomingMessage, ServerResponse } from 'http';
type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown;
declare function handleGetAiModelApiConfig(req: IncomingMessage, res: ServerResponse): void;
declare function handleDiscoverAiModels(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutAiCapabilityPriority(req: IncomingMessage, res: ServerResponse): void;
declare function buildCapabilityUsage(capability: string): Record<string, unknown>;
declare function handleGetCapabilityUsage(req: IncomingMessage, res: ServerResponse, _pathname: string, url: URL): void;
declare const _default: {
    routes: Record<string, RouteHandler>;
    buildCapabilityUsage: typeof buildCapabilityUsage;
    handleGetAiModelApiConfig: typeof handleGetAiModelApiConfig;
    handleDiscoverAiModels: typeof handleDiscoverAiModels;
    handlePutAiCapabilityPriority: typeof handlePutAiCapabilityPriority;
    handleGetCapabilityUsage: typeof handleGetCapabilityUsage;
};
export = _default;
