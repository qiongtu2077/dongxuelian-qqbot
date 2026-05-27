type PlanTaskState = 'todo' | 'in_progress' | 'done' | 'abandoned' | 'failed';
type PlanState = 'todo' | 'executing' | 'done' | 'abandoned' | 'failed';
interface PlanTask {
    id: string;
    desc: string;
    state: PlanTaskState;
    outcome: string | null;
    toolCallCount: number;
    updatedAt: number;
}
interface Plan {
    id: string;
    title: string;
    state: PlanState;
    channel: string;
    channelKey: string;
    userId: string;
    userName: string;
    tasks: PlanTask[];
    summary: string;
    createdAt: number;
    updatedAt: number;
}
declare function safePlanId(id?: unknown): string;
declare function buildPlanId(now?: number): string;
declare function normalizePlan(plan?: unknown): Plan;
declare function savePlan(plan: unknown): Promise<Plan>;
declare function loadPlan(id: unknown): Promise<Plan | null>;
declare function listPlans(limit?: unknown): Promise<Plan[]>;
declare function listActivePlans(): Promise<Plan[]>;
declare function getPlanStorageInfo(): {
    dir: string;
    activeFile: string;
    exists: boolean;
};
declare const _default: {
    PLAN_DIR: string;
    ACTIVE_FILE: string;
    buildPlanId: typeof buildPlanId;
    safePlanId: typeof safePlanId;
    normalizePlan: typeof normalizePlan;
    savePlan: typeof savePlan;
    loadPlan: typeof loadPlan;
    listPlans: typeof listPlans;
    listActivePlans: typeof listActivePlans;
    getPlanStorageInfo: typeof getPlanStorageInfo;
};
export = _default;
