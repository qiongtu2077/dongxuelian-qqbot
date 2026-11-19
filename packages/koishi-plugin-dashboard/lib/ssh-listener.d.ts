import { type RequestListener } from 'node:http';
/** 为已经启用隧道模式的服务创建用户私有套接字。 */
export declare function startSshListener(handler: RequestListener): import("node:http").Server<typeof import("node:http").IncomingMessage, typeof import("node:http").ServerResponse> | undefined;
