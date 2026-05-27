interface BotResolverBot {
    selfId?: string;
    sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (id: string, message: string) => Promise<unknown> | unknown;
    };
}
declare function resolveCurrentBot(ctx: object | null | undefined, fallbackBot?: object | null, selfId?: string): BotResolverBot | null;
declare function createBotResolver(ctx: object | null | undefined, session?: object | null | undefined): () => BotResolverBot | null;
declare function withCurrentBot<T extends object | null | undefined>(session: T, bot: object | null | undefined): T;
declare const _default: {
    resolveCurrentBot: typeof resolveCurrentBot;
    createBotResolver: typeof createBotResolver;
    withCurrentBot: typeof withCurrentBot;
};
export = _default;
