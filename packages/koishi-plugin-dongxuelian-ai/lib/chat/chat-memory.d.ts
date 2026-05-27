interface MemorySessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface DirectMemoryWriteOptions {
    cleanInput: string;
    currentUserId?: string;
    channelKey: string;
    inGuild?: boolean;
}
interface MemoryConfirmationOptions extends DirectMemoryWriteOptions {
    session: MemorySessionLike;
}
declare function trimChatMemoryRuntime(now?: number): void;
declare function clearGroupMemoryIfExpired(session: MemorySessionLike, channelKey: string): Promise<boolean>;
declare function handleDirectMemoryWrite({ cleanInput, currentUserId, channelKey, inGuild }: DirectMemoryWriteOptions): Promise<string | null>;
declare function handleMemoryConfirmation({ session, cleanInput, currentUserId, channelKey, inGuild }: MemoryConfirmationOptions): Promise<void>;
declare function rememberMemoryPrompt(currentUserId: string, channelKey: string, reply: string): void;
declare const _default: {
    trimChatMemoryRuntime: typeof trimChatMemoryRuntime;
    clearGroupMemoryIfExpired: typeof clearGroupMemoryIfExpired;
    handleDirectMemoryWrite: typeof handleDirectMemoryWrite;
    handleMemoryConfirmation: typeof handleMemoryConfirmation;
    rememberMemoryPrompt: typeof rememberMemoryPrompt;
};
export = _default;
