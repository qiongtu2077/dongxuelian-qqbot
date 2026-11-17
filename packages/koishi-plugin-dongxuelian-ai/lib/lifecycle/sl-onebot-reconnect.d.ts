import type { WebSocket } from '@satorijs/protocol';
interface SlAdapter {
    accept(socket: WebSocket): void;
}
interface SlBot {
    platform: string;
    selfId: string;
    config: {
        protocol?: string;
    };
    status: number;
    adapter?: SlAdapter;
}
interface SlReconnectContext {
    bots?: SlBot[];
    on(event: 'bot-connect', handler: (bot: SlBot) => void): unknown;
    on(event: 'dispose', handler: () => void): unknown;
    logger(name: string): {
        warn(message: string): void;
    };
}
export declare function installSlOnebotReconnect(ctx: SlReconnectContext): void;
export {};
