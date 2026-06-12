interface PlanSlotOptions {
    slotSize?: number;
    maxSlots?: number;
    source?: string;
}
interface SlotPlanningResultLike {
    task?: unknown;
    admission?: unknown;
    accepted?: unknown;
    restored?: unknown;
}
declare function planDailySlotTasks(date: string, channelKey: string, options?: PlanSlotOptions): SlotPlanningResultLike[];
declare const _default: {
    planDailySlotTasks: typeof planDailySlotTasks;
};
export = _default;
