interface BackgroundSubmissionResult {
    accepted: boolean;
    task?: ResourceTaskLike;
    admission?: AdmissionDecisionLike;
    taskId?: string;
    status: string;
    message: string;
}
interface ResourceTaskLike extends Record<string, unknown> {
    id?: string;
    kind?: string;
    channelKey?: string;
    userId?: string;
    payload?: Record<string, unknown>;
}
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
