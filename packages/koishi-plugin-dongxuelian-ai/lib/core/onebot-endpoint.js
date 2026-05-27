"use strict";
/**
 * MODULE: OneBot endpoint 配置。
 * 职责: 统一读取并校验本机 OneBot WebSocket 地址。
 * 边界: 不建立连接、不处理 OneBot 协议。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_ONEBOT_WS_URL = 'ws://127.0.0.1:8080/onebot/v11/ws';
function resolveOneBotWsUrl() {
    const raw = String(process.env.DONGXUELIAN_ONEBOT_WS_URL || process.env.ONEBOT_WS_URL || DEFAULT_ONEBOT_WS_URL).trim();
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error('OneBot WebSocket 地址格式无效');
    }
    if (parsed.protocol !== 'ws:')
        throw new Error('OneBot WebSocket 只允许 ws:// loopback 地址');
    const host = parsed.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(host))
        throw new Error('OneBot WebSocket 只允许连接本机 loopback 地址');
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
}
module.exports = {
    DEFAULT_ONEBOT_WS_URL,
    resolveOneBotWsUrl,
};
