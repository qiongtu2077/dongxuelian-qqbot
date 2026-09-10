declare const handled: (response?: unknown) => {
    matched: true;
    response?: unknown;
};
interface LocateLogger {
    warn: (message: string) => void;
    info?: (message: string) => void;
}
interface LocateContext {
    logger: (name: string) => LocateLogger;
}
interface LocateMessage {
    time?: string;
    ts?: number;
    user?: string;
    content?: string;
    userId?: string;
    messageId?: string;
    realSeq?: string;
    groupId?: string;
    botId?: string;
    mentionUserIds?: string[];
}
interface LocateTodayCache {
    date?: string;
    messages?: LocateMessage[];
}
interface LocateInternalLike {
    getMsg?: (messageId: string | number) => Promise<unknown> | unknown;
    sendGroupMsg?: (groupId: string | number, message: unknown) => Promise<unknown> | unknown;
    sendGroupForwardMsg?: (groupId: string | number, messages: unknown) => Promise<unknown> | unknown;
}
interface LocateSessionLike {
    selfId?: string;
    send: (content: unknown) => unknown | Promise<unknown>;
    bot?: {
        selfId?: string;
        internal?: LocateInternalLike;
    };
}
interface LocateCommandInput {
    session: LocateSessionLike;
    ctx: LocateContext;
    channelKey: string;
    currentUserId: string;
    cache: LocateTodayCache;
    index: number;
}
interface LocateForwardNode {
    type: 'node';
    data: {
        name: string;
        uin: string;
        content: string;
    };
}
/** 合并转发卡片节点；目标那条以「→ 」前缀标出，内容保留【图片】等标记，避免纯媒体消息变成空白行。 */
declare function buildLocateContextNodes(cache: LocateTodayCache, cacheIdx: number, botId: string): LocateForwardNode[];
declare function handleLocateCommand(input: LocateCommandInput): Promise<ReturnType<typeof handled>>;
declare const _default: {
    LOCATE_TEXT_PRECHECK_FAILED: string;
    LOCATE_TEXT_SNAPSHOT_MISSING: string;
    LOCATE_TEXT_VERIFY_TIMEOUT: string;
    LOCATE_TEXT_VERIFY_MISSING: string;
    buildLocateContextNodes: typeof buildLocateContextNodes;
    handleLocateCommand: typeof handleLocateCommand;
};
export = _default;
