import { ChatTurnBudget } from './chat-turn-budget';
import type { ParticipationPolicy } from '../core/participation-policy';
interface TurnSession {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    messageId?: string;
    send(content: string): unknown | Promise<unknown>;
}
interface TurnContext {
    logger(name: string): {
        info(message: string): void;
    };
}
export interface ChatQueuePolicy {
    participation: ParticipationPolicy;
    maintenance: boolean;
}
export declare function createChatTurn(channelKey: string, session: TurnSession, ctx: TurnContext): ChatTurnBudget;
export declare function submitChatTurn(turn: ChatTurnBudget, session: TurnSession, fn: () => Promise<unknown> | unknown, maxDepth: number, options: {
    random: boolean;
    recordImages: boolean;
    isFresh: () => boolean;
}): boolean;
export {};
