/** Linux 协议切换和 SnowLuma 原生扫码流程的鉴权入口。 */
import type { IncomingMessage, ServerResponse } from 'http';
/** 返回公开的服务选择和运行状态，不暴露凭据与登录桌面。 */
declare function getStatus(req: IncomingMessage, res: ServerResponse): void;
/** 管理员请求切换，严格验证协议枚举并等待服务切换实际完成。 */
declare function postSwitch(req: IncomingMessage, res: ServerResponse): void;
/** 读取真实 SnowLuma 登录引导，首次返回完整协议文本。 */
declare function getSlLogin(req: IncomingMessage, res: ServerResponse): void;
/** 明确点击同意后才将当前协议版本转交官方确认接口。 */
declare function postConsent(req: IncomingMessage, res: ServerResponse): void;
/** 仅管理员能接入当前受管 QQ 进程并完成机器人重连。 */
declare function postConnect(req: IncomingMessage, res: ServerResponse): void;
/** 只为当前已启动且已确认协议的 SL 签发一次性扫码桌面票据。 */
declare function postDesktop(req: IncomingMessage, res: ServerResponse): void;
export declare const routes: {
    'GET /dashboard/api/protocol/status': typeof getStatus;
    'POST /dashboard/api/protocol/switch': typeof postSwitch;
    'GET /dashboard/api/protocol/sl/login': typeof getSlLogin;
    'POST /dashboard/api/protocol/sl/consent': typeof postConsent;
    'POST /dashboard/api/protocol/sl/connect': typeof postConnect;
    'POST /dashboard/api/protocol/sl/desktop': typeof postDesktop;
};
export {};
