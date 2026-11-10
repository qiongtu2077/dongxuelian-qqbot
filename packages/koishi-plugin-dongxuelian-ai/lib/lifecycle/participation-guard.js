"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParticipationDisabledError = void 0;
exports.installParticipationGuard = installParticipationGuard;
/**
 * MODULE: QQ 参与策略的适配器接线。
 * 职责: 在 OneBot 分发前拦截关闭的会话，在传输前阻止关闭目标的操作。
 * 边界: 不改适配器源码，不改变登录、心跳、管理查询和其他平台。
 * 状态: 每个安装实例保存还原记录，插件卸载时恢复原对象。
 */
const { isSessionParticipationEnabled, isOneBotActionAllowed } = require('../core/participation-policy');
// 表示总开关阻止发送，调用方会走已有取消或失败清理路径。
class ParticipationDisabledError extends Error {
    constructor() {
        super('目标群聊或私聊总开关已关闭');
        this.code = 'PARTICIPATION_DISABLED';
        this.name = 'ParticipationDisabledError';
    }
}
exports.ParticipationDisabledError = ParticipationDisabledError;
// 包装真实 transport 的读取，适配器重连时的赋值和删除仍作用于原对象。
function guardInternal(original) {
    return new Proxy(original, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== '_request' || typeof value !== 'function')
                return value;
            return async (action, params = {}) => {
                if (!isOneBotActionAllowed(action, params))
                    throw new ParticipationDisabledError();
                return Reflect.apply(value, target, [action, params]);
            };
        },
    });
}
// 安装在已存在和后续连接的 OneBot 实例上，使所有业务插件共用同一边界。
function installParticipationGuard(ctx) {
    const installed = new Map();
    // 对每个 OneBot 只安装一次，保留原 dispatch 和 internal 以支持热卸载。
    const install = (bot) => {
        if (bot.platform !== 'onebot' || installed.has(bot))
            return;
        const dispatch = bot.dispatch;
        const internal = bot.internal;
        if (!dispatch || !internal)
            throw new Error('OneBot 参与策略安装失败：适配器未初始化');
        const guardedInternal = guardInternal(internal);
        // 在事件进入各插件之前阻止消息、群通知及私聊，不产生拒绝提示。
        const guardedDispatch = function (session) {
            try {
                if (!isSessionParticipationEnabled(session))
                    return;
            }
            catch (error) {
                ctx.logger('participation').warn(`参与策略读取失败，已阻止会话：${error.message}`);
                return;
            }
            return dispatch.call(this, session);
        };
        bot.dispatch = guardedDispatch;
        bot.internal = guardedInternal;
        installed.set(bot, () => {
            if (bot.dispatch === guardedDispatch)
                bot.dispatch = dispatch;
            if (bot.internal === guardedInternal)
                bot.internal = internal;
        });
    };
    for (const bot of ctx.bots || [])
        install(bot);
    ctx.on('bot-connect', install);
    ctx.on('dispose', () => { for (const restore of installed.values())
        restore(); installed.clear(); });
}
