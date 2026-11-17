"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installSlOnebotReconnect = installSlOnebotReconnect;
/**
 * MODULE: SnowLuma OneBot 断线状态修复。
 * 职责: 保留正向 WS 适配器已经安排的重试，避免关闭回调将 RECONNECT 覆盖为 OFFLINE。
 * 边界: 仅作用于显式选择 SL 的 OneBot WS；不创建连接、定时器或重启进程。
 * 状态: 每个实例保存 accept 的还原函数和未关闭连接的监听器，关闭或卸载时释放。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
// --- 协议选择 --- //
// 复用 Dashboard 的持久协议选择；未选择 SL 时不改变适配器行为。
function isSlProtocolSelected() {
    let text;
    try {
        text = fs.readFileSync(path.join(DATA_DIR, 'qq-protocol.json'), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    const { provider } = JSON.parse(text);
    if (provider !== 'sl' && provider !== 'napcat')
        throw new Error('QQ 协议选择文件无效');
    return provider === 'sl';
}
// --- 连接关闭与生命周期 --- //
// 在真实 OneBot 关闭回调前后检查状态，仅恢复本次关闭已经安排的重试。
function wrapSlAccept(bot, adapter, ctx) {
    const originalAccept = adapter.accept;
    const connections = new Map();
    let disposed = false;
    // 框架的关闭监听器先运行并安排重试，OneBot.accept 随后错误地调用 offline()。
    const guardedAccept = function (socket) {
        let retryScheduled = false;
        // 只记录框架已安排的重连，不为手动停止或初次连接失败启动重试。
        const rememberRetry = () => { retryScheduled = bot.status === 4 /* Status.RECONNECT */; };
        // 同步移除本连接的两个监听器，不保留已关闭 socket。
        const release = () => {
            socket.removeEventListener('close', rememberRetry);
            socket.removeEventListener('close', preserveRetry);
            connections.delete(socket);
        };
        // 保留原有重试定时器；额外调用 bot.start() 会产生并行连接。
        const preserveRetry = () => {
            release();
            if (disposed || !retryScheduled || bot.status !== 0 /* Status.OFFLINE */)
                return;
            bot.status = 4 /* Status.RECONNECT */;
            ctx.logger('sl-onebot-reconnect').warn(`preserved scheduled retry selfId=${bot.selfId}`);
        };
        socket.addEventListener('close', rememberRetry);
        connections.set(socket, release);
        try {
            originalAccept.call(this, socket);
        }
        catch (error) {
            release();
            throw error;
        }
        socket.addEventListener('close', preserveRetry);
    };
    adapter.accept = guardedAccept;
    // 热卸载还原当前实例；其他安装者后续的改动不被覆盖。
    return () => {
        disposed = true;
        if (adapter.accept === guardedAccept)
            adapter.accept = originalAccept;
        for (const release of connections.values())
            release();
        connections.clear();
    };
}
// 安装到既有及后续启动的 SL 正向 OneBot，插件卸载时移除全部接线。
function installSlOnebotReconnect(ctx) {
    if (!isSlProtocolSelected())
        return;
    const installed = new Map();
    // bot-connect 发生在 adapter.connect 之前，确保首次连接即使用受控关闭顺序。
    const installSlBot = (bot) => {
        if (bot.platform !== 'onebot' || bot.config.protocol !== 'ws' || installed.has(bot))
            return;
        if (!bot.adapter)
            return;
        installed.set(bot, wrapSlAccept(bot, bot.adapter, ctx));
    };
    for (const bot of ctx.bots || [])
        installSlBot(bot);
    ctx.on('bot-connect', installSlBot);
    ctx.on('dispose', () => {
        for (const restore of installed.values())
            restore();
        installed.clear();
    });
}
