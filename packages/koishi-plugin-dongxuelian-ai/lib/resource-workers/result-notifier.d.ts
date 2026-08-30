type ResourceTask = import('./task-types').ResourceTask;
interface NotifyCompletedOptions {
    limit?: number;
    sender?: ResultNotifierSender;
}
type ResultNotifierResult = Record<string, unknown>;
type ResultNotifierSender = (task: ResourceTask, result: ResultNotifierResult) => Promise<boolean> | boolean;
interface AgentNotifyResultLike {
    reply?: unknown;
    message?: unknown;
    toolResults?: Array<{
        name?: string;
        result?: unknown;
    }>;
}
interface ResultNotifierBotLike {
    sendMessage?: (target: string, content: unknown) => Promise<unknown> | unknown;
    sendPrivateMessage?: (target: string, content: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown;
        sendGroupMsg?: (target: string, segments: unknown[]) => Promise<unknown> | unknown;
    };
}
interface ResultNotifierLoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
interface DailyReportSenderOptions {
    bot?: ResultNotifierBotLike | null;
    logger?: ResultNotifierLoggerLike | null;
}
interface ResourceResultSenderOptions {
    bot?: ResultNotifierBotLike | null;
    logger?: ResultNotifierLoggerLike | null;
    ctx?: unknown;
    chat?: unknown;
    retellAgentResult?: unknown;
}
interface ResultNotifierSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    [key: string]: unknown;
}
declare function readTaskResult(taskId: string): ResultNotifierResult;
declare function hasHardSearchFailureSignal(result: AgentNotifyResultLike): boolean;
declare function isChatHeavyToolTask(task: ResourceTask | null | undefined): boolean;
declare function hasAgentSendableText(result: ResultNotifierResult): boolean;
declare function createDailyReportSender(options?: DailyReportSenderOptions): ResultNotifierSender;
declare function buildAgentTaskTextMessage(result: ResultNotifierResult, task?: ResourceTask | null): string;
declare function extractSessionFromPayload(task: ResourceTask): {
    session: ResultNotifierSessionLike;
    channelKey: string;
    userId: string;
    userName: string;
    userText: string;
};
declare function createAgentTaskSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function createEmotionRenderSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function createResourceResultSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function notifyCompletedTasks(options?: NotifyCompletedOptions): Promise<Record<string, unknown>>;
declare const _default: {
    readTaskResult: typeof readTaskResult;
    hasHardSearchFailureSignal: typeof hasHardSearchFailureSignal;
    isChatHeavyToolTask: typeof isChatHeavyToolTask;
    hasAgentSendableText: typeof hasAgentSendableText;
    buildAgentTaskTextMessage: typeof buildAgentTaskTextMessage;
    extractSessionFromPayload: typeof extractSessionFromPayload;
    createDailyReportSender: typeof createDailyReportSender;
    createAgentTaskSender: typeof createAgentTaskSender;
    createEmotionRenderSender: typeof createEmotionRenderSender;
    createResourceResultSender: typeof createResourceResultSender;
    notifyCompletedTasks: typeof notifyCompletedTasks;
};
export = _default;
