type ResourceTask = import('./task-types').ResourceTask;
interface BackgroundSubmissionResult {
    accepted: boolean;
    task?: ResourceTaskLike;
    admission?: AdmissionDecisionLike;
    taskId?: string;
    status: string;
    message: string;
}
type ResourceTaskLike = Partial<Pick<ResourceTask, 'id' | 'kind' | 'channelKey' | 'userId' | 'payload'>>;
interface AdmissionDecisionLike {
    decision?: string;
    reason?: unknown;
}
interface ConversationSummarySubmissionOptions {
    key: string;
    source?: string;
}
interface SensitiveAnalysisSubmissionOptions {
    channelKey: string;
    source?: string;
}
declare function submitConversationSummaryTask(options: ConversationSummarySubmissionOptions): BackgroundSubmissionResult;
declare function submitSensitiveCacheAnalysisTask(options: SensitiveAnalysisSubmissionOptions): BackgroundSubmissionResult;
declare const _default: {
    submitConversationSummaryTask: typeof submitConversationSummaryTask;
    submitSensitiveCacheAnalysisTask: typeof submitSensitiveCacheAnalysisTask;
};
export = _default;
