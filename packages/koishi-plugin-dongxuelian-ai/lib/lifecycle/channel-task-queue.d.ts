/** 同频道有界串行队列；外层超时绝不释放仍运行的所有者。 */
import { ChatTurnBudget } from './chat-turn-budget';
type QueueResult = 'completed' | 'failed' | 'queue_timeout' | 'queue_full' | 'run_timeout' | 'revoked' | 'disposed' | 'cleanup_failed';
interface QueueOptions {
    ctx?: unknown;
    maxQueueAgeMs?: number;
    turn?: ChatTurnBudget;
    isActive?: () => boolean;
    onSettled?: (reason: QueueResult) => void | Promise<void>;
}
declare function enqueueForChannel(channelKey: string, fn: () => Promise<unknown> | unknown, maxDepth: number, options?: QueueOptions): boolean;
declare function clearChannelQueues(): Promise<void>;
declare const _default: {
    enqueueForChannel: typeof enqueueForChannel;
    clearChannelQueues: typeof clearChannelQueues;
};
export = _default;
