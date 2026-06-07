interface PrecomputeRecordLike extends Record<string, unknown> {
    messageId?: string;
    userId?: string;
    text?: string;
    media?: unknown;
}
interface DailySlotTaskLike {
    id?: string;
    channelKey?: string;
    payload?: {
        date?: unknown;
        channelKey?: unknown;
        slotId?: unknown;
        messageIds?: unknown;
    };
}
declare function extractSimpleKeywords(records: PrecomputeRecordLike[], limit?: number): string[];
declare function runDailySlotTask(task: DailySlotTaskLike): Record<string, unknown>;
declare const _default: {
    runDailySlotTask: typeof runDailySlotTask;
    extractSimpleKeywords: typeof extractSimpleKeywords;
};
export = _default;
