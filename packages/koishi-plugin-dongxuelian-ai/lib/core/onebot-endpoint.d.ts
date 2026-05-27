/**
 * MODULE: OneBot endpoint 配置。
 * 职责: 统一读取并校验本机 OneBot WebSocket 地址。
 * 边界: 不建立连接、不处理 OneBot 协议。
 */
declare function resolveOneBotWsUrl(): string;
declare const _default: {
    DEFAULT_ONEBOT_WS_URL: string;
    resolveOneBotWsUrl: typeof resolveOneBotWsUrl;
};
export = _default;
