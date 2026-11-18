/** 聊天入口的预算接线与单次失败提示，不持有业务队列或重新实现消息路由。 */
import { existsSync } from 'node:fs'
import { ChatTurnBudget, outsideChatTurn } from './chat-turn-budget'
const { enqueueForChannel } = require('./channel-task-queue') as typeof import('./channel-task-queue')
import { isSessionAllowedByPolicy, isSessionParticipationEnabled, readParticipationPolicy } from '../core/participation-policy'
import type { ParticipationPolicy } from '../core/participation-policy'
const { MAINTENANCE_FILE } = require('../core/constants') as typeof import('../core/constants')

interface TurnSession {
  guildId?: string; channelId?: string; isDirect?: boolean; userId?: string; messageId?: string
  send(content: string): unknown | Promise<unknown>
}
interface TurnContext { logger(name: string): { info(message: string): void } }

export interface ChatQueuePolicy {
  participation: ParticipationPolicy
  maintenance: boolean
}

// 从文件读取一次本轮队列监视共用的授权状态。
function readChatQueuePolicy(): ChatQueuePolicy {
  return { participation: readParticipationPolicy(), maintenance: existsSync(MAINTENANCE_FILE) }
}

// 从已解析的入口身份建立预算；无须聊天时没有常驻记录，阶段计时器由解析器释放。
export function createChatTurn(channelKey: string, session: TurnSession, ctx: TurnContext): ChatTurnBudget {
  return new ChatTurnBudget({ channelKey, messageId: session.messageId }, event => ctx.logger('dongxuelian-ai').info(`chat_turn ${JSON.stringify(event)}`),
    () => isSessionParticipationEnabled(session) && !existsSync(MAINTENANCE_FILE))
}

// 消费入队拒绝及异步过期，明确交互至多一次提示，随机和主动撤销保持静默。
export function submitChatTurn(turn: ChatTurnBudget, session: TurnSession, fn: () => Promise<unknown> | unknown,
  maxDepth: number, options: { random: boolean; recordImages: boolean; isFresh: () => boolean }): boolean {
  turn.select(options.recordImages, options.random)
  const accepted = enqueueForChannel(turn.identity.channelKey, fn, maxDepth, {
    turn,
    isActive: () => isSessionParticipationEnabled(session) && !existsSync(MAINTENANCE_FILE) && options.isFresh(),
    monitor: {
      readPolicy: readChatQueuePolicy,
      isActive: policy => isSessionAllowedByPolicy(session, policy.participation) && !policy.maintenance && options.isFresh(),
    },
    onSettled: reason => outsideChatTurn(async () => {
      if (turn.random || !['queue_full', 'run_timeout', 'cleanup_failed'].includes(reason)
        || turn.submittedSends || !isSessionParticipationEnabled(session) || existsSync(MAINTENANCE_FILE)) return
      const message = reason === 'queue_full' ? '消息回不过来了，等下再发吧'
        : reason === 'cleanup_failed' && turn.reason !== 'run_timeout'
        ? '现在有点忙，请稍后再试。'
        : turn.imagesRead > 0 && turn.imagesRead === turn.imagesTotal
          ? '已完成图片读取，本轮回答已超时或取消。'
          : turn.imagesTotal > turn.imagesRead ? `本轮图片读取超时，仍有${turn.imagesTotal - turn.imagesRead}张未读完，请稍后再试。` : '请求超时了，一会再来。'
      let timer: ReturnType<typeof setTimeout> | undefined
      turn.event('settlement_send_start')
      try {
        // 平台发送没有可验证的取消接口；到期只记录结果未知，绝不重发。
        await Promise.race([Promise.resolve(session.send(message)).then(() => turn.event('settlement_send_result')),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send_result_unknown')), turn.sendWindow()) })])
      } catch { turn.event('settlement_send_unknown') }
      finally { clearTimeout(timer) }
    }),
  })
  if (!accepted) turn.event('queue_rejected')
  return accepted
}
