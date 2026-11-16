import http = require('http');
/** 签发 45 秒内可使用一次的票据，过期票据在签发和使用时清理。 */
export declare function desktopTicket(req: http.IncomingMessage): string;
/** 返回只连接当前项目的扫码桌面，供应商静态文件严格限制在 noVNC 根目录。 */
export declare function serveSlDesktop(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean;
/** 安装管理员桌面 WebSocket 桥接，超时、错误、退出均释放 TCP 和定时器。 */
export declare function installSlDesktop(server: http.Server): void;
