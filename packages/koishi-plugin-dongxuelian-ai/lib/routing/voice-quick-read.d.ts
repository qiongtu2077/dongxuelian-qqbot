interface AdmissionDecisionLike {
    decision?: string;
    reason?: string;
    resourceState?: string;
}
declare function isVoiceQuickReadIntent(text?: string): boolean;
declare function formatVoiceQueuedReply(admission: AdmissionDecisionLike): string;
declare function resolveVoiceQuickReadReply(channelKey: string, messageId: string): Promise<string>;
declare const _default: {
    isVoiceQuickReadIntent: typeof isVoiceQuickReadIntent;
    resolveVoiceQuickReadReply: typeof resolveVoiceQuickReadReply;
    formatVoiceQueuedReply: typeof formatVoiceQueuedReply;
};
export = _default;
