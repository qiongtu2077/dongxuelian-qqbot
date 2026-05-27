interface CreatePlanOptions {
    title?: string;
    tasks?: unknown;
    channel?: string;
    channelKey?: string;
    userId?: string;
    userName?: string;
}
interface UpdateTaskStatusOptions {
    planId?: string;
    taskId?: string;
    state?: string;
    outcome?: unknown;
    toolCallCount?: unknown;
}
interface PlanVisibilityOptions {
    userId?: string;
    channelKey?: string;
    isAdmin?: boolean;
}
interface FinishPlanOptions {
    planId?: string;
    summary?: unknown;
}
interface AbandonPlanOptions {
    planId?: string;
    reason?: unknown;
}
interface FormatPlanTask {
    id?: string;
    desc?: string;
    state?: string;
    outcome?: string | null;
}
interface FormatPlan {
    id?: string;
    title?: string;
    state?: string;
    userId?: string;
    channelKey?: string;
    tasks?: FormatPlanTask[];
    summary?: string;
    active?: FormatPlan[];
    recent?: FormatPlan[];
}
interface PlanStatusList {
    active: FormatPlan[];
    recent: FormatPlan[];
}
type PlanResult = FormatPlan;
type PlanStatusResult = PlanResult | PlanStatusList;
declare function createPlan({ title, tasks, channel, channelKey, userId, userName }?: CreatePlanOptions): Promise<PlanResult>;
declare function updateTaskStatus({ planId, taskId, state, outcome, toolCallCount }?: UpdateTaskStatusOptions): Promise<PlanResult>;
declare function checkPlanStatus(planId?: string, { userId, channelKey, isAdmin }?: PlanVisibilityOptions): Promise<PlanStatusResult>;
declare function finishPlan({ planId, summary }?: FinishPlanOptions): Promise<PlanResult>;
declare function abandonPlan({ planId, reason }?: AbandonPlanOptions): Promise<PlanResult>;
declare function formatPlan(plan: PlanStatusResult | null | undefined): string;
declare const _default: {
    createPlan: typeof createPlan;
    updateTaskStatus: typeof updateTaskStatus;
    checkPlanStatus: typeof checkPlanStatus;
    finishPlan: typeof finishPlan;
    abandonPlan: typeof abandonPlan;
    formatPlan: typeof formatPlan;
};
export = _default;
