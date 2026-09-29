/** 群精华排行榜：按消息作者统计当前群精华，在一条合并转发中展示全部排名。 */
declare const handled: (response?: unknown) => {
    matched: true;
    response?: unknown;
};
interface EssenceMessage {
    msg_seq: number;
    msg_random: number;
    sender_id: number;
    sender_nick: string;
}
interface EssenceSession {
    isDirect?: boolean;
    guildId?: string;
    selfId?: string;
    bot?: {
        selfId?: string;
        internal?: {
            getEssenceMsgList?: (groupId: string) => Promise<EssenceMessage[]>;
            sendGroupForwardMsg?: (groupId: string, messages: unknown) => unknown | Promise<unknown>;
        };
    };
}
interface EssenceContext {
    logger(name: string): {
        warn(message: string): void;
    };
}
interface EssenceRanking {
    userId: string;
    nickname: string;
    count: number;
}
declare function rankEssenceMessages(messages: EssenceMessage[]): EssenceRanking[];
declare function handleEssenceCommand(session: EssenceSession, ctx: EssenceContext): Promise<ReturnType<typeof handled>>;
declare const _default: {
    handleEssenceCommand: typeof handleEssenceCommand;
    rankEssenceMessages: typeof rankEssenceMessages;
};
export = _default;
