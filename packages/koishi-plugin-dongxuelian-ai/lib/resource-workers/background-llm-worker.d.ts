interface BackgroundLlmPayloadLike extends Record<string, unknown> {
    channels?: unknown;
    selfUserId?: unknown;
    botName?: unknown;
    key?: unknown;
    channelKey?: unknown;
}
interface BackgroundLlmTaskLike extends Record<string, unknown> {
    id?: string;
    kind?: string;
    channelKey?: string;
    payload?: BackgroundLlmPayloadLike;
}
declare function runConversationSummaryWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>>;
declare function runSensitiveCacheAnalysisWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>>;
declare function runBackgroundLlmWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>>;
declare const _default: {
    runBackgroundLlmWorkerTask: typeof runBackgroundLlmWorkerTask;
    runConversationSummaryWorkerTask: typeof runConversationSummaryWorkerTask;
    runSensitiveCacheAnalysisWorkerTask: typeof runSensitiveCacheAnalysisWorkerTask;
};
export = _default;
