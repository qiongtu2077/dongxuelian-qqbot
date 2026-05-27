/**
 * MODULE: Agent 计划提示词模板。
 * 职责: 提供计划模式的 system prompt 与任务拆解约束。
 * 边界: 不调用模型、不解析模型输出、不写计划文件。
 * 状态: 无。
 */
interface PromptPlanTask {
    id?: string;
    state?: string;
    desc?: string;
}
interface PromptPlan {
    id?: string;
    title?: string;
    tasks?: PromptPlanTask[];
}
declare function buildPlanSystemPrompt(plan?: PromptPlan | null): string;
declare function buildPlanCreatePrompt(userMessage?: unknown): string;
declare const _default: {
    buildPlanSystemPrompt: typeof buildPlanSystemPrompt;
    buildPlanCreatePrompt: typeof buildPlanCreatePrompt;
};
export = _default;
