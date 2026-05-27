interface RunnerPlanTask {
    id?: string;
    desc?: string;
    state?: string;
}
interface RunnerPlan {
    id: string;
    title?: string;
    state?: string;
    channel?: string;
    channelKey?: string;
    userId?: string;
    userName?: string;
    tasks?: RunnerPlanTask[];
}
interface ResolvePlanFilters {
    userId?: string;
    channelKey?: string;
}
interface ResumePlanOptions {
    planId?: string;
    channelKey?: string;
    userId?: string;
    userName?: string;
    channel?: string;
    bot?: unknown;
    isAdmin?: boolean;
}
declare function getActiveTask(plan: RunnerPlan): RunnerPlanTask | null;
declare function resolvePlan(planId?: string, filters?: ResolvePlanFilters): Promise<RunnerPlan | null>;
declare function resumePlan({ planId, channelKey, userId, userName, channel, bot, isAdmin }?: ResumePlanOptions): Promise<unknown>;
declare const _default: {
    resumePlan: typeof resumePlan;
    resolvePlan: typeof resolvePlan;
    getActiveTask: typeof getActiveTask;
};
export = _default;
