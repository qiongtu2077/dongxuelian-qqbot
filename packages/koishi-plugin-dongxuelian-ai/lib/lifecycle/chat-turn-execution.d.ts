import { ChatTurnBudget } from './chat-turn-budget';
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
export declare function createChatTurn(channelKey: string, session: TurnSession, ctx: TurnContext): ChatTurnBudget;
export declare function submitChatTurn(turn: ChatTurnBudget, session: TurnSession, fn: () => Promise<unknown> | unknown, maxDepth: number, options: {
    random: boolean;
    recordImages: boolean;
    isFresh: () => boolean;
}): boolean;
export {};
