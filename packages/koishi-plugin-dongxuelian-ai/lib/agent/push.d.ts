interface PushQuota {
    key: string;
    used: number;
    limit: number;
    remaining: number;
}
interface PushResult {
    ok: boolean;
    message?: string;
    quota?: PushQuota;
    personalized?: boolean;
}
interface SendOptions {
    channelKey?: unknown;
    text?: unknown;
    bot?: BotLike | null;
    personalize?: boolean;
    reason?: unknown;
    bypassEnabled?: boolean;
}
interface SendToAdminOptions {
    text?: unknown;
    bot?: BotLike | null;
    reason?: unknown;
}
interface TaskCompleteOptions {
    planId?: unknown;
    channelKey?: unknown;
    summary?: unknown;
    bot?: BotLike | null;
}
interface CronResultOptions {
    cronId?: unknown;
    channelKey?: unknown;
    text?: unknown;
    bot?: BotLike | null;
    bypassEnabled?: boolean;
}
interface BotLike {
    sendPrivateMessage?: (userId: string, content: string) => Promise<unknown> | unknown;
    sendMessage?: (target: string, content: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (userId: string, segments: unknown[]) => Promise<unknown> | unknown;
        sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown;
    };
}
declare function getQuota(channelKey: unknown, now?: number): Promise<PushQuota>;
declare function sendBotMessage(bot: BotLike | null | undefined, target: unknown, content: string): Promise<unknown>;
declare function send({ channelKey, text, bot, personalize, reason, bypassEnabled }?: SendOptions): Promise<PushResult>;
declare function sendToAdmin({ text, bot, reason }?: SendToAdminOptions): Promise<unknown[]>;
declare function taskComplete({ planId, channelKey, summary, bot }?: TaskCompleteOptions): Promise<PushResult>;
declare function cronResult({ cronId, channelKey, text, bot, bypassEnabled }?: CronResultOptions): Promise<PushResult>;
declare function listPushLog(limit?: unknown): unknown[];
declare const _default: {
    PUSH_LOG_FILE: string;
    sendBotMessage: typeof sendBotMessage;
    send: typeof send;
    sendToAdmin: typeof sendToAdmin;
    taskComplete: typeof taskComplete;
    cronResult: typeof cronResult;
    getQuota: typeof getQuota;
    listPushLog: typeof listPushLog;
};
export = _default;
