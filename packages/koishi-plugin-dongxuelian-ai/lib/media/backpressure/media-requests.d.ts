interface AdmissionDecisionLike {
    decision?: string;
    reason?: string;
    resourceState?: string;
    botMode?: string;
}
type QueuedMediaTaskLike = Record<string, unknown> | null;
interface QueueFileAnalysisInput {
    channelKey: string;
    messageId: string;
    url?: string;
    fileId?: string | null;
    fileName?: string;
    fileSize?: number;
    ext?: string;
    userId?: string;
    source?: string;
}
declare function queueFileAnalysisRequest(input: QueueFileAnalysisInput): {
    admission: AdmissionDecisionLike;
    queued: QueuedMediaTaskLike;
};
declare function shouldEnqueueMediaForAdmission(admission: AdmissionDecisionLike | null | undefined): boolean;
declare function formatFileQueuedReply(admission: AdmissionDecisionLike): string;
declare const _default: {
    queueFileAnalysisRequest: typeof queueFileAnalysisRequest;
    formatFileQueuedReply: typeof formatFileQueuedReply;
    shouldEnqueueMediaForAdmission: typeof shouldEnqueueMediaForAdmission;
};
export = _default;
