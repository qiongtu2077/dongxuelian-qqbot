interface AdmissionDecisionLike {
    decision?: string;
    reason?: string;
    resourceState?: string;
}
type QueuedMediaTaskLike = Record<string, unknown>;
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
declare function formatFileQueuedReply(admission: AdmissionDecisionLike): string;
declare const _default: {
    queueFileAnalysisRequest: typeof queueFileAnalysisRequest;
    formatFileQueuedReply: typeof formatFileQueuedReply;
};
export = _default;
