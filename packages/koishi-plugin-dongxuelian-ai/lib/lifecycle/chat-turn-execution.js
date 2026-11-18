"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatTurn = createChatTurn;
exports.submitChatTurn = submitChatTurn;
/** 聊天入口的预算接线与单次失败提示，不持有业务队列或重新实现消息路由。 */
const node_fs_1 = require("node:fs");
const chat_turn_budget_1 = require("./chat-turn-budget");
const { enqueueForChannel } = require('./channel-task-queue');
const participation_policy_1 = require("../core/participation-policy");
const { MAINTENANCE_FILE } = require('../core/constants');
// 从已解析的入口身份建立预算；无须聊天时没有常驻记录，阶段计时器由解析器释放。
function createChatTurn(channelKey, session, ctx) {
    return new chat_turn_budget_1.ChatTurnBudget({ channelKey, messageId: session.messageId }, event => ctx.logger('dongxuelian-ai').info(`chat_turn ${JSON.stringify(event)}`), () => (0, participation_policy_1.isSessionParticipationEnabled)(session) && !(0, node_fs_1.existsSync)(MAINTENANCE_FILE));
}
// 消费入队拒绝及异步过期，明确交互至多一次提示，随机和主动撤销保持静默。
function submitChatTurn(turn, session, fn, maxDepth, options) {
    turn.select(options.recordImages, options.random);
    const accepted = enqueueForChannel(turn.identity.channelKey, fn, maxDepth, {
        turn,
        isActive: () => (0, participation_policy_1.isSessionParticipationEnabled)(session) && !(0, node_fs_1.existsSync)(MAINTENANCE_FILE) && options.isFresh(),
        onSettled: reason => (0, chat_turn_budget_1.outsideChatTurn)(async () => {
            if (turn.random || !['queue_full', 'run_timeout', 'cleanup_failed'].includes(reason)
                || turn.submittedSends || !(0, participation_policy_1.isSessionParticipationEnabled)(session) || (0, node_fs_1.existsSync)(MAINTENANCE_FILE))
                return;
            const message = reason === 'queue_full' ? '消息回不过来了，等下再发吧'
                : reason === 'cleanup_failed' && turn.reason !== 'run_timeout'
                    ? '现在有点忙，请稍后再试。'
                    : turn.imagesRead > 0 && turn.imagesRead === turn.imagesTotal
                        ? '已完成图片读取，本轮回答已超时或取消。'
                        : turn.imagesTotal > turn.imagesRead ? `本轮图片读取超时，仍有${turn.imagesTotal - turn.imagesRead}张未读完，请稍后再试。` : '请求超时了，一会再来。';
            let timer;
            turn.event('settlement_send_start');
            try {
                // 平台发送没有可验证的取消接口；到期只记录结果未知，绝不重发。
                await Promise.race([Promise.resolve(session.send(message)).then(() => turn.event('settlement_send_result')),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send_result_unknown')), turn.sendWindow()); })]);
            }
            catch {
                turn.event('settlement_send_unknown');
            }
            finally {
                clearTimeout(timer);
            }
        }),
    });
    if (!accepted)
        turn.event('queue_rejected');
    return accepted;
}
