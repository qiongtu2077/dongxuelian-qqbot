/** 为控制台鉴权提供逐请求来源证明，仅使用服务端本地配置。 */
import type { IncomingMessage } from 'node:http';
export declare const TRUSTED_ACCESS_FILE: string;
/** 认可代理的外部站点时仍让普通来源使用口令。 */
export declare function trustedOrigin(req: IncomingMessage): string | undefined;
/** 只有服务进程的专用 Unix 监听器能够登记此请求。 */
export declare function markSshRequest(req: IncomingMessage): void;
/** 启动阶段启用私有监听器，之后每次授权仍需核对当前配置。 */
export declare function needsSshListener(): boolean;
/** 只允许控制台操作与自检；凭据管理、第三方代理、扫码桌面保留独立校验。 */
export declare function hasTrustedDashboardAccess(req: IncomingMessage, pathname: string): boolean;
