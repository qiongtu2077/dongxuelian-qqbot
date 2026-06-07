/**
 * MODULE: S1 任务预算定义。
 * 职责: 将业务入口提交的任务需求归一为资源预算。
 * 边界: 不读取系统状态，不做准入决策。
 */
type ResourceTaskKind = 'daily_report' | 'daily_report_render' | 'daily_report_summary' | 'daily_summary' | 'agent_task' | 'dashboard_agent' | 'agent_memory' | 'agent_memory_compaction' | 'expression_harvest' | 'conversation_summary' | 'sensitive_cache_analysis' | 'emotion_render' | 'browser_action' | 'voice_tts_generation' | 'diagnostic_probe' | 'mcp_local_check' | 'external_video_download' | 'pet_bridge_chat' | 'media_image_analysis' | 'media_file_analysis' | 'media_voice_transcription' | 'status_query' | 'normal_chat' | string;
interface TaskBudgetInput {
    taskId?: string;
    kind?: ResourceTaskKind;
    source?: string;
    channelKey?: string;
    userId?: string;
    exclusive?: boolean;
    priority?: number;
    minMemMb?: number;
    criticalMemMb?: number;
    degradable?: boolean;
    deferable?: boolean;
    fallbacks?: string[];
    queueTimeoutMs?: number;
    runTimeoutMs?: number;
}
interface TaskBudget extends TaskBudgetInput {
    taskId: string;
    source: string;
    channelKey: string;
    userId: string;
    exclusive: boolean;
    priority: number;
    minMemMb: number;
    criticalMemMb: number;
    degradable: boolean;
    deferable: boolean;
    fallbacks: string[];
    queueTimeoutMs: number;
    runTimeoutMs: number;
}
declare function normalizeTaskBudget(input: TaskBudgetInput): TaskBudget;
declare const _default: {
    DEFAULT_BUDGETS: Record<string, Partial<TaskBudget>>;
    normalizeTaskBudget: typeof normalizeTaskBudget;
};
export = _default;
