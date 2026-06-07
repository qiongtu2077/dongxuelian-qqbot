interface DailySlotLike extends Record<string, unknown> {
    slotId?: unknown;
    messageCount?: unknown;
    coveredMessageIds?: unknown;
    keywords?: unknown;
    stats?: unknown;
}
declare function readDailySlots(date: string, channelKey: string): DailySlotLike[];
declare function mergeDailyFinalInput(date: string, channelKey: string): Record<string, unknown>;
declare const _default: {
    readDailySlots: typeof readDailySlots;
    mergeDailyFinalInput: typeof mergeDailyFinalInput;
};
export = _default;
