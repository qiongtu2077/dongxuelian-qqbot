interface PlanningContext {
    logger(name: string): {
        warn(message: string): void;
    };
}
interface PlanningResult {
    planned: number;
    scanned: number;
    reason: string;
}
declare function runDailyPreanalysisPlanningTick(ctx: PlanningContext, isActive?: () => boolean): Promise<PlanningResult>;
declare const _default: {
    runDailyPreanalysisPlanningTick: typeof runDailyPreanalysisPlanningTick;
};
export = _default;
