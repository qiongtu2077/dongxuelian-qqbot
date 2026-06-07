interface WorkerTaskResult extends Record<string, unknown> {
    mode?: string;
    reason?: string;
}
interface EmotionPayloadLike extends Record<string, unknown> {
    analysis?: unknown;
    stats?: unknown;
    history?: unknown;
    text?: unknown;
}
interface EmotionRenderTaskLike extends Record<string, unknown> {
    id?: unknown;
    payload?: EmotionPayloadLike;
}
declare function runEmotionRenderWorkerTask(task: EmotionRenderTaskLike): Promise<WorkerTaskResult>;
declare const _default: {
    runEmotionRenderWorkerTask: typeof runEmotionRenderWorkerTask;
};
export = _default;
