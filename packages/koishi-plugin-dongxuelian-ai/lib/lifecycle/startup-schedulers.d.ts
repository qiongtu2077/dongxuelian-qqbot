interface StartupSchedulerContext {
    bots?: Array<{
        selfId?: string;
        userId?: string;
    }>;
    logger(name: string): {
        info?: (message: string) => void;
        warn(message: string): void;
    };
}
declare function getNextShanghaiMidnightDelayMs(now?: number): number;
declare function scheduleDailyStatsCleanup(ctx: StartupSchedulerContext): void;
declare function getExpressionHarvestDelayMs(now?: number): number;
declare function runExpressionHarvestTick(ctx: StartupSchedulerContext): Promise<{
    parked: boolean;
    status: string;
    taskId?: string;
    reason: string;
}>;
declare function scheduleExpressionHarvest(ctx: StartupSchedulerContext): void;
declare function runDailyPrecomputePlanningTick(ctx: StartupSchedulerContext): Promise<{
    parked: boolean;
    planned: number;
    channels: number;
    reason: string;
}>;
declare function scheduleDailyPrecomputePlanning(ctx: StartupSchedulerContext): void;
declare function clearStartupSchedulers(): void;
declare const _default: {
    getNextShanghaiMidnightDelayMs: typeof getNextShanghaiMidnightDelayMs;
    scheduleDailyStatsCleanup: typeof scheduleDailyStatsCleanup;
    getExpressionHarvestDelayMs: typeof getExpressionHarvestDelayMs;
    scheduleExpressionHarvest: typeof scheduleExpressionHarvest;
    runExpressionHarvestTick: typeof runExpressionHarvestTick;
    runDailyPrecomputePlanningTick: typeof runDailyPrecomputePlanningTick;
    scheduleDailyPrecomputePlanning: typeof scheduleDailyPrecomputePlanning;
    clearStartupSchedulers: typeof clearStartupSchedulers;
};
export = _default;
