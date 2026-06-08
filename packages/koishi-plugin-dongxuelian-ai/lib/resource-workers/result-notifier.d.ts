interface NotifyCompletedOptions {
    limit?: number;
    sender?: ResultNotifierSender;
}
interface ResultNotifyInfo extends Record<string, unknown> {
    target?: string;
    channelKey?: string;
    status?: string;
    error?: string;
}
interface ResultNotifierTaskLike extends Record<string, unknown> {
    id?: string;
    kind?: string;
    status?: string;
    channelKey?: string;
    payload?: Record<string, unknown>;
    notify?: ResultNotifyInfo;
}
type ResultNotifierResult = Record<string, unknown>;
type ResultNotifierSender = (task: ResultNotifierTaskLike, result: ResultNotifierResult) => Promise<boolean> | boolean;
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
    internal?: {
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
}
declare function readTaskResult(taskId: string): ResultNotifierResult;
declare function hasHardSearchFailureSignal(result: AgentNotifyResultLike): boolean;
declare function createDailyReportSender(options?: DailyReportSenderOptions): ResultNotifierSender;
declare function buildAgentTaskTextMessage(result: ResultNotifierResult, task?: ResultNotifierTaskLike | null): string;
declare function createAgentTaskSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function createEmotionRenderSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function createResourceResultSender(options?: ResourceResultSenderOptions): ResultNotifierSender;
declare function notifyCompletedTasks(options?: NotifyCompletedOptions): Promise<Record<string, unknown>>;
declare const _default: {
    readTaskResult: typeof readTaskResult;
    hasHardSearchFailureSignal: typeof hasHardSearchFailureSignal;
    buildAgentTaskTextMessage: typeof buildAgentTaskTextMessage;
    createDailyReportSender: typeof createDailyReportSender;
    createAgentTaskSender: typeof createAgentTaskSender;
    createEmotionRenderSender: typeof createEmotionRenderSender;
    createResourceResultSender: typeof createResourceResultSender;
    notifyCompletedTasks: typeof notifyCompletedTasks;
};
export = _default;
